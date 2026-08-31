import type { ObligationRepository } from "../agent/ports.js";
import type { ScheduledAgentTaskService } from "../agent/services/scheduledAgentTaskService.js";
import type { ScheduledJobCategory, ScheduledJobInfo } from "../integrations/scheduler/jobScheduler.js";
import { sha256 } from "../shared/utils/hash.js";
import type { WorkflowService } from "../workflows/workflowService.js";
import { clockService } from "../shared/clockService.js";

/** Projects durable schedule state into the scheduler's existing display model. */
export class PersistentScheduleVisibility {
  public constructor(
    private readonly workflows: WorkflowService,
    private readonly obligations: ObligationRepository,
    private readonly scheduledTasks: ScheduledAgentTaskService,
  ) {}

  public async list(): Promise<ScheduledJobInfo[]> {
    const [reminders, obligations, tasks] = await Promise.all([
      this.workflows.getScheduledReminders(),
      this.obligations.listActive(),
      this.scheduledTasks.listActive(),
    ]);

    return [
      ...reminders.map((reminder): ScheduledJobInfo => ({
        jobId: `reminder-${reminder.id}`,
        category: "user_reminder",
        timezone: reminder.timezone,
        runOnce: true,
        schedulerStrategy: "custom",
        scheduledFor: reminder.scheduledFor,
        nextRunAt: reminder.scheduledFor,
      })),
      ...obligations
        // Waiting/failed operational state can remain useful in Supabase, but
        // a past due time is not a pending schedule and must not be displayed.
        .filter((obligation) => isFutureScheduleDate(obligation.dueAt))
        .map((obligation): ScheduledJobInfo => ({
          jobId: `agent-obligation-${obligation.id}`,
          category: obligationCategory(obligation.type),
          timezone: "Europe/London",
          runOnce: true,
          schedulerStrategy: "custom",
          scheduledFor: obligation.dueAt,
          nextRunAt: obligation.dueAt,
        })),
      ...tasks.map((task): ScheduledJobInfo => ({
        jobId: `scheduled-agent-task-${task.id}-${sha256(task.nextRunAt).slice(0, 10)}`,
        category: "scheduled_agent_task",
        timezone: task.schedule.timezone,
        runOnce: true,
        schedulerStrategy: "custom",
        scheduledFor: task.nextRunAt,
        nextRunAt: task.nextRunAt,
      })),
    ];
  }
}

export function isFutureScheduleDate(value?: string): value is string {
  if (!value) return false;
  const timestamp = clockService.Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > clockService.now().toMillis();
}

export function mergeScheduledJobVisibility(
  runtime: ScheduledJobInfo[],
  persistent: ScheduledJobInfo[],
): ScheduledJobInfo[] {
  const jobs = new Map(runtime.map((job) => [job.jobId, job]));
  for (const job of persistent) {
    if (!jobs.has(job.jobId)) jobs.set(job.jobId, job);
  }
  return [...jobs.values()];
}

function obligationCategory(type: string): ScheduledJobCategory {
  if (type === "setlist_followup_due") return "setlist_nudge";
  if (type === "setlist_broadcast_due") return "setlist_broadcast";
  if (type.includes("rota_reminder")) return "rota_reminder";
  return "other";
}
