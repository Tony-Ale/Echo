import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../../integrations/supabase/client.js";
import { clockService } from "../../shared/clockService.js";
import type { MemoryRepository } from "../ports.js";
import type { MemberProfile, MemoryBlock, MemoryBlockDirectoryEntry } from "../types.js";
import { normalizeName } from "./identityRepository.js";
import { AGENT_TABLES } from "./tables.js";
import { agentConfig } from "../../config/agentConfig.js";
import { extractSearchTerms } from "./searchTerms.js";

interface BlockRow {
  id: string;
  scope_type: MemoryBlock["scopeType"];
  scope_id: string;
  label: string;
  description: string;
  value: string;
  character_limit: number;
  read_only: boolean;
  expires_at?: string | null;
  version: number;
}

/** Database-backed, bounded memory modelled after Letta memory blocks. */
export class SupabaseMemoryRepository implements MemoryRepository {
  public constructor(
    private readonly agentId: string,
    private readonly client: SupabaseClient = supabase,
  ) {
    if (!agentId.trim()) throw new Error("A memory repository requires an agent ID.");
  }

  public async getBlocks(input: { chatId?: string; memberId?: string; weekStart?: string }): Promise<MemoryBlock[]> {
    const scopes = blockScopes(input, this.agentId);
    const now = clockService.now().toISO();
    const { data, error } = await this.client
      .from(AGENT_TABLES.memoryBlocks)
      .select("id, scope_type, scope_id, label, description, value, character_limit, read_only, expires_at, version")
      .eq("agent_id", this.agentId)
      .or(scopes.join(","))
      .or(`expires_at.is.null,expires_at.gt.${now}`)
      .order("label");
    if (error) throw new Error(`Could not load agent memory: ${error.message}`);
    return ((data ?? []) as BlockRow[]).map(fromBlockRow);
  }

  public async getBlock(input: {
    scopeType: MemoryBlock["scopeType"];
    scopeId: string;
    label: string;
  }): Promise<MemoryBlock | null> {
    const now = clockService.now().toISO();
    const { data, error } = await this.client
      .from(AGENT_TABLES.memoryBlocks)
      .select("id, scope_type, scope_id, label, description, value, character_limit, read_only, expires_at, version")
      .eq("agent_id", this.agentId)
      .eq("scope_type", input.scopeType)
      .eq("scope_id", input.scopeId)
      .eq("label", input.label)
      .or(`expires_at.is.null,expires_at.gt.${now}`)
      .maybeSingle();
    if (error) throw new Error(`Could not load agent memory block: ${error.message}`);
    return data ? fromBlockRow(data as BlockRow) : null;
  }

  public async listBlockDirectory(input: {
    chatId?: string;
    memberId?: string;
    weekStart?: string;
  }): Promise<MemoryBlockDirectoryEntry[]> {
    const { data, error } = await this.client
      .from(AGENT_TABLES.memoryBlocks)
      .select("id, scope_type, scope_id, label, description, character_limit, read_only, expires_at, version")
      .eq("agent_id", this.agentId)
      .or(blockScopes(input, this.agentId).join(","))
      .or(`expires_at.is.null,expires_at.gt.${clockService.now().toISO()}`)
      .order("label");
    if (error) throw new Error(`Could not load the memory directory: ${error.message}`);
    return (data ?? []).map((row) => ({
      id: String(row.id),
      scopeType: row.scope_type as MemoryBlock["scopeType"],
      scopeId: String(row.scope_id),
      label: String(row.label),
      description: String(row.description),
      characterLimit: Number(row.character_limit),
      readOnly: Boolean(row.read_only),
      expiresAt: row.expires_at ? String(row.expires_at) : undefined,
      version: Number(row.version),
    }));
  }

  public async upsertBlock(input: Omit<MemoryBlock, "id" | "version"> & { id?: string }): Promise<MemoryBlock> {
    if (input.readOnly && input.id) {
      const { data: current } = await this.client
        .from(AGENT_TABLES.memoryBlocks)
        .select("read_only")
        .eq("id", input.id)
        .maybeSingle();
      if (current?.read_only) throw new Error(`Memory block '${input.label}' is read-only.`);
    }

    const value = input.value.slice(0, input.characterLimit);
    const row = {
      agent_id: this.agentId,
      scope_type: input.scopeType,
      scope_id: input.scopeId,
      label: input.label,
      description: input.description,
      value,
      character_limit: input.characterLimit,
      read_only: input.readOnly,
      expires_at: input.expiresAt ?? null,
      updated_at: clockService.now().toISO(),
    };
    const { data, error } = await this.client
      .from(AGENT_TABLES.memoryBlocks)
      .upsert(row, { onConflict: "agent_id,scope_type,scope_id,label" })
      .select("id, scope_type, scope_id, label, description, value, character_limit, read_only, expires_at, version")
      .single();
    if (error) throw new Error(`Could not save agent memory: ${error.message}`);
    return fromBlockRow(data as BlockRow);
  }

  public async getMemberFacts(memberId: string, limit: number, query?: string): Promise<string[]> {
    let request = this.client
      .from(AGENT_TABLES.memberFacts)
      .select("id, fact")
      .eq("member_id", memberId)
      .order("importance_rank", { ascending: false })
      .order("reinforcement_count", { ascending: false })
      .order("last_used_at", { ascending: false });
    const terms = query ? extractSearchTerms(query) : [];
    if (terms.length > 0) request = request.or(terms.map((term) => `fact.ilike.%${term}%`).join(","));
    const { data, error } = await request.limit(
      Math.max(1, Math.min(limit, agentConfig.context.memberMemory.maximumFacts)),
    );
    if (error) throw new Error(`Could not load member memory: ${error.message}`);
    const recalledIds = (data ?? []).map((row) => String(row.id));
    if (recalledIds.length > 0) {
      const { error: recallError } = await this.client
        .from(AGENT_TABLES.memberFacts)
        .update({ last_used_at: clockService.now().toISO() })
        .in("id", recalledIds);
      if (recallError) throw new Error(`Could not update recalled member memory: ${recallError.message}`);
    }
    return (data ?? []).map((row) => String(row.fact));
  }

  public async rememberMemberFact(input: {
    memberId: string;
    category: string;
    fact: string;
    sourceMessageId?: string;
    importance: "low" | "normal" | "high";
    verified: boolean;
  }): Promise<void> {
    const fact = input.fact.trim();
    if (!fact) throw new Error("A memory fact cannot be empty.");
    const now = clockService.now().toISO();
    const { error } = await this.client.rpc("echo_remember_member_fact", {
      p_member_id: input.memberId,
      p_category: input.category.trim().toLowerCase(),
      p_fact: fact.slice(0, 500),
      p_normalized_fact: normalizeName(fact),
      p_source_message_id: input.sourceMessageId ?? null,
      p_importance: input.importance,
      p_verified: input.verified,
      p_remembered_at: now,
      p_max_facts: agentConfig.context.memberMemory.maximumFacts,
    });
    if (error) throw new Error(`Could not save member memory: ${error.message}`);
  }

  public async updateMemberProfile(input: {
    memberId: string;
    transport: string;
    transportName?: string;
    preferredDisplayName?: string;
    aliases: string[];
  }): Promise<MemberProfile> {
    const { data, error } = await this.client.rpc("echo_update_member_profile", {
      p_member_id: input.memberId,
      p_transport: input.transport,
      p_transport_name: input.transportName?.trim() || null,
      p_preferred_display_name: input.preferredDisplayName?.trim() || null,
      p_aliases: input.aliases.map((alias) => alias.trim()).filter(Boolean),
      p_now: clockService.now().toISO(),
    });
    if (error) throw new Error(`Could not update member profile: ${error.message}`);
    return parseMemberProfile(data);
  }

  public async deleteBlock(input: { scopeType: MemoryBlock["scopeType"]; scopeId: string; label: string }): Promise<void> {
    const { error } = await this.client
      .from(AGENT_TABLES.memoryBlocks)
      .delete()
      .eq("agent_id", this.agentId)
      .eq("scope_type", input.scopeType)
      .eq("scope_id", input.scopeId)
      .eq("label", input.label);
    if (error) throw new Error(`Could not delete agent memory block: ${error.message}`);
  }

  public async pruneExpiredBlocks(): Promise<number> {
    const now = clockService.now().toISO();
    const { data: blocks, error: blockError } = await this.client
      .from(AGENT_TABLES.memoryBlocks)
      .delete()
      .eq("agent_id", this.agentId)
      .lte("expires_at", now)
      .select("id");
    if (blockError) throw new Error(`Could not prune memory blocks: ${blockError.message}`);
    return blocks?.length ?? 0;
  }
}

function parseMemberProfile(value: unknown): MemberProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Supabase returned an invalid member profile.");
  }
  const profile = value as Record<string, unknown>;
  const transportNames = profile.transportNames;
  return {
    preferredDisplayName: typeof profile.preferredDisplayName === "string" ? profile.preferredDisplayName : "Choir member",
    transportNames: transportNames && typeof transportNames === "object" && !Array.isArray(transportNames)
      ? Object.fromEntries(Object.entries(transportNames).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {},
    knownAliases: Array.isArray(profile.knownAliases)
      ? profile.knownAliases.filter((alias): alias is string => typeof alias === "string")
      : [],
  };
}

function fromBlockRow(row: BlockRow): MemoryBlock {
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    label: row.label,
    description: row.description,
    value: row.value,
    characterLimit: row.character_limit,
    readOnly: row.read_only,
    expiresAt: row.expires_at ?? undefined,
    version: row.version,
  };
}

function safeFilter(value: string): string {
  return value.replace(/[,.()]/g, "");
}

function blockScopes(input: { chatId?: string; memberId?: string; weekStart?: string }, agentId: string): string[] {
  const scopes = [`and(scope_type.eq.agent,scope_id.eq.${safeFilter(agentId)})`];
  if (input.chatId) scopes.push(`and(scope_type.eq.chat,scope_id.eq.${safeFilter(input.chatId)})`);
  if (input.memberId) scopes.push(`and(scope_type.eq.member,scope_id.eq.${safeFilter(input.memberId)})`);
  if (input.weekStart) scopes.push(`and(scope_type.eq.week,scope_id.eq.${safeFilter(input.weekStart)})`);
  return scopes;
}
