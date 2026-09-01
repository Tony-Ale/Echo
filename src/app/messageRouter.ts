import { DateTime } from "luxon";
import type { IncomingMessage, OutgoingMessage } from "../framework/contracts/messages.js";
import { commands } from "./commands.js";
import { logData } from "../logger/execLogger.js";
import { getScheduledJobs, type ScheduledJobInfo } from "../integrations/scheduler/jobScheduler.js";
import { clockService } from "../shared/clockService.js";
import { buildHelpMessage } from "./helpText.js";
import type { EchoAgentService } from "../agent/services/echoAgentService.js";
import type { IdentityRepository, SyncCoordinator } from "../agent/ports.js";
import type { ManualSundayReminderResult } from "../domains/choir/operations/choirScheduleService.js";
import type { AgentTurnConstraints } from "../agent/types.js";
import { mergeScheduledJobVisibility } from "./scheduleVisibility.js";

interface SundayReminderActivator {
  triggerSundayReminder(commandEventKey: string): Promise<ManualSundayReminderResult>;
}

interface ScheduledMessageControls {
  disable: () => void;
  enable: () => void;
  isDisabled: () => boolean;
}

interface PersistentScheduleSource {
  list(): Promise<ScheduledJobInfo[]>;
}

/** Routes deterministic operator commands and delegates every other turn to the agent. */
export class MessageRouter {
  public constructor(
    private readonly agentService: EchoAgentService,
    private readonly syncCoordinator: SyncCoordinator,
    private readonly identities: IdentityRepository,
    private readonly sundayReminders: SundayReminderActivator,
    private readonly persistentSchedules?: PersistentScheduleSource,
  ) {}

  public setScheduledMessageControls(controls: ScheduledMessageControls): void {
    this.scheduledMessageControls = controls;
  }

  private scheduledMessageControls?: ScheduledMessageControls;

  /**
   * Handles one normalized message and returns final response.
   *
   * @param message Incoming bot message.
   * @returns Reply text or null if no response should be sent.
   */
  public async handle(message: IncomingMessage, constraints?: AgentTurnConstraints): Promise<OutgoingMessage | null> {
    if (!message.text.trim()) {
      return this.recordDirectReply(message, { text: "Please include a question after mentioning me." });
    }

    const clockReply = await this.handleCreatorClockCommand(message);
    if (clockReply) {
      return this.recordDirectReply(message, clockReply);
    }

    const scheduledMessagesReply = await this.handleCreatorScheduledMessagesCommand(message);
    if (scheduledMessagesReply) {
      return this.recordDirectReply(message, scheduledMessagesReply);
    }

    const sundayReminderReply = await this.handleCreatorSundayReminderCommand(message);
    if (sundayReminderReply) {
      return this.recordDirectReply(message, sundayReminderReply);
    }

    if (isHelpCommand(message.text)) {
      const member = await this.identities.resolveSender(message.sender);
      const text = buildHelpMessage(member?.roles ?? ["member"]);
      return this.recordDirectReply(message, { text });
    }

    if (message.text.toLowerCase().trim() === commands.SYNC){
      // Trigger synchronization flow
      if (!await this.senderHasRole(message, "superuser")){
        return this.recordDirectReply(message, { text: "You are not Authorized to Sync, Sync Failed" });
      }

      try {
        const res = await this.syncCoordinator.syncIfStale({ reason: "Explicit privileged transport sync command.", force: true });
        logData(res, "Synchronization completed");
        return this.recordDirectReply(message, { text: res.summary });
      } catch (error) {
        logData(error, "Synchronization failed without stopping Echo");
        return this.recordDirectReply(message, {
          text: "Synchronization could not complete, but Echo is still running. Please try the sync command again later.",
        });
      }
    }

    if (message.text.toLowerCase().trim() === commands.SCHEDULES) {
      if (!await this.senderHasRole(message, "superuser")) {
        return this.recordDirectReply(message, { text: "You are not authorized to view scheduled jobs." });
      }

      if (this.scheduledMessageControls?.isDisabled()) {
        return this.recordDirectReply(message, { text: "No scheduled messages." });
      }
      const persistent = await this.persistentSchedules?.list() ?? [];
      const jobs = mergeScheduledJobVisibility(getScheduledJobs(), persistent);
      if (jobs.length === 0) return this.recordDirectReply(message, { text: "No scheduled messages." });

      return this.recordDirectReply(message, { text: formatScheduledJobsForWhatsApp(jobs) });
    }

    return this.agentService.handleMessage(message, constraints);
  }

  private async recordDirectReply(message: IncomingMessage, reply: OutgoingMessage): Promise<OutgoingMessage> {
    await this.agentService.recordDeterministicExchange(message, reply);
    return reply;
  }

  private async handleCreatorScheduledMessagesCommand(message: IncomingMessage): Promise<OutgoingMessage | null> {
    const text = normalizeCommandText(message.text);
    const action = getScheduledMessagesAction(text);
    if (!action) return null;

    if (!await this.senderHasRole(message, "creator")) {
      return { text: "Only a creator can activate or deactivate the scheduler." };
    }

    if (!this.scheduledMessageControls) {
      return { text: "Scheduled message controls are not available right now." };
    }

    if (action === "deactivate") {
      this.scheduledMessageControls.disable();
      return { text: "Scheduler deactivated. Use `schedules` to confirm there are no scheduled messages." };
    }

    if (!this.scheduledMessageControls.isDisabled()) {
      return { text: "Scheduler is already active." };
    }

    this.scheduledMessageControls.enable();
    return { text: "Scheduler activated. Echo has restored the normal schedules for this week." };
  }

  private async handleCreatorSundayReminderCommand(message: IncomingMessage): Promise<OutgoingMessage | null> {
    if (normalizeCommandText(message.text) !== commands.SEND_SUNDAY_REMINDER) return null;
    if (!await this.senderHasRole(message, "creator")) {
      return { text: "Only a creator can send the Sunday reminder manually." };
    }
    if (message.metadata.conversationKind !== "private") {
      return { text: "Please use this creator command in your private chat with Echo." };
    }

    try {
      const result = await this.sundayReminders.triggerSundayReminder(
        `${message.transport}:${message.conversationId}:${message.id}`,
      );
      return result.delivered
        ? { text: "Sunday reminder sent to the choir group." }
        : { text: manualSundayReminderFailure(result.reason) };
    } catch (error) {
      logData({ error, messageId: message.id }, "Manual Sunday reminder activation failed");
      return { text: "The Sunday reminder could not be sent. Please try again shortly." };
    }
  }

  private async handleCreatorClockCommand(message: IncomingMessage): Promise<OutgoingMessage | null> {
    const text = normalizeCommandText(message.text);
    if (!text.startsWith(`${commands.CLOCK} `) && text !== commands.CLOCK) return null;
    if (!await this.senderHasRole(message, "creator")) {
      return { text: "Only a creator can control Echo's mock clock." };
    }
    return handleAuthorizedClockCommand(text);
  }

  private async senderHasRole(message: IncomingMessage, role: "creator" | "superuser"): Promise<boolean> {
    const member = await this.identities.resolveSender(message.sender);
    if (!member) return false;
    return role === "superuser"
      ? member.roles.includes("superuser") || member.roles.includes("creator")
      : member.roles.includes("creator");
  }
}

function manualSundayReminderFailure(reason: ManualSundayReminderResult["reason"]): string {
  if (reason === "no_reply") return "No Sunday reminder was sent because the current schedule did not require one.";
  if (reason === "policy_blocked") return "The Sunday reminder was not sent because its schedule validation did not complete.";
  if (reason === "no_safe_target") return "The Sunday reminder was not sent because no safe message target was resolved.";
  return "The Sunday reminder could not be delivered to the choir group.";
}

function isHelpCommand(text: string): boolean {
  const normalized = normalizeCommandText(text);
  return normalized === commands.HELP;
}

function getScheduledMessagesAction(text: string): "activate" | "deactivate" | null {
  if (text === "scheduler deactivate") return "deactivate";
  if (text === "scheduler activate") return "activate";
  return null;
}

function handleAuthorizedClockCommand(text: string): OutgoingMessage {
  if (text === commands.CLOCK || text === `${commands.CLOCK} now` || text === `${commands.CLOCK} status`) {
    return { text: formatClockStatus() };
  }

  if (text === `${commands.CLOCK} help`) {
    return { text: buildClockHelpMessage() };
  }

  const setMatch = text.match(/^clock\s+(?:set|mock\s+on)\s+(.+)$/i);
  if (setMatch) {
    try {
      clockService.setMockTime(setMatch[1].trim());
      return { text: `Mock time enabled.\n${formatClockStatus()}` };
    } catch (error) {
      logData({ error, input: setMatch[1] }, "Clock set command failed");
      return { text: "I could not set that mock time. Use `clock set 2026-08-01 14:30`." };
    }
  }

  const advanceMatch = text.match(/^clock\s+advance\s+(.+)$/i);
  if (advanceMatch) {
    const duration = parseClockAdvance(advanceMatch[1]);
    if (!duration) {
      return { text: "I could not understand that duration. Use `clock advance 7 days` or `clock advance 5 hours 30 minutes`." };
    }
    clockService.advanceTime(duration);
    return { text: `Mock time advanced.\n${formatClockStatus()}` };
  }

  if (/^clock\s+(?:clear|reset|mock\s+off)$/i.test(text)) {
    clockService.clearMockTime();
    return { text: `Mock time cleared.\n${formatClockStatus()}` };
  }

  return { text: buildClockHelpMessage() };
}

function normalizeCommandText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^@\S+\s+/, "")
    .replace(/^echo\s+/, "");
}

function formatClockStatus(): string {
  const mode = clockService.isMockTimeEnabled() ? "mock" : "system";
  return `Clock: ${mode}\nNow: ${clockService.now("Europe/London").toFormat("yyyy-LL-dd HH:mm ZZZZ")}`;
}

function buildClockHelpMessage(): string {
  return [
    "Creator clock commands:",
    "- `clock now`",
    "- `clock set 2026-08-01 14:30`",
    "- `clock advance 7 days`",
    "- `clock advance 5 hours 30 minutes`",
    "- `clock clear`",
  ].join("\n");
}

function parseClockAdvance(input: string): Record<string, number> | null {
  const duration: Record<string, number> = {};
  const regex = /(\d+)\s*(day|days|hour|hours|minute|minutes|week|weeks)/gi;
  let matched = false;
  for (const match of input.matchAll(regex)) {
    matched = true;
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (unit.startsWith("week")) duration.weeks = (duration.weeks ?? 0) + value;
    if (unit.startsWith("day")) duration.days = (duration.days ?? 0) + value;
    if (unit.startsWith("hour")) duration.hours = (duration.hours ?? 0) + value;
    if (unit.startsWith("minute")) duration.minutes = (duration.minutes ?? 0) + value;
  }
  return matched ? duration : null;
}

export function formatScheduledJobsForWhatsApp(jobs: ScheduledJobInfo[]): string {
  const clockMode = clockService.isMockTimeEnabled() ? "mock time" : "system time";
  const entries = [...jobs]
    .sort(compareScheduledJobs)
    .map((job, index) => formatScheduledJob(job, index + 1));

  return [
    "Scheduled messages",
    `Clock: ${clockMode}`,
    "Times shown in UK time.",
    "",
    ...entries,
  ].join("\n");
}

function compareScheduledJobs(left: ScheduledJobInfo, right: ScheduledJobInfo): number {
  const leftTime = getSortableTime(left);
  const rightTime = getSortableTime(right);
  if (leftTime !== rightTime) return leftTime - rightTime;
  return friendlyJobName(left).localeCompare(friendlyJobName(right));
}

function getSortableTime(job: ScheduledJobInfo): number {
  const iso = job.nextRunAt ?? job.scheduledFor;
  if (!iso) return Number.MAX_SAFE_INTEGER;
  const parsed = DateTime.fromISO(iso, { zone: job.timezone });
  return parsed.isValid ? parsed.toMillis() : Number.MAX_SAFE_INTEGER;
}

function friendlyJobName(job: ScheduledJobInfo): string {
  if (job.jobId === "choir-sunday-rota-activation") return "Sunday rota reminder";
  if (job.jobId === "choir-wednesday-rota-activation") return "Wednesday rota reminder";
  if (job.jobId === "choir-operational-memory-cleanup") return "Setlist and weekly-memory cleanup";
  if (job.jobId === "choir-setlist-planning-activation") return "Weekly setlist planning";
  if (job.jobId.startsWith("agent-obligation-") && job.category === "setlist_nudge") return "Setlist nudge";
  if (job.jobId.startsWith("agent-obligation-") && job.category === "setlist_broadcast") return "Setlist broadcast";
  if (job.jobId.startsWith("reminder-")) return "User reminder";
  if (job.jobId.startsWith("scheduled-agent-task-")) return "Recurring agent task";
  return humanizeIdentifier(job.jobId);
}

function formatScheduledJob(job: ScheduledJobInfo, position: number): string {
  if (job.runOnce) {
    const when = formatHumanDateTime(job.scheduledFor ?? job.nextRunAt, job.timezone);
    return `${position}. ${friendlyJobName(job)}\n   When: ${when}\n`;
  }

  const recurring = describeRecurringSchedule(job);
  const next = formatHumanDateTime(job.nextRunAt, job.timezone);
  return `${position}. ${friendlyJobName(job)}\n   Next: ${next}\n   Repeats: ${recurring}\n`;
}

function describeRecurringSchedule(job: ScheduledJobInfo): string {
  const cron = job.cronExpression?.trim();
  if (!cron) return "recurring schedule";

  const [minute, hour, dayOfMonth, , dayOfWeek] = cron.split(/\s+/);
  const time = formatHourMinute(hour, minute);
  if (dayOfWeek !== "*") return `Every ${weekdayName(Number(dayOfWeek))} at ${time}`;
  if (dayOfMonth !== "*") return `Day ${dayOfMonth} of every month at ${time}`;
  return `Every day at ${time}`;
}

function formatHumanDateTime(iso: string | undefined, timezone: string): string {
  if (!iso) return "not available yet";
  const date = DateTime.fromISO(iso, { zone: timezone });
  if (!date.isValid) return "not available yet";
  return date.toFormat("cccc, d LLLL yyyy 'at' h:mm a");
}

function formatHourMinute(hour: string, minute: string): string {
  const date = DateTime.fromObject({ hour: Number(hour), minute: Number(minute) }, { zone: "Europe/London" });
  return date.isValid ? date.toFormat("h:mm a") : `${hour}:${minute}`;
}

function weekdayName(dayOfWeek: number): string {
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return names[dayOfWeek] ?? "Scheduled";
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
