import { clockService } from "../../shared/clockService.js";
import type { SchedulerPort } from "../../framework/ports/index.js";
import { logData } from "../../logger/execLogger.js";
import { sha256 } from "../../shared/utils/hash.js";
import type { ScheduledAgentTaskManager, ScheduledAgentTaskRepository } from "../ports.js";
import type { AgentProcedureStep, AgentTurnResult, ScheduledAgentTask } from "../types.js";
import { nextRecurringRun, parseRecurringSchedule } from "./recurringSchedule.js";
import { DateTime } from "luxon";

interface ScheduledTaskActivation {
  task: ScheduledAgentTask;
  executionKey: string;
  scheduledFor: string;
  immediate: boolean;
}

interface ScheduledTaskExecution {
  result: AgentTurnResult;
  procedure: AgentProcedureStep[];
}

type ScheduledTaskRunner = (activation: ScheduledTaskActivation) => Promise<ScheduledTaskExecution>;

/**
 * Owns recurring task definitions and timer recovery. Timers only activate the
 * ordinary agent runtime; they never replay model output or cached evidence.
 */
export class ScheduledAgentTaskService implements ScheduledAgentTaskManager {
  private runner?: ScheduledTaskRunner;

  public constructor(
    private readonly repository: ScheduledAgentTaskRepository,
    private readonly scheduler: SchedulerPort,
  ) {}

  public setRunner(runner: ScheduledTaskRunner): void {
    this.runner = runner;
  }

  public async create(input: {
    chatId: string;
    ownerMemberId: string;
    objective: string;
    rawSchedulePhrase: string;
  }): Promise<{ task?: ScheduledAgentTask; created: boolean; error?: string }> {
    const parsed = parseRecurringSchedule(input.rawSchedulePhrase);
    if (!parsed.ok) return { created: false, error: parsed.reason };
    const objective = input.objective.trim();
    if (!objective) return { created: false, error: "I could not find what the recurring task should do." };
    const nextRunAt = nextRecurringRun(parsed.schedule, clockService.now(parsed.schedule.timezone)).toISO()!;
    const naturalKey = taskNaturalKey(input.chatId, input.ownerMemberId, objective, parsed.schedule);
    const saved = await this.repository.create({
      naturalKey,
      chatId: input.chatId,
      ownerMemberId: input.ownerMemberId,
      objective,
      rawSchedulePhrase: input.rawSchedulePhrase.trim(),
      schedule: parsed.schedule,
      nextRunAt,
    });
    if (saved.created) this.schedule(saved.task);
    logData({ taskId: saved.task.id, created: saved.created, nextRunAt }, "Scheduled agent task saved");
    return saved;
  }

  public listOwned(ownerMemberId: string, chatId: string): Promise<ScheduledAgentTask[]> {
    return this.repository.listOwned(ownerMemberId, chatId);
  }

  public async manage(input: {
    id: string;
    ownerMemberId: string;
    action: "pause" | "resume" | "cancel" | "update";
    objective?: string;
    rawSchedulePhrase?: string;
  }): Promise<{ task?: ScheduledAgentTask; error?: string }> {
    const current = await this.repository.get(input.id);
    if (!current || current.ownerMemberId !== input.ownerMemberId) {
      return { error: "That scheduled task was not found or does not belong to you." };
    }

    if (input.action === "pause" || input.action === "cancel") {
      const status = input.action === "pause" ? "paused" : "cancelled";
      const updated = await this.repository.updateOwned(input.id, input.ownerMemberId, { status });
      this.scheduler.cancel(this.jobId(input.id, current.nextRunAt));
      return updated ? { task: updated } : { error: "The scheduled task could not be updated." };
    }

    if (input.action === "resume") {
      const nextRunAt = nextRecurringRun(current.schedule, clockService.now(current.schedule.timezone)).toISO()!;
      const updated = await this.repository.updateOwned(input.id, input.ownerMemberId, { status: "active", nextRunAt });
      if (updated) this.schedule(updated);
      return updated ? { task: updated } : { error: "The scheduled task could not be resumed." };
    }

    const objective = input.objective?.trim() || current.objective;
    let schedule = current.schedule;
    let rawSchedulePhrase = current.rawSchedulePhrase;
    if (input.rawSchedulePhrase?.trim()) {
      const parsed = parseRecurringSchedule(input.rawSchedulePhrase);
      if (!parsed.ok) return { error: parsed.reason };
      schedule = parsed.schedule;
      rawSchedulePhrase = input.rawSchedulePhrase.trim();
    }
    const nextRunAt = nextRecurringRun(schedule, clockService.now(schedule.timezone)).toISO()!;
    this.scheduler.cancel(this.jobId(input.id, current.nextRunAt));
    const updated = await this.repository.updateOwned(input.id, input.ownerMemberId, {
      naturalKey: taskNaturalKey(current.chatId, current.ownerMemberId, objective, schedule),
      objective,
      rawSchedulePhrase,
      schedule,
      nextRunAt,
    });
    if (updated) this.schedule(updated);
    return updated ? { task: updated } : { error: "The scheduled task could not be updated." };
  }

  /** Re-registers all active definitions after a process restart. */
  public async recover(): Promise<void> {
    const tasks = await this.repository.listActive();
    let advanced = 0;
    for (const task of tasks) {
      const now = clockService.now(task.schedule.timezone);
      const currentRun = DateTime.fromISO(task.nextRunAt, { setZone: true }).setZone(task.schedule.timezone);
      if (currentRun.isValid && currentRun <= now) {
        const nextRunAt = nextRecurringRun(task.schedule, now).toISO()!;
        const updated = await this.repository.updateOwned(task.id, task.ownerMemberId, { nextRunAt });
        if (updated) this.schedule(updated);
        advanced += 1;
        continue;
      }
      this.schedule(task);
    }
    logData({ count: tasks.length, advanced }, "Scheduled agent tasks recovered");
  }

  public listActive(): Promise<ScheduledAgentTask[]> {
    return this.repository.listActive();
  }

  /** Executes the first run immediately without changing the future recurrence. */
  public async runNow(id: string): Promise<AgentTurnResult | null> {
    const task = await this.repository.get(id);
    if (!task || task.status !== "active") return null;
    const executionKey = `scheduled-task:${task.id}:initial:${task.createdAt}`;
    const claimed = await this.repository.claimExecution({
      id: task.id,
      executionKey,
      nextRunAt: task.nextRunAt,
    });
    if (!claimed) return null;
    return this.execute({
      task: claimed,
      executionKey,
      scheduledFor: clockService.now(claimed.schedule.timezone).toISO()!,
      immediate: true,
    });
  }

  private schedule(task: ScheduledAgentTask): void {
    if (task.status !== "active") return;
    const id = this.jobId(task.id, task.nextRunAt);
    this.scheduler.cancel(id);
    this.scheduler.scheduleOnce({
      id,
      runAt: task.nextRunAt,
      timezone: task.schedule.timezone,
      category: "scheduled_agent_task",
      action: () => this.runDue(task.id, task.nextRunAt),
    });
  }

  private async runDue(id: string, expectedRunAt: string): Promise<void> {
    const task = await this.repository.get(id);
    if (!task || task.status !== "active" || task.nextRunAt !== expectedRunAt) return;
    const executionKey = `scheduled-task:${task.id}:${expectedRunAt}`;
    // Skip catch-up storms after downtime or mock-time jumps: execute the due
    // objective once, then calculate the next occurrence from current time.
    const nextRunAt = nextRecurringRun(task.schedule, clockService.now(task.schedule.timezone)).toISO()!;
    const claimed = await this.repository.claimExecution({
      id: task.id,
      executionKey,
      expectedRunAt,
      nextRunAt,
    });
    if (!claimed) return;
    this.schedule(claimed);
    await this.execute({ task: claimed, executionKey, scheduledFor: expectedRunAt, immediate: false });
  }

  private async execute(activation: ScheduledTaskActivation): Promise<AgentTurnResult | null> {
    if (!this.runner) {
      await this.repository.recordExecution({
        id: activation.task.id,
        executionKey: activation.executionKey,
        succeeded: false,
        error: "Scheduled task runner is not configured.",
      });
      return null;
    }
    try {
      const execution = await this.runner(activation);
      const succeeded = execution.result.status === "completed";
      await this.repository.recordExecution({
        id: activation.task.id,
        executionKey: activation.executionKey,
        procedure: succeeded ? execution.procedure : undefined,
        succeeded,
        error: execution.result.error,
      });
      return execution.result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.repository.recordExecution({
        id: activation.task.id,
        executionKey: activation.executionKey,
        succeeded: false,
        error: message,
      });
      logData({ taskId: activation.task.id, error }, "Scheduled agent task execution failed");
      return null;
    }
  }

  private jobId(id: string, runAt: string): string {
    return `scheduled-agent-task-${id}-${sha256(runAt).slice(0, 10)}`;
  }
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function taskNaturalKey(
  chatId: string,
  ownerMemberId: string,
  objective: string,
  schedule: import("../types.js").RecurringSchedule,
): string {
  return sha256(JSON.stringify({ chatId, ownerMemberId, objective: normalizeText(objective), schedule }));
}
