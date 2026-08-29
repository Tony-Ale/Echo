import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { supabase } from "../../integrations/supabase/client.js";
import { clockService } from "../../shared/clockService.js";
import type { ScheduledAgentTaskRepository } from "../ports.js";
import type { AgentProcedureStep, RecurringSchedule, ScheduledAgentTask, ScheduledAgentTaskStatus } from "../types.js";
import { AGENT_TABLES } from "./tables.js";
import { agentConfig } from "../../config/agentConfig.js";

interface ScheduledTaskRow {
  id: string;
  natural_key: string;
  chat_id: string;
  owner_member_id: string;
  objective: string;
  raw_schedule_phrase: string;
  schedule: unknown;
  status: ScheduledAgentTaskStatus;
  next_run_at: string;
  procedure?: unknown;
  last_execution_key?: string | null;
  last_run_at?: string | null;
  last_success_at?: string | null;
  last_error?: string | null;
  created_at: string;
  updated_at: string;
}

const scheduleSchema = z.discriminatedUnion("frequency", [
  z.object({ frequency: z.literal("daily"), time: z.string(), timezone: z.string() }),
  z.object({ frequency: z.literal("weekly"), weekday: z.number().int().min(1).max(7), time: z.string(), timezone: z.string() }),
  z.object({ frequency: z.literal("monthly"), dayOfMonth: z.number().int().min(1).max(31), time: z.string(), timezone: z.string() }),
]);
const procedureSchema = z.array(z.object({ toolName: z.string(), input: z.record(z.unknown()) }))
  .max(agentConfig.reusableProcedures.maximumSteps);

export class SupabaseScheduledAgentTaskRepository implements ScheduledAgentTaskRepository {
  public constructor(private readonly client: SupabaseClient = supabase) {}

  public async create(input: {
    naturalKey: string;
    chatId: string;
    ownerMemberId: string;
    objective: string;
    rawSchedulePhrase: string;
    schedule: RecurringSchedule;
    nextRunAt: string;
  }): Promise<{ task: ScheduledAgentTask; created: boolean }> {
    const now = clockService.now().toISO();
    const { data, error } = await this.client
      .from(AGENT_TABLES.scheduledAgentTasks)
      .insert({
        natural_key: input.naturalKey,
        chat_id: input.chatId,
        owner_member_id: input.ownerMemberId,
        objective: input.objective,
        raw_schedule_phrase: input.rawSchedulePhrase,
        schedule: input.schedule,
        next_run_at: input.nextRunAt,
        status: "active",
        procedure: [],
        created_at: now,
        updated_at: now,
      })
      .select("*")
      .single();
    if (!error && data) return { task: fromRow(data as ScheduledTaskRow), created: true };
    if (error?.code !== "23505") throw new Error(`Could not create scheduled agent task: ${error?.message ?? "unknown error"}`);

    const { data: existing, error: existingError } = await this.client
      .from(AGENT_TABLES.scheduledAgentTasks)
      .select("*")
      .eq("natural_key", input.naturalKey)
      .in("status", ["active", "paused"])
      .maybeSingle();
    if (existingError || !existing) throw new Error(`Could not load duplicate scheduled agent task: ${existingError?.message ?? "not found"}`);
    return { task: fromRow(existing as ScheduledTaskRow), created: false };
  }

  public async get(id: string): Promise<ScheduledAgentTask | null> {
    const { data, error } = await this.client.from(AGENT_TABLES.scheduledAgentTasks).select("*").eq("id", id).maybeSingle();
    if (error || !data) return null;
    return fromRow(data as ScheduledTaskRow);
  }

  public async listActive(): Promise<ScheduledAgentTask[]> {
    const { data, error } = await this.client
      .from(AGENT_TABLES.scheduledAgentTasks)
      .select("*")
      .eq("status", "active")
      .order("next_run_at", { ascending: true });
    if (error) throw new Error(`Could not load scheduled agent tasks: ${error.message}`);
    return ((data ?? []) as ScheduledTaskRow[]).map(fromRow);
  }

  public async listOwned(ownerMemberId: string, chatId: string): Promise<ScheduledAgentTask[]> {
    const { data, error } = await this.client
      .from(AGENT_TABLES.scheduledAgentTasks)
      .select("*")
      .eq("owner_member_id", ownerMemberId)
      .eq("chat_id", chatId)
      .in("status", ["active", "paused"])
      .order("next_run_at", { ascending: true });
    if (error) throw new Error(`Could not load owned scheduled tasks: ${error.message}`);
    return ((data ?? []) as ScheduledTaskRow[]).map(fromRow);
  }

  public async updateOwned(
    id: string,
    ownerMemberId: string,
    updates: Partial<Pick<ScheduledAgentTask, "naturalKey" | "objective" | "rawSchedulePhrase" | "schedule" | "status" | "nextRunAt">>,
  ): Promise<ScheduledAgentTask | null> {
    const row: Record<string, unknown> = { updated_at: clockService.now().toISO() };
    if (updates.naturalKey !== undefined) row.natural_key = updates.naturalKey;
    if (updates.objective !== undefined) row.objective = updates.objective;
    if (updates.rawSchedulePhrase !== undefined) row.raw_schedule_phrase = updates.rawSchedulePhrase;
    if (updates.schedule !== undefined) row.schedule = updates.schedule;
    if (updates.status !== undefined) row.status = updates.status;
    if (updates.nextRunAt !== undefined) row.next_run_at = updates.nextRunAt;
    const { data, error } = await this.client
      .from(AGENT_TABLES.scheduledAgentTasks)
      .update(row)
      .eq("id", id)
      .eq("owner_member_id", ownerMemberId)
      .in("status", ["active", "paused"])
      .select("*")
      .maybeSingle();
    if (error || !data) return null;
    return fromRow(data as ScheduledTaskRow);
  }

  public async claimExecution(input: {
    id: string;
    executionKey: string;
    expectedRunAt?: string;
    nextRunAt: string;
  }): Promise<ScheduledAgentTask | null> {
    const { data, error } = await this.client.rpc("echo_claim_scheduled_agent_task", {
      p_task_id: input.id,
      p_execution_key: input.executionKey,
      p_expected_run_at: input.expectedRunAt ?? null,
      p_next_run_at: input.nextRunAt,
      p_now: clockService.now().toISO(),
    });
    if (error) throw new Error(`Could not claim scheduled agent task: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    return row ? fromRow(row as ScheduledTaskRow) : null;
  }

  public async recordExecution(input: {
    id: string;
    executionKey: string;
    procedure?: AgentProcedureStep[];
    succeeded: boolean;
    error?: string;
  }): Promise<void> {
    const now = clockService.now().toISO();
    const updates: Record<string, unknown> = {
      last_error: input.succeeded ? null : input.error ?? "Scheduled task execution failed.",
      updated_at: now,
    };
    if (input.succeeded) updates.last_success_at = now;
    if (input.procedure?.length) updates.procedure = input.procedure;
    const { error } = await this.client
      .from(AGENT_TABLES.scheduledAgentTasks)
      .update(updates)
      .eq("id", input.id)
      .eq("last_execution_key", input.executionKey);
    if (error) throw new Error(`Could not record scheduled agent task execution: ${error.message}`);
  }
}

function fromRow(row: ScheduledTaskRow): ScheduledAgentTask {
  return {
    id: row.id,
    naturalKey: row.natural_key,
    chatId: row.chat_id,
    ownerMemberId: row.owner_member_id,
    objective: row.objective,
    rawSchedulePhrase: row.raw_schedule_phrase,
    schedule: scheduleSchema.parse(row.schedule),
    status: row.status,
    nextRunAt: row.next_run_at,
    procedure: procedureSchema.catch([]).parse(row.procedure ?? []),
    lastExecutionKey: row.last_execution_key ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    lastSuccessAt: row.last_success_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
