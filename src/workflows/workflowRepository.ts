import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../integrations/supabase/client.js";
import { logData } from "../logger/execLogger.js";
import { clockService } from "../shared/clockService.js";
import type {
  ReminderRecord,
  ReminderStatus,
  SetlistKind,
  SetlistSubmissionRecord,
} from "./types.js";

type ReminderRow = {
  id: string;
  chat_id: string;
  creator_id: string;
  creator_name?: string | null;
  message: string;
  raw_date_phrase: string;
  scheduled_for: string;
  timezone: string;
  status: ReminderStatus;
  confirmation_message_id?: string | null;
  created_at?: string;
  updated_at?: string;
};

type SetlistRow = {
  id: string;
  chat_id: string;
  submitter_id: string;
  submitter_name?: string | null;
  kind: SetlistKind;
  week_start: string;
  content: string;
  status: "submitted" | "cancelled";
  expires_at?: string | null;
  broadcast_scheduled_for?: string | null;
  broadcast_sent_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

export class WorkflowRepository {
  public constructor(private readonly client: SupabaseClient = supabase) {}

  public async createReminder(input: Omit<ReminderRecord, "id">): Promise<ReminderRecord> {
    const { data, error } = await this.client
      .from("echo_reminders")
      .insert(toReminderRow(input))
      .select("*")
      .single();
    if (error) throw new Error(`Failed to create reminder: ${error.message}`);
    const reminder = fromReminderRow(data as ReminderRow);
    logData({ reminderId: reminder.id, status: reminder.status }, "Reminder persisted");
    return reminder;
  }

  public async updateReminder(id: string, updates: Partial<ReminderRecord>): Promise<ReminderRecord> {
    const { data, error } = await this.client
      .from("echo_reminders")
      .update(toReminderRowPartial(updates))
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(`Failed to update reminder: ${error.message}`);
    const reminder = fromReminderRow(data as ReminderRow);
    logData({ reminderId: reminder.id, status: reminder.status }, "Reminder updated");
    return reminder;
  }

  public async getReminder(id: string): Promise<ReminderRecord | null> {
    const { data, error } = await this.client.from("echo_reminders").select("*").eq("id", id).single();
    if (error) return null;
    return fromReminderRow(data as ReminderRow);
  }

  public async setReminderConfirmationMessageId(id: string, confirmationMessageId: string): Promise<ReminderRecord> {
    return this.updateReminder(id, { confirmationMessageId });
  }

  public async getReminderByConfirmationMessageId(confirmationMessageId: string): Promise<ReminderRecord | null> {
    const { data, error } = await this.client
      .from("echo_reminders")
      .select("*")
      .eq("confirmation_message_id", confirmationMessageId)
      .in("status", ["pending_confirmation", "pending_edit_confirmation", "pending_cancel_confirmation", "scheduled"])
      .maybeSingle();
    if (error || !data) return null;
    return fromReminderRow(data as ReminderRow);
  }

  public async getLatestReminderWorkflow(chatId: string, creatorId: string): Promise<ReminderRecord | null> {
    const { data, error } = await this.client
      .from("echo_reminders")
      .select("*")
      .eq("chat_id", chatId)
      .eq("creator_id", creatorId)
      .in("status", ["pending_confirmation", "pending_edit_confirmation", "pending_cancel_confirmation"])
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const reminder = fromReminderRow(data as ReminderRow);
    logData({ reminderId: reminder.id, status: reminder.status }, "Latest reminder workflow loaded");
    return reminder;
  }

  public async getLatestActiveReminder(chatId: string, creatorId: string): Promise<ReminderRecord | null> {
    const { data, error } = await this.client
      .from("echo_reminders")
      .select("*")
      .eq("chat_id", chatId)
      .eq("creator_id", creatorId)
      .in("status", ["pending_confirmation", "pending_edit_confirmation", "pending_cancel_confirmation", "scheduled"])
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const reminder = fromReminderRow(data as ReminderRow);
    logData({ reminderId: reminder.id, status: reminder.status }, "Latest active reminder loaded");
    return reminder;
  }

  public async getScheduledReminders(): Promise<ReminderRecord[]> {
    const { data, error } = await this.client.from("echo_reminders").select("*").eq("status", "scheduled");
    if (error) throw new Error(`Failed to load scheduled reminders: ${error.message}`);
    const reminders = ((data ?? []) as ReminderRow[]).map(fromReminderRow);
    logData({ count: reminders.length }, "Scheduled reminders loaded");
    return reminders;
  }

  public async getActiveWorkflowReminders(): Promise<ReminderRecord[]> {
    const { data, error } = await this.client
      .from("echo_reminders")
      .select("*")
      .in("status", ["pending_confirmation", "pending_edit_confirmation", "pending_cancel_confirmation"])
      .not("confirmation_message_id", "is", null);
    if (error) throw new Error(`Failed to load active reminder workflows: ${error.message}`);
    return ((data ?? []) as ReminderRow[]).map(fromReminderRow);
  }

  public async findDuplicateScheduledReminder(input: {
    chatId: string;
    creatorId: string;
    message: string;
    scheduledFor: string;
  }): Promise<ReminderRecord | null> {
    const { data, error } = await this.client
      .from("echo_reminders")
      .select("*")
      .eq("chat_id", input.chatId)
      .eq("creator_id", input.creatorId)
      .eq("message", input.message)
      .eq("scheduled_for", input.scheduledFor)
      .in("status", ["pending_confirmation", "scheduled"])
      .maybeSingle();
    if (error || !data) return null;
    const reminder = fromReminderRow(data as ReminderRow);
    logData({ reminderId: reminder.id }, "Duplicate reminder loaded");
    return reminder;
  }

  public async createSetlistSubmission(input: Omit<SetlistSubmissionRecord, "id">): Promise<SetlistSubmissionRecord> {
    const { data, error } = await this.client
      .from("echo_setlist_submissions")
      .insert(toSetlistRow(input))
      .select("*")
      .single();
    if (error) throw new Error(`Failed to create setlist workflow: ${error.message}`);
    const submission = fromSetlistRow(data as SetlistRow);
    logData({ submissionId: submission.id, status: submission.status }, "Setlist workflow persisted");
    return submission;
  }

  public async getSetlistSubmission(id: string): Promise<SetlistSubmissionRecord | null> {
    const { data, error } = await this.client
      .from("echo_setlist_submissions")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return null;
    return fromSetlistRow(data as SetlistRow);
  }

  public async updateSetlistSubmission(id: string, updates: Partial<SetlistSubmissionRecord>): Promise<SetlistSubmissionRecord> {
    const { data, error } = await this.client
      .from("echo_setlist_submissions")
      .update(toSetlistRowPartial(updates))
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(`Failed to update setlist workflow: ${error.message}`);
    const submission = fromSetlistRow(data as SetlistRow);
    logData({ submissionId: submission.id, status: submission.status }, "Setlist workflow updated");
    return submission;
  }

  public async getActiveSubmittedSetlists(): Promise<SetlistSubmissionRecord[]> {
    const { data, error } = await this.client
      .from("echo_setlist_submissions")
      .select("*")
      .eq("status", "submitted")
      .gt("expires_at", clockService.now().toISO());
    if (error) throw new Error(`Failed to load active submitted setlists: ${error.message}`);
    return ((data ?? []) as SetlistRow[]).map(fromSetlistRow);
  }

  public async getPendingSetlistBroadcasts(): Promise<SetlistSubmissionRecord[]> {
    const { data, error } = await this.client
      .from("echo_setlist_submissions")
      .select("*")
      .eq("status", "submitted")
      .not("broadcast_scheduled_for", "is", null)
      .is("broadcast_sent_at", null)
      .gt("expires_at", clockService.now().toISO());
    if (error) throw new Error(`Failed to load pending setlist broadcasts: ${error.message}`);
    return ((data ?? []) as SetlistRow[]).map(fromSetlistRow);
  }

  public async markSetlistBroadcastSent(id: string): Promise<SetlistSubmissionRecord> {
    return this.updateSetlistSubmission(id, { broadcastSentAt: clockService.now().toISO()! });
  }

  public async clearPendingSetlistBroadcast(id: string): Promise<void> {
    const { error } = await this.client
      .from("echo_setlist_submissions")
      .update({ broadcast_scheduled_for: null })
      .eq("id", id)
      .is("broadcast_sent_at", null);
    if (error) throw new Error(`Failed to retire pending setlist broadcast: ${error.message}`);
  }

  public async deleteExpiredSubmittedSetlists(): Promise<number> {
    const { data, error } = await this.client
      .from("echo_setlist_submissions")
      .delete()
      .eq("status", "submitted")
      .lte("expires_at", clockService.now().toISO())
      .select("id");
    if (error) throw new Error(`Failed to delete expired setlists: ${error.message}`);
    return data?.length ?? 0;
  }

  public async hasSubmittedSetlist(kind: SetlistKind, weekStart: string): Promise<boolean> {
    const acceptedKinds = kind === "setlist" ? ["setlist"] : [kind, "setlist"];
    const { data, error } = await this.client
      .from("echo_setlist_submissions")
      .select("id")
      .in("kind", acceptedKinds)
      .eq("week_start", weekStart)
      .eq("status", "submitted")
      .limit(1);
    if (error) return false;
    const submitted = (data?.length ?? 0) > 0;
    logData({ kind, weekStart, submitted }, "Setlist submission status checked");
    return submitted;
  }

  public async getSubmittedSetlist(kind: SetlistKind, weekStart: string): Promise<SetlistSubmissionRecord | null> {
    const { data, error } = await this.client
      .from("echo_setlist_submissions")
      .select("*")
      .eq("kind", kind)
      .eq("week_start", weekStart)
      .eq("status", "submitted")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return fromSetlistRow(data as SetlistRow);
  }

  public async getSubmittedSetlistsForWeek(weekStart: string): Promise<SetlistSubmissionRecord[]> {
    const { data, error } = await this.client
      .from("echo_setlist_submissions")
      .select("*")
      .eq("week_start", weekStart)
      .eq("status", "submitted")
      .order("updated_at", { ascending: false });
    if (error) throw new Error(`Failed to load submitted setlists for week: ${error.message}`);
    return ((data ?? []) as SetlistRow[]).map(fromSetlistRow);
  }

  /** Only one active row may own the week's eventual broadcast timer. */
  public async clearPendingSetlistBroadcasts(weekStart: string): Promise<void> {
    const { error } = await this.client
      .from("echo_setlist_submissions")
      .update({ broadcast_scheduled_for: null })
      .eq("week_start", weekStart)
      .eq("status", "submitted")
      .is("broadcast_sent_at", null);
    if (error) throw new Error(`Failed to clear pending setlist broadcasts: ${error.message}`);
  }

  /** A combined submission supersedes unfinished section rows for the same week. */
  public async cancelPartialSetlists(weekStart: string): Promise<void> {
    const { error } = await this.client
      .from("echo_setlist_submissions")
      .update({ status: "cancelled", broadcast_scheduled_for: null, updated_at: clockService.now().toISO() })
      .eq("week_start", weekStart)
      .eq("status", "submitted")
      .in("kind", ["worship", "praise"]);
    if (error) throw new Error(`Failed to supersede partial setlists: ${error.message}`);
  }
}

function fromReminderRow(row: ReminderRow): ReminderRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    creatorId: row.creator_id,
    creatorName: row.creator_name ?? undefined,
    message: row.message,
    rawDatePhrase: row.raw_date_phrase,
    scheduledFor: row.scheduled_for,
    timezone: row.timezone,
    status: row.status,
    confirmationMessageId: row.confirmation_message_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toReminderRow(input: Omit<ReminderRecord, "id">): Omit<ReminderRow, "id"> {
  return {
    chat_id: input.chatId,
    creator_id: input.creatorId,
    creator_name: input.creatorName,
    message: input.message,
    raw_date_phrase: input.rawDatePhrase,
    scheduled_for: input.scheduledFor,
    timezone: input.timezone,
    status: input.status,
    confirmation_message_id: input.confirmationMessageId,
  };
}

function toReminderRowPartial(input: Partial<ReminderRecord>): Partial<ReminderRow> {
  return stripUndefined({
    chat_id: input.chatId,
    creator_id: input.creatorId,
    creator_name: input.creatorName,
    message: input.message,
    raw_date_phrase: input.rawDatePhrase,
    scheduled_for: input.scheduledFor,
    timezone: input.timezone,
    status: input.status,
    confirmation_message_id: input.confirmationMessageId,
    updated_at: clockService.now().toISO()!,
  });
}

function fromSetlistRow(row: SetlistRow): SetlistSubmissionRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    submitterId: row.submitter_id,
    submitterName: row.submitter_name ?? undefined,
    kind: row.kind,
    weekStart: row.week_start,
    content: row.content,
    status: row.status,
    expiresAt: row.expires_at ?? undefined,
    broadcastScheduledFor: row.broadcast_scheduled_for ?? undefined,
    broadcastSentAt: row.broadcast_sent_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSetlistRow(input: Omit<SetlistSubmissionRecord, "id">): Omit<SetlistRow, "id"> {
  return {
    chat_id: input.chatId,
    submitter_id: input.submitterId,
    submitter_name: input.submitterName,
    kind: input.kind,
    week_start: input.weekStart,
    content: input.content,
    status: input.status,
    expires_at: input.expiresAt,
    broadcast_scheduled_for: input.broadcastScheduledFor,
    broadcast_sent_at: input.broadcastSentAt,
  };
}

function toSetlistRowPartial(input: Partial<SetlistSubmissionRecord>): Partial<SetlistRow> {
  return stripUndefined({
    chat_id: input.chatId,
    submitter_id: input.submitterId,
    submitter_name: input.submitterName,
    kind: input.kind,
    week_start: input.weekStart,
    content: input.content,
    status: input.status,
    expires_at: input.expiresAt,
    broadcast_scheduled_for: input.broadcastScheduledFor,
    broadcast_sent_at: input.broadcastSentAt,
    updated_at: clockService.now().toISO()!,
  });
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
