import { DateTime } from "luxon";
import type { SchedulerPort } from "../framework/ports/index.js";
import { logData } from "../logger/execLogger.js";
import type { ReminderRecord } from "./types.js";
import { clockService } from "../shared/clockService.js";

export type ReminderSender = (reminder: ReminderRecord) => Promise<void>;
export type ReminderCompleter = (id: string) => Promise<void>;

export class ReminderScheduler {
  public constructor(
    private readonly scheduler: SchedulerPort,
    private sendReminder?: ReminderSender,
    private completeReminder?: ReminderCompleter
  ) {}

  public setHandlers(sendReminder: ReminderSender, completeReminder: ReminderCompleter): void {
    this.sendReminder = sendReminder;
    this.completeReminder = completeReminder;
    logData("Reminder scheduler handlers registered", "Reminder scheduler configured");
  }

  public schedule(reminder: ReminderRecord): void {
    if (reminder.status !== "scheduled") {
      logData({ reminderId: reminder.id, status: reminder.status }, "Reminder scheduling skipped for non-scheduled status");
      return;
    }
    const target = DateTime.fromISO(reminder.scheduledFor, { zone: reminder.timezone });
    if (!target.isValid || target <= clockService.now(reminder.timezone)) {
      logData({ reminderId: reminder.id, scheduledFor: reminder.scheduledFor }, "Reminder scheduling skipped for invalid or past date");
      return;
    }

    this.scheduler.scheduleOnce({
      id: this.jobId(reminder.id),
      // SchedulerPort uses ISO at the framework boundary; its concrete adapter
      // owns conversion to the scheduler's internal yyyy-MM-dd HH:mm format.
      runAt: reminder.scheduledFor,
      timezone: reminder.timezone,
      category: "user_reminder",
      action: async () => {
        if (!this.sendReminder || !this.completeReminder) {
          logData({ reminderId: reminder.id }, "Reminder execution skipped because scheduler handlers are missing");
          return;
        }
        await this.sendReminder(reminder);
        await this.completeReminder(reminder.id);
        logData({ reminderId: reminder.id }, "Scheduled reminder executed");
      },
    });
    logData({ reminderId: reminder.id, scheduledFor: reminder.scheduledFor }, "Reminder scheduled");
  }

  public cancel(reminderId: string): void {
    this.scheduler.cancel(this.jobId(reminderId));
    logData({ reminderId }, "Reminder schedule cancellation requested");
  }

  public recover(reminders: ReminderRecord[]): void {
    logData({ count: reminders.length }, "Reminder scheduler recovery started");
    for (const reminder of reminders) {
      this.schedule(reminder);
    }
  }

  private jobId(reminderId: string): string {
    return `reminder-${reminderId}`;
  }
}
