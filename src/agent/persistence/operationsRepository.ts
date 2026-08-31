import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../../integrations/supabase/client.js";
import { clockService } from "../../shared/clockService.js";
import type { AgentJournal, ConversationRepository, ObligationRepository } from "../ports.js";
import type {
  AgentEvent,
  AgentObligation,
  AgentTurnResult,
  ConversationEntry,
  ObligationStatus,
} from "../types.js";
import { AGENT_TABLES } from "./tables.js";
import { extractSearchTerms, takeDistinctSearchResults } from "./searchTerms.js";

interface ObligationRow {
  id: string;
  natural_key: string;
  type: string;
  chat_id: string;
  week_start?: string | null;
  assigned_member_ids?: string[] | null;
  status: ObligationStatus;
  due_at?: string | null;
  payload?: Record<string, unknown> | null;
  source_hash?: string | null;
  last_evaluated_at?: string | null;
}

export class SupabaseObligationRepository implements ObligationRepository {
  public constructor(private readonly client: SupabaseClient = supabase) {}

  public async listActive(chatId?: string): Promise<AgentObligation[]> {
    let query = this.client
      .from(AGENT_TABLES.obligations)
      .select("id, natural_key, type, chat_id, week_start, assigned_member_ids, status, due_at, payload, source_hash, last_evaluated_at")
      .in("status", ["pending", "waiting_for_data", "waiting_for_member"])
      .order("due_at", { ascending: true });
    if (chatId) query = query.eq("chat_id", chatId);
    const { data, error } = await query;
    if (error) throw new Error(`Could not load active obligations: ${error.message}`);
    return ((data ?? []) as ObligationRow[]).map(fromObligationRow);
  }

  public async upsert(input: Omit<AgentObligation, "id">): Promise<AgentObligation> {
    const { data, error } = await this.client
      .from(AGENT_TABLES.obligations)
      .upsert(
        {
          natural_key: input.naturalKey,
          type: input.type,
          chat_id: input.chatId,
          week_start: input.weekStart ?? null,
          assigned_member_ids: input.assignedMemberIds,
          status: input.status,
          due_at: input.dueAt ?? null,
          payload: input.payload,
          source_hash: input.sourceHash ?? null,
          last_evaluated_at: input.lastEvaluatedAt ?? null,
          updated_at: clockService.now().toISO(),
        },
        { onConflict: "natural_key" },
      )
      .select("id, natural_key, type, chat_id, week_start, assigned_member_ids, status, due_at, payload, source_hash, last_evaluated_at")
      .single();
    if (error) throw new Error(`Could not save obligation: ${error.message}`);
    return fromObligationRow(data as ObligationRow);
  }

  public async updateStatus(id: string, status: ObligationStatus, reason?: string): Promise<AgentObligation> {
    const now = clockService.now().toISO();
    const { data: existing, error: readError } = await this.client
      .from(AGENT_TABLES.obligations)
      .select("payload")
      .eq("id", id)
      .single();
    if (readError) throw new Error(`Could not load obligation: ${readError.message}`);
    const payload = { ...((existing?.payload ?? {}) as Record<string, unknown>), ...(reason ? { statusReason: reason } : {}) };
    const completed = ["satisfied", "not_applicable", "cancelled"].includes(status);
    const { data, error } = await this.client
      .from(AGENT_TABLES.obligations)
      .update({
        status,
        payload,
        last_evaluated_at: now,
        completed_at: completed ? now : null,
        updated_at: now,
      })
      .eq("id", id)
      .select("id, natural_key, type, chat_id, week_start, assigned_member_ids, status, due_at, payload, source_hash, last_evaluated_at")
      .single();
    if (error) throw new Error(`Could not update obligation: ${error.message}`);
    return fromObligationRow(data as ObligationRow);
  }
}

export class SupabaseConversationRepository implements ConversationRepository {
  public constructor(private readonly client: SupabaseClient = supabase) {}

  public async append(input: {
    externalMessageId?: string;
    chatId: string;
    memberId?: string;
    role: ConversationEntry["role"];
    content: string;
    quotedExternalMessageId?: string;
    senderName?: string;
  }): Promise<void> {
    const { error } = await this.client.from(AGENT_TABLES.conversationMessages).upsert(
      {
        external_message_id: input.externalMessageId ?? null,
        chat_id: input.chatId,
        member_id: input.memberId ?? null,
        role: input.role,
        content: input.content,
        quoted_external_message_id: input.quotedExternalMessageId ?? null,
        sender_name_snapshot: input.senderName?.trim() || null,
        created_at: clockService.now().toISO(),
      },
      { onConflict: "chat_id,external_message_id", ignoreDuplicates: true },
    );
    if (error) throw new Error(`Could not save conversation message: ${error.message}`);
  }

  public async getRecent(chatId: string, limit: number): Promise<ConversationEntry[]> {
    const { data, error } = await this.client
      .from(AGENT_TABLES.conversationMessages)
      .select("role, content, created_at, sender_name_snapshot, echo_members(display_name)")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: false })
      .limit(Math.max(1, Math.min(limit, 30)));
    if (error) throw new Error(`Could not load conversation history: ${error.message}`);
    return (data ?? []).reverse().map(fromConversationRow);
  }

  public async search(chatId: string, query: string, limit: number, excludeExternalMessageId?: string): Promise<ConversationEntry[]> {
    const terms = extractSearchTerms(query);
    if (terms.length === 0) return [];
    const filters = terms.map((term) => `content.ilike.%${term}%`).join(",");
    let request = this.client
      .from(AGENT_TABLES.conversationMessages)
      .select("role, content, created_at, sender_name_snapshot, echo_members(display_name)")
      .eq("chat_id", chatId)
      .or(filters)
      .order("created_at", { ascending: false });
    if (excludeExternalMessageId) request = request.neq("external_message_id", excludeExternalMessageId);
    const boundedLimit = Math.max(1, Math.min(limit, 20));
    const candidateLimit = Math.min(20, boundedLimit * 4);
    const { data, error } = await request.limit(candidateLimit);
    if (error) throw new Error(`Could not search conversation history: ${error.message}`);
    const distinct = takeDistinctSearchResults(
      (data ?? []).map(fromConversationRow),
      (entry) => `${entry.role}|${entry.senderName ?? ""}|${entry.content}`,
      boundedLimit,
    );
    return distinct.reverse();
  }
}

/** Durable event and tool journal used for recovery, observability and idempotency. */
export class SupabaseAgentJournal implements AgentJournal {
  public constructor(private readonly client: SupabaseClient = supabase) {}

  /** Retires journal rows left open by a process interruption before startup. */
  public async recoverInterruptedExecutions(cutoffIso: string): Promise<{
    events: number;
    turns: number;
    tools: number;
  }> {
    const completedAt = clockService.now().toISO();
    const reason = "interrupted_before_completion";
    const [tools, turns, events] = await Promise.all([
      this.client
        .from(AGENT_TABLES.toolExecutions)
        .update({ status: "error", error: reason, completed_at: completedAt })
        .eq("status", "running")
        .lte("started_at", cutoffIso)
        .select("id"),
      this.client
        .from(AGENT_TABLES.turns)
        .update({ status: "failed", completed_at: completedAt })
        .eq("status", "running")
        .lte("started_at", cutoffIso)
        .select("id"),
      this.client
        .from(AGENT_TABLES.events)
        .update({ status: "failed", error: reason, completed_at: completedAt })
        .eq("status", "running")
        .lte("received_at", cutoffIso)
        .select("id"),
    ]);
    if (tools.error) throw new Error(`Could not recover interrupted tool executions: ${tools.error.message}`);
    if (turns.error) throw new Error(`Could not recover interrupted agent turns: ${turns.error.message}`);
    if (events.error) throw new Error(`Could not recover interrupted agent events: ${events.error.message}`);
    return {
      tools: tools.data?.length ?? 0,
      turns: turns.data?.length ?? 0,
      events: events.data?.length ?? 0,
    };
  }

  public async beginEvent(event: AgentEvent, actorMemberId?: string): Promise<{ eventId: string; duplicateResult?: AgentTurnResult }> {
    const { data: existing, error: existingError } = await this.client
      .from(AGENT_TABLES.events)
      .select("id, status, result")
      .eq("event_key", event.eventKey)
      .maybeSingle();
    if (existingError) throw new Error(`Could not check agent event: ${existingError.message}`);
    if (existing) {
      return {
        eventId: String(existing.id),
        duplicateResult: existing.status === "completed" || existing.status === "deferred"
          ? existing.result as AgentTurnResult
          : undefined,
      };
    }

    const { data, error } = await this.client
      .from(AGENT_TABLES.events)
      .insert({
        event_key: event.eventKey,
        source: event.source,
        type: event.type,
        chat_id: event.chatId ?? null,
        actor_member_id: actorMemberId ?? null,
        status: "received",
        payload: event.payload,
        received_at: clockService.now().toISO(),
      })
      .select("id")
      .single();
    if (error) throw new Error(`Could not create agent event: ${error.message}`);
    return { eventId: String(data.id) };
  }

  public async beginTurn(eventId: string, model: string): Promise<string> {
    const now = clockService.now().toISO();
    const { data, error } = await this.client
      .from(AGENT_TABLES.turns)
      .insert({ event_id: eventId, model, status: "running", started_at: now })
      .select("id")
      .single();
    if (error) throw new Error(`Could not create agent turn: ${error.message}`);
    await this.client.from(AGENT_TABLES.events).update({ status: "running" }).eq("id", eventId);
    return String(data.id);
  }

  public async recordToolExecution(input: {
    turnId: string;
    step: number;
    toolName: string;
    idempotencyKey: string;
    arguments: Record<string, unknown>;
    status: "running" | "success" | "error" | "denied" | "approval_required";
    result?: unknown;
    error?: string;
  }): Promise<void> {
    const now = clockService.now().toISO();
    const { error } = await this.client.from(AGENT_TABLES.toolExecutions).upsert(
      {
        turn_id: input.turnId,
        step: input.step,
        tool_name: input.toolName,
        idempotency_key: input.idempotencyKey,
        arguments: input.arguments,
        status: input.status,
        result: input.result ?? null,
        error: input.error ?? null,
        completed_at: input.status === "running" ? null : now,
      },
      { onConflict: "idempotency_key" },
    );
    if (error) throw new Error(`Could not record tool execution: ${error.message}`);
  }

  public async completeTurn(turnId: string, result: AgentTurnResult): Promise<void> {
    const now = clockService.now().toISO();
    const { data: turn, error: turnReadError } = await this.client
      .from(AGENT_TABLES.turns)
      .select("event_id")
      .eq("id", turnId)
      .single();
    if (turnReadError) throw new Error(`Could not load agent turn: ${turnReadError.message}`);
    const turnStatus = result.status === "max_steps" ? "max_steps" : result.status === "failed" ? "failed" : "completed";
    const eventStatus = result.status === "deferred" ? "deferred" : result.status === "failed" || result.status === "max_steps" ? "failed" : "completed";
    const { error: turnError } = await this.client
      .from(AGENT_TABLES.turns)
      .update({
        status: turnStatus,
        step_count: result.steps.length,
        final_message: result.reply?.text ?? null,
        completed_at: now,
      })
      .eq("id", turnId);
    if (turnError) throw new Error(`Could not complete agent turn: ${turnError.message}`);
    const { error: eventError } = await this.client
      .from(AGENT_TABLES.events)
      .update({ status: eventStatus, result, completed_at: now, error: result.error ?? null })
      .eq("id", turn.event_id);
    if (eventError) throw new Error(`Could not complete agent event: ${eventError.message}`);
  }

  public async failTurn(turnId: string, _error: string): Promise<void> {
    const { error: updateError } = await this.client
      .from(AGENT_TABLES.turns)
      .update({ status: "failed", final_message: null, completed_at: clockService.now().toISO() })
      .eq("id", turnId);
    if (updateError) throw new Error(`Could not fail agent turn: ${updateError.message}`);
  }

  public async failEvent(eventId: string, error: string): Promise<void> {
    const { error: updateError } = await this.client
      .from(AGENT_TABLES.events)
      .update({ status: "failed", error, completed_at: clockService.now().toISO() })
      .eq("id", eventId);
    if (updateError) throw new Error(`Could not fail agent event: ${updateError.message}`);
  }
}

function fromObligationRow(row: ObligationRow): AgentObligation {
  return {
    id: row.id,
    naturalKey: row.natural_key,
    type: row.type,
    chatId: row.chat_id,
    weekStart: row.week_start ?? undefined,
    assignedMemberIds: row.assigned_member_ids ?? [],
    status: row.status,
    dueAt: row.due_at ?? undefined,
    payload: row.payload ?? {},
    sourceHash: row.source_hash ?? undefined,
    lastEvaluatedAt: row.last_evaluated_at ?? undefined,
  };
}

function fromConversationRow(row: Record<string, unknown>): ConversationEntry {
  const member = row.echo_members as { display_name?: string } | null;
  return {
    role: row.role as ConversationEntry["role"],
    content: String(row.content),
    createdAt: String(row.created_at),
    senderName: String(row.sender_name_snapshot ?? member?.display_name ?? "") || undefined,
  };
}
