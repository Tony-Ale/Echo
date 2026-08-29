import { DateTime } from "luxon";
import type { ScheduledTask, SchedulerPort, WeeklyScheduledTask } from "../../framework/ports/index.js";
import { cancelJob, scheduleJob } from "./jobScheduler.js";

/** Exposes the existing centralized scheduler through the framework port. */
export class ApplicationSchedulerAdapter implements SchedulerPort {
  public scheduleOnce(task: ScheduledTask): void {
    const due = DateTime.fromISO(task.runAt, { zone: task.timezone });
    if (!due.isValid) throw new Error(`Scheduled task '${task.id}' has an invalid runAt value.`);
    scheduleJob({
      jobId: task.id,
      runOnce: true,
      dateTime: due.toFormat("yyyy-LL-dd HH:mm"),
      timezone: task.timezone,
      category: task.category as Parameters<typeof scheduleJob>[0]["category"],
      schedulerStrategy: "custom",
      action: task.action,
    });
  }

  public scheduleWeekly(task: WeeklyScheduledTask): void {
    scheduleJob({
      jobId: task.id,
      dayOfWeek: task.dayOfWeek,
      time: task.time,
      timezone: task.timezone,
      category: task.category as Parameters<typeof scheduleJob>[0]["category"],
      action: task.action,
    });
  }

  public cancel(taskId: string): void {
    cancelJob(taskId);
  }
}
