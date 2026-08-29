import type { OutgoingMessage, SentMessageReceipt } from "../contracts/messages.js";

export interface MessageTransport {
  send(conversationId: string, message: OutgoingMessage): Promise<SentMessageReceipt>;
}

export interface ScheduledTask {
  id: string;
  runAt: string;
  timezone: string;
  category: string;
  action(): Promise<void>;
}

export interface WeeklyScheduledTask {
  id: string;
  dayOfWeek: number;
  time: string;
  timezone: string;
  category: string;
  action(): Promise<void>;
}

/** Scheduler implementations decide how timers are registered and recovered. */
export interface SchedulerPort {
  scheduleOnce(task: ScheduledTask): void;
  scheduleWeekly(task: WeeklyScheduledTask): void;
  cancel(taskId: string): void;
}
