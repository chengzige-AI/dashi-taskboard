import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AiChatService } from "../server/ai-chat.mjs";
import { TaskboardDatabase } from "../server/database.mjs";

async function waitFor(predicate, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Claude fixture");
}

test("Claude Code uses the project workspace, JSONL sessions and the normal permission system", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-claude-runner-"));
  const workspaceDirectory = path.join(directory, "workspace");
  await mkdir(workspaceDirectory);
  const workspace = await realpath(workspaceDirectory);
  const capturePath = path.join(directory, "capture.jsonl");
  const executable = path.join(directory, "fake-claude.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") process.exit(0);
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { prompt += chunk; });
process.stdin.on("end", () => {
  appendFileSync(process.env.FAKE_CAPTURE_PATH, JSON.stringify({ args, cwd: process.cwd(), prompt }) + "\\n");
  const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
  emit({ type: "system", subtype: "init", session_id: "claude-session-1" });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "Claude result" }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: "Claude result", session_id: "claude-session-1" });
});
`);
  await chmod(executable, 0o755);

  const statePath = path.join(directory, "codex-state.json");
  await writeFile(statePath, JSON.stringify({
    "local-projects": { project: { rootPaths: [workspace] } },
  }));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  database.createProject({ id: "project", name: "Project", workspacePath: workspace });
  const service = new AiChatService({
    database,
    agentHost: "claude-code",
    claudeExecutable: executable,
    codexStatePath: statePath,
    manageTaskboardSkillPath: "/fixture/manage-taskboard/SKILL.md",
    processEnv: { ...process.env, FAKE_CAPTURE_PATH: capturePath },
  });

  try {
    const thread = await service.createThread({
      projectId: "project",
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandbox: "workspace-write",
    });
    assert.equal(thread.agentHost, "claude-code");

    const first = await service.startTurn(thread.id, { message: "implement the task" });
    await waitFor(() => service.getRun(first.id).status !== "running");
    const second = await service.startTurn(thread.id, { message: "continue" });
    await waitFor(() => service.getRun(second.id).status !== "running");

    assert.equal(service.getRun(first.id).status, "completed");
    assert.equal(service.getRun(second.id).status, "completed");
    assert.equal(service.getThread(thread.id).codexThreadId, "claude-session-1");
    assert.equal(
      service.getThreadSnapshot(thread.id).events.some((event) => event.content === "Claude result"),
      true,
    );

    const captures = (await readFile(capturePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(captures[0].cwd, workspace);
    assert.equal(captures[0].args.includes("--permission-mode"), true);
    assert.equal(captures[0].args.includes("acceptEdits"), true);
    assert.equal(captures[0].args.some((value) => value.includes("dangerously")), false);
    assert.equal(captures[0].args.includes("--resume"), false);
    assert.deepEqual(captures[1].args.slice(-2), ["--resume", "claude-session-1"]);
    assert.match(captures[0].prompt, /implement the task/);
    assert.match(captures[0].prompt, /manage-taskboard\/SKILL\.md/);
  } finally {
    await service.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
