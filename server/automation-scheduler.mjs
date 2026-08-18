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

function isRetryableCapacityError(error) {
  return /(?:quota|rate[\s_-]*limit|usage[\s_-]*limit|credit|too many requests|\b429\b|capacity|overloaded|resource exhausted|额度|限额|用量已达)/i.test(error);
}

function automationMessage(task) {
  return task.description.trim() || task.title.trim();
}

function automationItem(policy) {
  if (!policy) return null;
  return {
    id: `server:${policy.projectId}`,
    status: policy.enabledByUser ? "ACTIVE" : "PAUSED",
    model: policy.model,
    reasoningEffort: policy.reasoningEffort,
    rrule: `RRULE:FREQ=SECONDLY;INTERVAL=${policy.intervalSeconds}`,
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
          quotaAware: false,
          intervalSeconds: policy.intervalSeconds,
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
    this.database.syncProjectAutomationsFromGlobal();
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
    let run = null;
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
      run = await this.aiChat.startTurn(thread.id, {
        message: automationMessage(task),
        direct: true,
      });
      const activated = this.database.attachAutomationRun(
        task.projectId,
        task.id,
        thread.id,
        run.id,
      );
      const comment = this.database.createComment(task.id, {
        body: `AI 已自动认领任务，执行会话：${thread.codexThreadId ?? thread.id}`,
        threadId: thread.id,
        actor: AI_AGENT_ACTOR,
      });
      this.events.emit("task.moved", { task: activated.task });
      this.events.emit("comment.created", { comment });
    } catch (error) {
      const message = compactError(error);
      const shouldRetry = isRetryableCapacityError(message);
      if (run) {
        try {
          await this.aiChat.interrupt(run.id);
        } catch {
          // Preserve the launch error as the user-facing failure.
        }
      }
      const restored = this.database.rollbackAutomationClaim(task.projectId, task.id, message);
      if (restored) {
        if (!shouldRetry) {
          const blocked = this.database.moveTask(restored.id, restored.version, "blocked");
          const comment = this.database.createComment(task.id, {
            body: `自动执行启动失败：${message}`,
            threadId: thread?.id ?? null,
            actor: AI_AGENT_ACTOR,
          });
          this.events.emit("task.moved", { task: blocked });
          this.events.emit("comment.created", { comment });
        }
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
    let task = this.database.getTask(policy.activeTaskId);
    const thread = policy.activeThreadId
      ? this.database.getAiChatThread(policy.activeThreadId)
      : null;
    if (task && thread?.codexThreadId && !task.codexThreadId) {
      task = this.database.updateTask(task.id, task.version, {
        codexThreadId: thread.codexThreadId,
        codexThreadName: thread.title,
      }, thread.id);
      this.events.emit("task.updated", { task });
    }
    if (!run || run.status === "running") {
      if (run) this.database.renewAutomationLease(policy.projectId, run.id);
      return;
    }

    const failed = run.status !== "completed";
    const error = failed ? compactError(run.error || `AI exited with code ${run.exitCode}`) : null;
    this.database.finishAutomationRun(policy.projectId, run.id, error);
    if (!task || task.archivedAt) return;

    let updated = task;
    const shouldRetry = failed && isRetryableCapacityError(error);
    if (shouldRetry && task.status !== "todo") {
      updated = this.database.moveTask(task.id, task.version, "todo");
    } else if (failed && task.status !== "blocked") {
      updated = this.database.moveTask(task.id, task.version, "blocked");
    } else if (!failed && !["done", "canceled"].includes(task.status)) {
      updated = this.database.moveTask(task.id, task.version, "done");
    }
    this.events.emit("task.moved", { task: updated });
    if (!shouldRetry) {
      const comment = this.database.createComment(task.id, {
        body: failed
          ? `自动执行失败：${error}`
          : "自动执行已完成，结果已写入关联的 AI 会话。",
        threadId: policy.activeThreadId,
        actor: AI_AGENT_ACTOR,
      });
      this.events.emit("comment.created", { comment });
    }
  }
}
