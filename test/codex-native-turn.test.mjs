import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { spawnCodexNativeTurn } from "../server/codex-native-turn.mjs";

test("new workspace-write tasks use a native interactive Codex thread", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-native-codex-"));
  const workspace = path.join(directory, "workspace");
  const capturePath = path.join(directory, "capture.json");
  const executable = path.join(directory, "fake-codex.mjs");
  await mkdir(workspace);
  await writeFile(executable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const messages=[]; let buffer="";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { buffer += chunk; let newline;
  while ((newline=buffer.indexOf("\\n"))>=0) {
    const line=buffer.slice(0,newline); buffer=buffer.slice(newline+1);
    if (!line.trim()) continue;
    const message=JSON.parse(line); messages.push(message);
    if (message.id===1) process.stdout.write(JSON.stringify({id:1,result:{}})+"\\n");
    if (message.id===2) process.stdout.write(JSON.stringify({id:2,result:{thread:{id:"native-thread-1",source:"vscode"}}})+"\\n");
    if (message.id===3) {
      process.stdout.write(JSON.stringify({id:3,result:{turn:{id:"turn-1",status:"inProgress"}}})+"\\n");
      process.stdout.write(JSON.stringify({method:"turn/started",params:{threadId:"native-thread-1",turn:{id:"turn-1"}}})+"\\n");
      process.stdout.write(JSON.stringify({method:"item/completed",params:{threadId:"native-thread-1",turnId:"turn-1",item:{id:"answer-1",type:"agentMessage",text:"native answer"}}})+"\\n");
      process.stdout.write(JSON.stringify({method:"turn/completed",params:{threadId:"native-thread-1",turn:{id:"turn-1",status:"completed"}}})+"\\n");
    }
  }
});
process.stdin.on("end", () => { writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(messages)); });
`);
  await chmod(executable, 0o755);
  const events = [];
  try {
    const run = spawnCodexNativeTurn({
      executable,
      thread: {
        model: "gpt-test",
        reasoningEffort: "high",
        sandbox: "workspace-write",
        title: "原生同步测试任务",
        origin: { workspacePath: workspace },
      },
      addDirectories: [],
      prompt: "任务原文",
      cwd: workspace,
      env: { ...process.env, CAPTURE_PATH: capturePath },
      onRawEvent: (event) => events.push(event),
    });
    await run.started;
    assert.deepEqual(await run.completion, { exitCode: 0, signal: null });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(events.map((event) => event.type), [
      "thread.started",
      "turn.started",
      "item.completed",
      "turn.completed",
    ]);
    assert.equal(events[0].thread_id, "native-thread-1");
    assert.equal(events[2].item.type, "agent_message");
    assert.equal(events[2].item.text, "native answer");

    const messages = JSON.parse(await readFile(capturePath, "utf8"));
    const threadStart = messages.find((message) => message.method === "thread/start");
    const turnStart = messages.find((message) => message.method === "turn/start");
    const nameSet = messages.find((message) => message.method === "thread/name/set");
    assert.equal(threadStart.params.sandbox, "workspace-write");
    assert.equal(threadStart.params.approvalPolicy, "on-request");
    assert.equal(threadStart.params.approvalsReviewer, "auto_review");
    assert.equal(JSON.stringify(threadStart).includes("danger-full-access"), false);
    assert.equal(turnStart.params.input[0].text, "任务原文");
    assert.equal(nameSet.params.name, "原生同步测试任务");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
