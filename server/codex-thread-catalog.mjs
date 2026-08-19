import path from "node:path";

import { normalizeCodexCommandError, spawnCodexCommand } from "./codex-command.mjs";

const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_LIMIT = 8 * 1024 * 1024;
const THREAD_PAGE_LIMIT = 100;
const MAX_THREAD_PAGES = 100;

export function callAppServer({ codexExecutable, cwd, processEnv, method, params }) {
  return new Promise((resolve, reject) => {
    const child = spawnCodexCommand(codexExecutable, ["app-server", "--stdio"], {
      cwd,
      env: processEnv,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`Codex ${method} timed out`)), REQUEST_TIMEOUT_MS);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const complete = () => error
        ? reject(normalizeCodexCommandError(error))
        : resolve(value);
      if (child.exitCode !== null) complete();
      else {
        child.once("close", complete);
        child.stdin.end();
        child.kill("SIGTERM");
      }
    }

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function handleMessage(message) {
      if (message?.id === 1) {
        if (message.error) return finish(new Error("Codex app-server rejected initialization"));
        send({ method: "initialized" });
        send({ id: 2, method, params });
        return;
      }
      if (message?.id !== 2) return;
      if (message.error) {
        return finish(new Error(message.error?.message || `Codex ${method} failed`));
      }
      finish(null, message.result);
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > RESPONSE_LIMIT) return finish(new Error("Codex thread list is too large"));
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0 && !settled) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try { handleMessage(JSON.parse(line)); } catch {}
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    child.stdin.on("error", (error) => finish(error));
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) finish(new Error(`Codex app-server exited early (${signal || code})`));
    });
    child.once("spawn", () => send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codex-taskboard", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
    }));
  });
}

function looksCorruptedTitle(value) {
  const compact = String(value ?? "").replace(/\s+/g, "");
  if (compact.length < 8) return false;
  const questionMarks = compact.match(/\?/g)?.length ?? 0;
  return questionMarks / compact.length >= 0.5;
}

function isTaskboardAutomationTitle(value) {
  return /^自动执行(?:\s*·|会话|$)/u.test(String(value ?? "").trim());
}

function cleanThread(thread) {
  if (!thread || typeof thread.id !== "string" || !thread.id.trim()) return null;
  const interactiveSource = thread.source === "cli"
    || thread.source === "vscode"
    || ["atlas", "chatgpt"].includes(thread.source?.custom);
  if (!interactiveSource) return null;
  const sourceMetadata = JSON.stringify({
    source: thread.source,
    sourceKind: thread.sourceKind,
    threadSource: thread.threadSource,
  }).toLowerCase();
  if (sourceMetadata.includes("subagent") || thread.parentThreadId) return null;
  const rawName = typeof thread.name === "string" ? thread.name.trim() : "";
  const rawPreview = typeof thread.preview === "string" ? thread.preview.trim() : "";
  const source = rawName || rawPreview;
  if (looksCorruptedTitle(source)) return null;
  const isAutomation = /<taskboard_context>|manage-taskboard|Taskboard 服务端自动认领任务/i.test(source)
    || isTaskboardAutomationTitle(source);
  const issueIdentifier = source.match(/issue_identifier:\s*([^\r\n<]+)/i)?.[1]?.trim();
  const name = isAutomation
    ? `自动执行${issueIdentifier ? ` · ${issueIdentifier}` : "会话"}`
    : (source.replace(/\s+/g, " ").slice(0, 120) || "未命名会话");
  return {
    id: thread.id.trim(),
    name,
    preview: isAutomation ? "" : rawPreview.replace(/\s+/g, " ").slice(0, 240),
    cwd: typeof thread.cwd === "string" ? thread.cwd : null,
    createdAt: Number.isFinite(thread.createdAt) ? thread.createdAt : null,
    updatedAt: Number.isFinite(thread.updatedAt) ? thread.updatedAt : null,
    status: typeof thread.status?.type === "string" ? thread.status.type : "unknown",
    ...(isAutomation ? { taskboardAutomation: true } : {}),
  };
}

function sameWorkspace(left, right) {
  const normalizedLeft = path.resolve(left).toLowerCase();
  const normalizedRight = path.resolve(right).toLowerCase();
  return normalizedLeft === normalizedRight
    || normalizedLeft.startsWith(`${normalizedRight}${path.sep}`);
}

export async function listCodexThreads({ codexExecutable, cwd, processEnv }) {
  const threads = new Map();
  let cursor = null;
  for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
    const result = await callAppServer({
      codexExecutable,
      cwd,
      processEnv,
      method: "thread/list",
      params: {
        limit: THREAD_PAGE_LIMIT,
        sortKey: "updated_at",
        sortDirection: "desc",
        archived: false,
        ...(cursor ? { cursor } : {}),
      },
    });
    for (const raw of Array.isArray(result?.data) ? result.data : []) {
      const thread = cleanThread(raw);
      if (
        thread
        && typeof thread.cwd === "string"
        && (!cwd || sameWorkspace(thread.cwd, cwd))
      ) threads.set(thread.id, thread);
    }
    const nextCursor = typeof result?.nextCursor === "string" && result.nextCursor
      ? result.nextCursor
      : null;
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  return [...threads.values()].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

export async function listCodexThreadResources({
  codexExecutable,
  codexHome,
  cwd,
  processEnv,
  projectWorkspaces,
}) {
  const threads = await listCodexThreads({
    codexExecutable,
    codexHome,
    cwd,
    processEnv,
  });
  const projects = Object.entries(projectWorkspaces ?? {})
    .filter(([, workspacePath]) => typeof workspacePath === "string" && workspacePath.trim())
    .map(([id, workspacePath]) => ({ id, workspacePath }))
    .sort((left, right) => right.workspacePath.length - left.workspacePath.length);
  const projectThreads = Object.fromEntries(projects.map((project) => [project.id, []]));
  const unassignedThreads = [];

  for (const thread of threads) {
    if (thread.taskboardAutomation) continue;
    const project = typeof thread.cwd === "string"
      ? projects.find((candidate) => sameWorkspace(thread.cwd, candidate.workspacePath))
      : null;
    if (project) projectThreads[project.id].push(thread);
    else unassignedThreads.push(thread);
  }

  projects.sort((left, right) => left.id.localeCompare(right.id));
  return { projects, projectThreads, unassignedThreads };
}
