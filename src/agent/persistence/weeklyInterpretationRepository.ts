import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../../integrations/supabase/client.js";
import type { WeeklyInterpretation, WeeklyInterpretationRepository } from "../ports.js";
import { AGENT_TABLES } from "./tables.js";
import { clockService } from "../../shared/clockService.js";

interface InterpretationRow {
  id: string;
  week_start: string;
  source_hash: string;
  schedule_context: string;
  interpretation: WeeklyInterpretation["interpretation"];
  evaluated_at: string;
  expires_at: string;
}

export class SupabaseWeeklyInterpretationRepository implements WeeklyInterpretationRepository {
  public constructor(private readonly client: SupabaseClient = supabase) {}

  public async get(weekStart: string, sourceHash: string): Promise<WeeklyInterpretation | null> {
    const { data, error } = await this.client
      .from(AGENT_TABLES.weeklyInterpretations)
      .select("id, week_start, source_hash, schedule_context, interpretation, evaluated_at, expires_at")
      .eq("week_start", weekStart)
      .eq("source_hash", sourceHash)
      .gt("expires_at", clockService.now("Europe/London").toISO())
      .maybeSingle();
    if (error) throw new Error(`Could not load weekly interpretation: ${error.message}`);
    return data && hasScopedCancellationFields(data as InterpretationRow)
      ? fromRow(data as InterpretationRow)
      : null;
  }

  public async getLatest(weekStart: string): Promise<WeeklyInterpretation | null> {
    const { data, error } = await this.client
      .from(AGENT_TABLES.weeklyInterpretations)
      .select("id, week_start, source_hash, schedule_context, interpretation, evaluated_at, expires_at")
      .eq("week_start", weekStart)
      .gt("expires_at", clockService.now("Europe/London").toISO())
      .order("evaluated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Could not load latest weekly interpretation: ${error.message}`);
    return data && hasScopedCancellationFields(data as InterpretationRow)
      ? fromRow(data as InterpretationRow)
      : null;
  }

  public async save(input: Omit<WeeklyInterpretation, "id">): Promise<WeeklyInterpretation> {
    const { data, error } = await this.client
      .from(AGENT_TABLES.weeklyInterpretations)
      .upsert(
        {
          week_start: input.weekStart,
          source_hash: input.sourceHash,
          schedule_context: input.scheduleContext,
          interpretation: input.interpretation,
          evaluated_at: input.evaluatedAt,
          expires_at: input.expiresAt,
        },
        { onConflict: "week_start,source_hash" },
      )
      .select("id, week_start, source_hash, schedule_context, interpretation, evaluated_at, expires_at")
      .single();
    if (error) throw new Error(`Could not save weekly interpretation: ${error.message}`);
    return fromRow(data as InterpretationRow);
  }
}

/** Old broad-participation assessments are stale under the scoped policy. */
function hasScopedCancellationFields(row: InterpretationRow): boolean {
  return Object.prototype.hasOwnProperty.call(row.interpretation, "sundayActivityCancelled");
}

function fromRow(row: InterpretationRow): WeeklyInterpretation {
  const leaderNames = Array.isArray(row.interpretation.worshipPraiseLeaderNames)
    ? row.interpretation.worshipPraiseLeaderNames.filter((name): name is string => typeof name === "string")
    : [];
  return {
    id: row.id,
    weekStart: row.week_start,
    sourceHash: row.source_hash,
    scheduleContext: row.schedule_context,
    interpretation: { ...row.interpretation, worshipPraiseLeaderNames: leaderNames },
    evaluatedAt: row.evaluated_at,
    expiresAt: row.expires_at,
  };
}
