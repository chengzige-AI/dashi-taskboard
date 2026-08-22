import { normalizeCodexCommandError, spawnCodexCommand } from "./codex-command.mjs";

const STDERR_LIMIT = 65_536;

function toExecItem(item) {
  if (!item || typeof item !== "object") return null;
  if (item.type === "agentMessage") {
    return { id: item.id, type: "agent_message", text: item.text };
  }
  if (item.type === "commandExecution") {
    return {
      id: item.id,
      type: "command_execution",
      command: item.command,
      status: item.status,
      aggregated_output: item.aggregatedOutput,
      exit_code: item.exitCode,
    };
  }
  if (item.type === "fileChange") {
    return {
      id: item.id,
      type: "file_change",
      status: item.status,
      changes: Array.isArray(item.changes)
        ? item.changes.map((change) => ({ path: change?.path, kind: change?.kind }))
        : [],
    };
  }
  if (item.type === "mcpToolCall") {
    return {
      id: item.id,
      type: "mcp_tool_call",
      server: item.server,
      tool: item.tool,
      status: item.status,
      arguments: item.arguments,
      result: item.result,
      error: item.error,
    };
  }
  if (item.type === "webSearch") {
    return { id: item.id, type: "web_search", query: item.query };
  }
  if (item.type === "plan") {
    return {
      id: item.id,
      type: "todo_list",
      items: String(item.text ?? "")
        .split(/\r?\n/)
        .map((text) => ({ text: text.replace(/^\s*[-*]\s*/, "").trim() }))
        .filter((entry) => entry.text),
    };
  }
  return null;
}

export function spawnCodexNativeTurn({
  executable,
  thread,
  addDirectories,
  imagePaths = [],
  prompt,
  cwd,
  env,
  onRawEvent,
  maxLineBytes = 1_048_576,
}) {
  if (thread.sandbox !== "workspace-write") {
    throw new Error("Native Codex task creation only supports workspace-write mode");
  }
  const child = spawnCodexCommand(executable, ["app-server", "--stdio"], {
    cwd,
    detached: true,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdoutBuffer = Buffer.alloc(0);
  let stderrBuffer = Buffer.alloc(0);
  let settled = false;
  let turnAccepted = false;
  let threadId = null;
  let resolveCompletion;
  let rejectCompletion;
  let resolveStarted;
  let rejectStarted;

  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const started = new Promise((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });

  function stopProcess() {
    try { child.stdin.end(); } catch {}
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
    }, 250);
    timer.unref();
  }

  function fail(error) {
    if (settled) return;
    settled = true;
    const diagnostic = normalizeCodexCommandError(
      error instanceof Error ? error : new Error(String(error)),
    );
    if (!turnAccepted) rejectStarted(diagnostic);
    rejectCompletion(diagnostic);
    stopProcess();
  }

  function finishTurn() {
    if (settled) return;
    settled = true;
    resolveCompletion({ exitCode: 0, signal: null });
    stopProcess();
  }

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function handleMessage(message) {
    if (message?.id === 1) {
      if (message.error) return fail(new Error(message.error.message || "Codex app-server rejected initialization"));
      send({ method: "initialized" });
      send({
        id: 2,
        method: "thread/start",
        params: {
          cwd: thread.origin.workspacePath,
          model: thread.model,
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          runtimeWorkspaceRoots: [thread.origin.workspacePath, ...addDirectories],
          ephemeral: false,
          serviceName: "codex-kanban",
          threadSource: "codex-kanban",
        },
      });
      return;
    }
    if (message?.id === 2) {
      if (message.error) return fail(new Error(message.error.message || "Codex could not create a native task"));
      const created = message.result?.thread;
      if (typeof created?.id !== "string" || !created.id) {
        return fail(new Error("Codex did not provide a native task id"));
      }
      if (created.source !== "vscode" && created.source !== "cli") {
        return fail(new Error(`Codex created a non-interactive task source '${String(created.source)}'`));
      }
      threadId = created.id;
      onRawEvent({ type: "thread.started", thread_id: threadId });
      send({
        id: 4,
        method: "thread/name/set",
        params: { threadId, name: thread.title },
      });
      send({
        id: 3,
        method: "turn/start",
        params: {
          threadId,
          input: [
            { type: "text", text: prompt, text_elements: [] },
            ...imagePaths.map((imagePath) => ({ type: "localImage", path: imagePath })),
          ],
          model: thread.model,
          effort: thread.reasoningEffort,
          cwd: thread.origin.workspacePath,
        },
      });
      return;
    }
    if (message?.id === 3) {
      if (message.error) return fail(new Error(message.error.message || "Codex could not start the native task"));
      turnAccepted = true;
      resolveStarted();
      return;
    }
    if (message?.method === "turn/started" && message.params?.threadId === threadId) {
      onRawEvent({ type: "turn.started" });
      return;
    }
    if (
      (message?.method === "item/started" || message?.method === "item/completed")
      && message.params?.threadId === threadId
    ) {
      const item = toExecItem(message.params.item);
      if (item) {
        onRawEvent({
          type: message.method === "item/started" ? "item.started" : "item.completed",
          item,
        });
      }
      return;
    }
    if (message?.method === "turn/completed" && message.params?.threadId === threadId) {
      const turn = message.params.turn;
      if (turn?.status === "completed") onRawEvent({ type: "turn.completed" });
      else onRawEvent({ type: "turn.failed", error: turn?.error ?? { message: `Turn ${turn?.status ?? "failed"}` } });
      finishTurn();
      return;
    }
    if (message?.method === "error" && message.params?.threadId === threadId) {
      onRawEvent({ type: "error", message: message.params?.error?.message ?? message.params?.message });
      finishTurn();
    }
  }

  function consumeLine(line) {
    if (settled) return;
    if (line.length > maxLineBytes) return fail(new Error(`Codex JSONL line exceeded ${maxLineBytes} bytes`));
    if (line.at(-1) === 13) line = line.subarray(0, -1);
    if (line.toString("utf8").trim() === "") return;
    try {
      handleMessage(JSON.parse(line.toString("utf8")));
    } catch (error) {
      fail(error instanceof SyntaxError ? new Error("Codex emitted malformed JSONL") : error);
    }
  }

  child.stdout.on("data", (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (stdoutBuffer.length > maxLineBytes) return fail(new Error(`Codex JSONL line exceeded ${maxLineBytes} bytes`));
    let newline = stdoutBuffer.indexOf(10);
    while (newline >= 0 && !settled) {
      const line = stdoutBuffer.subarray(0, newline);
      stdoutBuffer = stdoutBuffer.subarray(newline + 1);
      consumeLine(line);
      newline = stdoutBuffer.indexOf(10);
    }
  });
  child.stderr.on("data", (chunk) => {
    if (stderrBuffer.length >= STDERR_LIMIT) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stderrBuffer = Buffer.concat([stderrBuffer, bytes.subarray(0, STDERR_LIMIT - stderrBuffer.length)]);
  });
  child.once("error", fail);
  child.once("close", (exitCode, signal) => {
    if (settled) return;
    const detail = stderrBuffer.toString("utf8").trim();
    if (!turnAccepted) {
      fail(new Error(detail || `Codex app-server exited before starting the task (${signal || exitCode})`));
      return;
    }
    settled = true;
    resolveCompletion({ exitCode, signal });
  });
  child.once("spawn", () => send({
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "codex-kanban", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    },
  }));
  child.stdin.on("error", (error) => {
    if (!settled) fail(error);
  });

  return { child, started, completion };
}
