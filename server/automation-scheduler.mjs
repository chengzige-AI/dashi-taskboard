const AI_AGENT_ACTOR = {
  type: "agent",
  id: "codex-agent",
  name: "AI Agent",
  avatarUrl: null,
};

const DEFAULT_TICK_INTERVAL_MS = 5_000;

function compactError(error) {
  const value = error instanceof Error ? error.message : String(error ?? "Unknown error");
  return value.replaceAll(/\s+/g, " ").trim().slice(0, 2_000);
}

function automationPrompt(task) {
  return [
    `执行看板任务 ${task.identifier}：${task.title}`,
    task.description ? `\n任务说明：\n${task.description}` : "",
    "",
    "请先读取任务详情和关联关系，再在绑定项目的工作目录中完成并验证任务。",
    "使用 taskctl 持续回写重要进展。完成实现和验证后移入审核中；如果无法继续，移入已阻塞并说明原因。",
  ].join("\n");
}

function automationItem(policy) {
  if (!policy) return null;
  return {
    id: `server:${policy.projectId}`,
    status: policy.enabledByUser && !policy.quotaAware ? "ACTIVE" : "PAUSED",
    model: policy.model,
    reasoningEffort: policy.reasoningEffort,
    rrule: `RRULE:FREQ=MINUTELY;INTERVAL=${policy.intervalMinutes}`,
    nextRunAt: policy.nextRunAt ? Math.floor(Date.parse(policy.nextRunAt) / 1_000) : null,
  };
}

export function projectAutomationResponse(policy) {
  const item = automationItem(policy);
  return {
    ok: true,
    items: item ? [item] : [],
    ...(item ? { item } : {}),
    policy: policy
      ? {
          automationId: item.id,
          enabledByUser: policy.enabledByUser,
          quotaAware: policy.quotaAware,
          intervalMinutes: policy.intervalMinutes,
          model: policy.model,
          reasoningEffort: policy.reasoningEffort,
        }
      : null,
    execution: policy
      ? {
          activeTaskId: policy.activeTaskId,
          activeThreadId: policy.activeThreadId,
          activeRunId: policy.activeRunId,
          lastRunAt: policy.lastRunAt,
          lastError: policy.lastError,
        }
      : null,
  };
}

export class ProjectAutomationScheduler {
  constructor(options) {
    this.database = options.database;
    this.aiChat = options.aiChat;
    this.events = options.events;
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.timer = null;
    this.tickPromise = null;
    this.closed = false;
  }

  start() {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => this.wake(), this.tickIntervalMs);
    this.timer.unref?.();
    this.wake();
  }

  wake() {
    if (this.closed) return;
    void this.tick().catch((error) => console.error("Task automation tick failed", error));
  }

  wakeProject(projectId) {
    this.database.wakeProjectAutomation(projectId);
    this.wake();
  }

  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.#tick().finally(() => {
      this.tickPromise = null;
    });
    return this.tickPromise;
  }

  async #tick() {
    for (const policy of this.database.listActiveProjectAutomations()) {
      await this.#reconcile(policy);
    }
    for (const policy of this.database.listRunnableProjectAutomations()) {
      const claim = this.database.claimNextAutomationTask(policy.projectId);
      if (claim) await this.#launch(claim);
    }
  }

  async #launch({ task, policy }) {
    let thread = null;
    try {
      thread = await this.aiChat.createThread({
        projectId: task.projectId,
        issueId: task.id,
        title: `自动执行 · ${task.identifier}`,
        model: policy.model,
        reasoningEffort: policy.reasoningEffort,
        sandbox: "workspace-write",
        codexThreadId: task.codexThreadId ?? undefined,
      });
      const run = await this.aiChat.startTurn(thread.id, {
        message: automationPrompt(task),
        skills: [],
        attachments: [],
      });
      this.database.attachAutomationRun(task.projectId, task.id, thread.id, run.id);
      const comment = this.database.createComment(task.id, {
        body: `AI 已自动认领任务，执行会话：${thread.id}`,
        threadId: thread.id,
        actor: AI_AGENT_ACTOR,
      });
      this.events.emit("task.moved", { task: this.database.getTask(task.id) });
      this.events.emit("comment.created", { comment });
    } catch (error) {
      const message = compactError(error);
      const restored = this.database.rollbackAutomationClaim(task.projectId, task.id, message);
      if (restored) {
        const blocked = this.database.moveTask(restored.id, restored.version, "blocked");
        const comment = this.database.createComment(task.id, {
          body: `自动执行启动失败：${message}`,
          threadId: thread?.id ?? null,
          actor: AI_AGENT_ACTOR,
        });
        this.events.emit("task.moved", { task: blocked });
        this.events.emit("comment.created", { comment });
      }
      if (thread) {
        try {
          const current = this.database.getAiChatThread(thread.id);
          if (current && !current.currentRun) await this.aiChat.deleteThread(thread.id);
        } catch {
          // Keep the original launch error as the observable failure.
        }
      }
    }
  }

  async #reconcile(policy) {
    if (!policy.activeRunId || !policy.activeTaskId) return;
    const run = this.database.getAiChatRun(policy.activeRunId);
    if (!run || run.status === "running") {
      if (run) this.database.renewAutomationLease(policy.projectId, run.id);
      return;
    }

    const task = this.database.getTask(policy.activeTaskId);
    const failed = run.status !== "completed";
    const error = failed ? compactError(run.error || `AI exited with code ${run.exitCode}`) : null;
    this.database.finishAutomationRun(policy.projectId, run.id, error);
    if (!task || task.archivedAt) return;

    let updated = task;
    if (failed && task.status !== "blocked") {
      updated = this.database.moveTask(task.id, task.version, "blocked");
    } else if (!failed && !["done", "canceled"].includes(task.status)) {
      updated = this.database.moveTask(task.id, task.version, "done");
    }
    const comment = this.database.createComment(task.id, {
      body: failed
        ? `自动执行失败：${error}`
        : "自动执行已完成，结果已写入关联的 AI 会话。",
      threadId: policy.activeThreadId,
      actor: AI_AGENT_ACTOR,
    });
    this.events.emit("task.moved", { task: updated });
    this.events.emit("comment.created", { comment });
  }
}
