export type ReminderStatus =
  | "pending_confirmation"
  | "scheduled"
  | "pending_edit_confirmation"
  | "pending_cancel_confirmation"
  | "completed"
  | "cancelled";

export interface ReminderRecord {
  id: string;
  chatId: string;
  creatorId: string;
  creatorName?: string;
  message: string;
  rawDatePhrase: string;
  scheduledFor: string;
  timezone: string;
  status: ReminderStatus;
  confirmationMessageId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type SetlistKind = "worship" | "praise" | "setlist";
export type SetlistWorkflowStatus = "submitted" | "cancelled";

export interface SetlistSubmissionRecord {
  id: string;
  chatId: string;
  submitterId: string;
  submitterName?: string;
  kind: SetlistKind;
  weekStart: string;
  content: string;
  status: SetlistWorkflowStatus;
  expiresAt?: string;
  broadcastScheduledFor?: string;
  broadcastSentAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}
