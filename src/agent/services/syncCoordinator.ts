import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";
import { supabase } from "../../integrations/supabase/client.js";
import type { SyncEngine } from "../../sync/syncEngine.js";
import { clockService } from "../../shared/clockService.js";
import type { SyncCoordinator } from "../ports.js";
import { AGENT_TABLES } from "../persistence/tables.js";

const SOURCE = "google_sheets";
const FRESH_FOR_HOURS = 24;
const LOCK_FOR_MINUTES = 10;

/** Coordinates inexpensive freshness checks and single-flight synchronization. */
export class SupabaseSyncCoordinator implements SyncCoordinator {
  private inFlight: Promise<Awaited<ReturnType<SyncCoordinator["syncIfStale"]>>> | null = null;

  public constructor(
    private readonly engine: SyncEngine,
    private readonly client: SupabaseClient = supabase,
  ) {}

  public syncIfStale(input: { reason: string; force?: boolean }): Promise<{
    synced: boolean;
    sourceChanged: boolean;
    sourceHash?: string;
    summary: string;
  }> {
    if (this.inFlight) return this.inFlight;
    const operation = this.run(input).finally(() => {
      if (this.inFlight === operation) this.inFlight = null;
    });
    this.inFlight = operation;
    return operation;
  }

  private async run(input: { reason: string; force?: boolean }) {
    const now = clockService.now("Europe/London");
    const { data: state, error: stateError } = await this.client
      .from(AGENT_TABLES.syncState)
      .select("source_hash, last_checked_at, last_successful_sync_at")
      .eq("source", SOURCE)
      .maybeSingle();
    if (stateError) throw new Error(`Could not read synchronization state: ${stateError.message}`);

    // Parsing a stored timestamp is deterministic; only "now" comes from ClockService.
    const lastChecked = state?.last_checked_at
      ? DateTime.fromISO(String(state.last_checked_at), { zone: "Europe/London" })
      : null;
    const checkedMillis = lastChecked?.isValid ? lastChecked.toMillis() : Number.NaN;
    const fresh = Number.isFinite(checkedMillis) && now.toMillis() - checkedMillis < FRESH_FOR_HOURS * 60 * 60_000;
    if (!input.force && fresh) {
      return {
        synced: false,
        sourceChanged: false,
        sourceHash: state?.source_hash ?? undefined,
        summary: "Google Sheets data is still fresh; synchronization was skipped.",
      };
    }

    const lockToken = randomUUID();
    const { data: acquired, error: lockError } = await this.client.rpc("echo_acquire_sync_lock", {
      p_source: SOURCE,
      p_lock_token: lockToken,
      p_lock_expires_at: now.plus({ minutes: LOCK_FOR_MINUTES }).toISO(),
    });
    if (lockError) throw new Error(`Could not acquire synchronization lock: ${lockError.message}`);
    if (!acquired) {
      return {
        synced: false,
        sourceChanged: false,
        sourceHash: state?.source_hash ?? undefined,
        summary: "Another synchronization is already running.",
      };
    }

    try {
      const result = await this.engine.run(false);
      const changed = result.inserted + result.updated + result.deleted > 0;
      const completedAt = clockService.now().toISO();
      const { error: updateError } = await this.client.from(AGENT_TABLES.syncState).upsert({
        source: SOURCE,
        source_hash: result.sourceHash ?? state?.source_hash ?? null,
        last_checked_at: completedAt,
        last_successful_sync_at: completedAt,
        last_error: null,
        warnings: result.duplicates ? [result.duplicates] : [],
        updated_at: completedAt,
      });
      if (updateError) throw new Error(`Could not update synchronization state: ${updateError.message}`);
      return {
        synced: true,
        sourceChanged: changed,
        sourceHash: result.sourceHash,
        summary: changed ? "Google Sheets changes were synchronized." : "Google Sheets was checked and no content changed.",
      };
    } catch (error) {
      await this.client.from(AGENT_TABLES.syncState).upsert({
        source: SOURCE,
        last_error: error instanceof Error ? error.message : String(error),
        updated_at: clockService.now().toISO(),
      });
      throw error;
    } finally {
      await this.client.rpc("echo_release_sync_lock", { p_source: SOURCE, p_lock_token: lockToken });
    }
  }
}
