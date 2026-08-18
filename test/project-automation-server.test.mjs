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
      description: "黄金未来还会涨吗\n请直接回答这个问题",
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
    let receivedTurn = null;
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
      async startTurn(threadId, input) {
        receivedTurn = input;
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
    assert.deepEqual(receivedTurn, {
      message: "黄金未来还会涨吗\n请直接回答这个问题",
      direct: true,
    });
    const startedComments = database.listComments(runnable.id);
    assert.equal(startedComments.length, 1);
    assert.equal(startedComments[0].threadId, "codex-new-thread-1");
    assert.doesNotMatch(startedComments[0].body, /执行会话：[0-9a-f-]{36}/i);

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
    assert.equal(database.getTask(runnable.id).threadId, "codex-new-thread-1");
    const completedComments = database.listComments(runnable.id);
    assert.equal(completedComments.at(-1).threadId, "codex-new-thread-1");
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

test("startup repairs internal automation thread ids before exposing task and comment links", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-automation-thread-migration-"));
  const filename = path.join(directory, "taskboard.sqlite");
  let database = new TaskboardDatabase(filename);
  try {
    database.createProject({ id: "project", name: "Project", workspacePath: directory });
    const actor = { type: "user", id: "local-user", name: "Local", avatarUrl: null };
    const task = database.createTask({
      projectId: "project",
      title: "Migration target",
      description: "",
      status: "done",
      priority: "none",
      labels: [],
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      dueDate: null,
      recurrence: null,
    });
    const internalThread = database.createAiChatThread({
      title: "Automation",
      origin: {
        projectId: "project",
        projectName: "Project",
        workspacePath: directory,
        issueId: task.id,
        issueIdentifier: task.identifier,
      },
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandbox: "workspace-write",
      codexThreadId: "codex-visible-thread",
    });
    database.moveTask(task.id, task.version, "done", undefined, internalThread.id);
    database.createComment(task.id, {
      body: `AI 已自动认领任务，执行会话：${internalThread.id}`,
      threadId: internalThread.id,
      actor: { type: "agent", id: "codex-agent", name: "AI Agent", avatarUrl: null },
    });
    database.close();

    database = new TaskboardDatabase(filename);
    assert.equal(database.getTask(task.id).threadId, "codex-visible-thread");
    const [comment] = database.listComments(task.id);
    assert.equal(comment.threadId, "codex-visible-thread");
    assert.equal(comment.body, "AI 已自动认领任务，正在关联的 AI 会话中执行。");
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

test("automation ignores legacy quota settings and retries a capacity failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-automation-capacity-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const actor = { type: "user", id: "local-user", name: "Local", avatarUrl: null };
  try {
    database.createProject({ id: "project", name: "Project", workspacePath: directory });
    const task = database.createTask({
      projectId: "project",
      title: "Retry after quota recovers",
      description: "",
      status: "todo",
      priority: "high",
      labels: [],
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      dueDate: null,
      recurrence: null,
    });
    database.upsertProjectAutomation("local", {
      enabledByUser: true,
      quotaAware: true,
      intervalSeconds: 5,
      model: "gpt-5.5",
      reasoningEffort: "high",
    });
    assert.equal(database.getProjectAutomation("local").quotaAware, false);
    assert.equal(projectAutomationResponse(database.getProjectAutomation("local")).item.status, "ACTIVE");

    let quotaAvailable = false;
    const aiChat = {
      async createThread(input) {
        if (!quotaAvailable) throw new Error("429 usage limit reached");
        return database.createAiChatThread({
          title: input.title,
          origin: {
            projectId: "project",
            projectName: "Project",
            workspacePath: directory,
            issueId: input.issueId,
            issueIdentifier: task.identifier,
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
    });

    await scheduler.tick();
    assert.equal(database.getProjectAutomation("project").enabledByUser, true);
    assert.equal(database.getTask(task.id).status, "todo");
    assert.equal(database.getProjectAutomation("project").activeTaskId, null);

    quotaAvailable = true;
    database.wakeProjectAutomation("project");
    await scheduler.tick();
    assert.equal(database.getTask(task.id).status, "in_progress");
    scheduler.close();
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
