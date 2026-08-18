import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ProjectAutomationScheduler,
  projectAutomationResponse,
} from "../server/automation-scheduler.mjs";
import { TaskboardDatabase } from "../server/database.mjs";

test("server automation atomically claims one unblocked todo and completes it after a successful run", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-automation-server-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const actor = { type: "user", id: "local-user", name: "Local", avatarUrl: null };
  const taskInput = {
    projectId: "project",
    description: "",
    labels: [],
    actor,
    assignee: actor,
    workflowId: null,
    developmentContext: null,
    dueDate: null,
    recurrence: null,
  };

  try {
    database.createProject({ id: "project", name: "Project", workspacePath: directory });
    const blocker = database.createTask({
      ...taskInput,
      title: "Blocker",
      status: "in_progress",
      priority: "high",
    });
    const blocked = database.createTask({
      ...taskInput,
      title: "Urgent but blocked",
      status: "todo",
      priority: "urgent",
    });
    const runnable = database.createTask({
      ...taskInput,
      title: "Runnable",
      status: "todo",
      priority: "low",
    });
    database.addTaskRelation(blocked.id, blocked.version, "blocked_by", blocker.id);
    database.upsertProjectAutomation("project", {
      enabledByUser: true,
      quotaAware: false,
      intervalSeconds: 5,
      model: "gpt-5.5",
      reasoningEffort: "high",
    });
    const contract = projectAutomationResponse(database.getProjectAutomation("project"));
    assert.equal(contract.ok, true);
    assert.equal(contract.item.id, "server:project");
    assert.equal(contract.item.rrule, "RRULE:FREQ=SECONDLY;INTERVAL=5");

    const emitted = [];
    const aiChat = {
      async createThread(input) {
        return database.createAiChatThread({
          title: input.title,
          origin: {
            projectId: "project",
            projectName: "Project",
            workspacePath: directory,
            issueId: input.issueId,
            issueIdentifier: database.getTask(input.issueId).identifier,
          },
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          sandbox: input.sandbox,
        });
      },
      async startTurn(threadId) {
        database.updateAiChatThread(threadId, { codexThreadId: "codex-new-thread-1" });
        return database.createAiChatRun({ threadId });
      },
      async deleteThread(threadId) {
        database.deleteAiChatThread(threadId);
      },
    };
    const scheduler = new ProjectAutomationScheduler({
      database,
      aiChat,
      events: { emit: (type, payload) => emitted.push({ type, payload }) },
    });

    await scheduler.tick();
    const claimedPolicy = database.getProjectAutomation("project");
    assert.equal(claimedPolicy.activeTaskId, runnable.id);
    assert.ok(claimedPolicy.activeRunId);
    assert.equal(database.getTask(runnable.id).status, "in_progress");
    assert.equal(database.getTask(blocked.id).status, "todo");

    await scheduler.tick();
    assert.equal(database.getProjectAutomation("project").activeTaskId, runnable.id);
    assert.equal(database.getTask(runnable.id).codexThreadId, "codex-new-thread-1");

    const claimed = database.getTask(runnable.id);
    database.moveTask(claimed.id, claimed.version, "in_review");
    database.updateAiChatRun(claimedPolicy.activeRunId, {
      status: "completed",
      exitCode: 0,
      finishedAt: new Date().toISOString(),
    });
    await scheduler.tick();

    const completedPolicy = database.getProjectAutomation("project");
    assert.equal(completedPolicy.activeTaskId, null);
    assert.equal(completedPolicy.activeRunId, null);
    assert.equal(completedPolicy.lastError, null);
    assert.equal(database.getTask(runnable.id).status, "done");
    assert.ok(emitted.some((event) => event.type === "task.moved"));

    const droppedIntoTodo = database.createTask({
      ...taskInput,
      title: "Dropped into todo",
      status: "todo",
      priority: "medium",
    });
    assert.ok(Date.parse(database.getProjectAutomation("project").nextRunAt) > Date.now());
    assert.equal(database.wakeProjectAutomation("project"), true);
    await scheduler.tick();
    assert.equal(database.getProjectAutomation("project").activeTaskId, droppedIntoTodo.id);
    assert.equal(database.getTask(droppedIntoTodo.id).status, "in_progress");
    scheduler.close();
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("five-second automation claims without a manual wake and never shows a failed launch as running", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-automation-five-seconds-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const actor = { type: "user", id: "local-user", name: "Local", avatarUrl: null };
  const taskInput = {
    projectId: "project",
    description: "",
    labels: [],
    actor,
    assignee: actor,
    workflowId: null,
    developmentContext: null,
    dueDate: null,
    recurrence: null,
  };
  try {
    database.createProject({ id: "project", name: "Project", workspacePath: directory });
    database.upsertProjectAutomation("project", {
      enabledByUser: true,
      quotaAware: false,
      intervalSeconds: 5,
      model: "gpt-5.5",
      reasoningEffort: "high",
    });
    let shouldFail = true;
    const aiChat = {
      async createThread(input) {
        if (shouldFail) throw new Error("fixture spawn failed");
        return database.createAiChatThread({
          title: input.title,
          origin: {
            projectId: "project",
            projectName: "Project",
            workspacePath: directory,
            issueId: input.issueId,
            issueIdentifier: database.getTask(input.issueId).identifier,
          },
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          sandbox: input.sandbox,
        });
      },
      async startTurn(threadId) {
        return database.createAiChatRun({ threadId });
      },
      async interrupt() {},
      async deleteThread(threadId) {
        database.deleteAiChatThread(threadId);
      },
    };
    const scheduler = new ProjectAutomationScheduler({
      database,
      aiChat,
      events: { emit() {} },
      tickIntervalMs: 100,
    });

    await scheduler.tick();
    const failedTask = database.createTask({
      ...taskInput,
      title: "Fail before process start",
      status: "todo",
      priority: "high",
    });
    database.wakeProjectAutomation("project");
    await scheduler.tick();
    assert.equal(database.getTask(failedTask.id).status, "blocked");

    shouldFail = false;
    await scheduler.tick();
    const nextRunAt = Date.parse(database.getProjectAutomation("project").nextRunAt);
    const automaticTask = database.createTask({
      ...taskInput,
      title: "Claim after five seconds",
      status: "todo",
      priority: "medium",
    });
    const startedAt = Date.now();
    scheduler.start();
    while (Date.now() - startedAt < 6_500 && database.getTask(automaticTask.id).status === "todo") {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const elapsed = Date.now() - startedAt;
    assert.ok(nextRunAt - startedAt <= 5_100);
    assert.ok(elapsed >= 4_500, `claimed too early after ${elapsed}ms`);
    assert.ok(elapsed < 6_500, `did not claim within five-second interval (${elapsed}ms)`);
    assert.equal(database.getTask(automaticTask.id).status, "in_progress");
    scheduler.close();
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
