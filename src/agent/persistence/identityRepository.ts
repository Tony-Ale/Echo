import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../../integrations/supabase/client.js";
import { clockService } from "../../shared/clockService.js";
import type { IdentityRepository } from "../ports.js";
import type { MemberIdentity, MemberRole } from "../types.js";
import type { ExternalIdentity } from "../../framework/contracts/messages.js";
import { AGENT_TABLES } from "./tables.js";

interface IdentifierRow {
  member_id: string;
  kind: "phone" | "whatsapp_jid" | "push_name" | "alias";
  value: string;
  normalized_value: string;
  verified: boolean;
}

interface MemberRow {
  id: string;
  canonical_name: string | null;
  display_name: string;
  status: "active" | "inactive";
}

export interface RuntimeIdentityRecord {
  id: string;
  canonicalName: string | null;
  displayName: string;
  phone?: string;
  whatsappJid?: string;
  roles: MemberRole[];
}

interface RoleRow {
  member_id: string;
  role: MemberRole;
}

interface CachedIdentity {
  identity: MemberIdentity;
  resolvedAt: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

/**
 * Resolves transport identifiers to canonical choir members.
 *
 * Phone numbers and JIDs are authoritative. Names can resolve references to a
 * member, but never identify the sender or select their private memory.
 */
export class SupabaseIdentityRepository implements IdentityRepository {
  private readonly cache = new Map<string, CachedIdentity>();

  public constructor(private readonly client: SupabaseClient = supabase) {}

  public clearCache(): void {
    this.cache.clear();
  }

  public async resolveSender(sender: ExternalIdentity): Promise<MemberIdentity | null> {
    const transportIdentifiers = Object.values(sender.identifiers).filter((value): value is string => Boolean(value));
    const authoritative = unique([
      normalizeIdentifier("whatsapp_jid", sender.id),
      normalizePhone(sender.id),
      ...transportIdentifiers.flatMap((value) => [normalizeIdentifier("whatsapp_jid", value), normalizePhone(value)]),
    ]).filter(Boolean);

    return this.resolveByIdentifiers(authoritative, true);
  }

  public async getById(memberId: string): Promise<MemberIdentity | null> {
    const [member] = await this.loadMembers([memberId]);
    return member?.status === "active" ? member : null;
  }

  public async resolveByName(name: string): Promise<MemberIdentity[]> {
    return (await this.resolveByNames([name]))[0]?.matches ?? [];
  }

  /** Resolves any number of names with a fixed set of database requests. */
  public async resolveByNames(names: string[]): Promise<Array<{ name: string; matches: MemberIdentity[] }>> {
    const requests = names.map((name) => ({ name, normalized: normalizeName(name) }));
    const normalizedNames = unique(requests.map((request) => request.normalized).filter(Boolean));
    if (normalizedNames.length === 0) return requests.map(({ name }) => ({ name, matches: [] }));

    const [{ data: identifierRows, error: identifierError }, { data: memberRows, error: memberError }] = await Promise.all([
      this.client
        .from(AGENT_TABLES.memberIdentifiers)
        .select("member_id, normalized_value")
        .in("kind", ["alias", "push_name"])
        .in("normalized_value", normalizedNames),
      this.client
        .from(AGENT_TABLES.members)
        .select("id, canonical_name, display_name, status")
        .eq("status", "active"),
    ]);
    if (identifierError) throw new Error(`Could not resolve member aliases: ${identifierError.message}`);
    if (memberError) throw new Error(`Could not resolve member names: ${memberError.message}`);

    const members = (memberRows ?? []) as MemberRow[];
    const aliases = (identifierRows ?? []).map((row) => ({
      memberId: String(row.member_id),
      normalizedValue: String(row.normalized_value),
    }));
    const candidateIds = unique(requests.flatMap((request) => [
      ...matchingMemberIds(members, request.normalized),
      ...aliases.filter((alias) => alias.normalizedValue === request.normalized).map((alias) => alias.memberId),
    ]));
    if (candidateIds.length === 0) return requests.map(({ name }) => ({ name, matches: [] }));

    const { data: roleRows, error: roleError } = await this.client
      .from(AGENT_TABLES.memberRoles)
      .select("member_id, role")
      .in("member_id", candidateIds);
    if (roleError) throw new Error(`Could not load member roles: ${roleError.message}`);
    const roles = (roleRows ?? []) as RoleRow[];
    const identities = new Map(members
      .filter((member) => candidateIds.includes(member.id))
      .map((member) => [member.id, toMemberIdentity(member, roles)]));

    return requests.map((request) => {
      const ids = unique([
        ...matchingMemberIds(members, request.normalized),
        ...aliases.filter((alias) => alias.normalizedValue === request.normalized).map((alias) => alias.memberId),
      ]);
      return { name: request.name, matches: ids.flatMap((id) => identities.get(id) ?? []) };
    });
  }

  public async getMentionTargets(memberIds: string[], transport: string, participantIds: string[] = []): Promise<string[]> {
    if (memberIds.length === 0) return [];
    // Local staging identifiers are opaque member references. They let the
    // real mention tool run without exposing phone numbers to the browser.
    if (transport === "local-chat") return memberIds.map((id) => `member:${id}`);
    if (transport !== "whatsapp") return [];
    const { data, error } = await this.client
      .from(AGENT_TABLES.memberIdentifiers)
      .select("member_id, kind, value, normalized_value, verified")
      .in("member_id", memberIds)
      .in("kind", ["phone", "whatsapp_jid"])
      .eq("verified", true);
    if (error) throw new Error(`Could not load member mentions: ${error.message}`);

    const identifiers = (data ?? []) as IdentifierRow[];
    const mentions: string[] = [];
    for (const memberId of memberIds) {
      const candidates = identifiers.filter((identifier) => identifier.member_id === memberId);
      const participant = participantIds.find((jid) =>
        candidates.some((candidate) => normalizePhone(jid) === normalizePhone(candidate.value)),
      );
      const jid = participant ?? candidates.find((candidate) => candidate.kind === "whatsapp_jid")?.value;
      const phone = candidates.find((candidate) => candidate.kind === "phone")?.normalized_value;
      const resolved = jid ?? (phone ? `${phone}@s.whatsapp.net` : undefined);
      if (resolved) mentions.push(resolved);
    }
    return unique(mentions);
  }

  public async addIdentifier(input: {
    memberId: string;
    kind: "phone" | "whatsapp_jid" | "push_name" | "alias";
    value: string;
    verified: boolean;
  }): Promise<void> {
    const normalizedValue = normalizeIdentifier(input.kind, input.value);
    if (!normalizedValue) throw new Error("Member identifier cannot be empty.");

    const { error } = await this.client.from(AGENT_TABLES.memberIdentifiers).upsert(
      {
        member_id: input.memberId,
        kind: input.kind,
        value: input.value.trim(),
        normalized_value: normalizedValue,
        verified: input.verified,
        updated_at: clockService.now().toISO(),
      },
      { onConflict: "kind,normalized_value" },
    );
    if (error) throw new Error(`Could not save member identifier: ${error.message}`);
    this.clearCache();
  }

  public async onboardSender(input: {
    sender: ExternalIdentity;
    transport: string;
    chatId: string;
  }): Promise<MemberIdentity> {
    const value = input.sender.identifiers.participantPhoneJid
      ?? input.sender.identifiers.phone
      ?? input.sender.identifiers.whatsappJid
      ?? input.sender.id;
    const kind = value.includes("@") ? "whatsapp_jid" : "phone";
    if (!normalizePhone(value)) throw new Error("The transport did not supply an authoritative sender identifier.");

    const { data, error } = await this.client.rpc("echo_onboard_group_member", {
      p_identifier_kind: kind,
      p_identifier_value: value,
      p_transport: input.transport,
      p_transport_name: input.sender.displayName?.trim() || null,
      p_chat_id: input.chatId,
      p_now: clockService.now().toISO(),
    });
    if (error) throw new Error(`Could not onboard group member: ${error.message}`);
    this.clearCache();
    const [member] = await this.loadMembers([String(data)]);
    if (!member) throw new Error("The onboarded member could not be reloaded.");
    return member;
  }

  public async setCanonicalName(input: {
    actorMemberId: string;
    memberId: string;
    canonicalName: string;
  }): Promise<void> {
    const { error } = await this.client.rpc("echo_set_member_canonical_name", {
      p_actor_member_id: input.actorMemberId,
      p_member_id: input.memberId,
      p_canonical_name: input.canonicalName.trim(),
      p_now: clockService.now().toISO(),
    });
    if (error) throw new Error(`Could not set canonical member name: ${error.message}`);
    this.clearCache();
  }

  /** Loads the small runtime snapshot used by deterministic domain services. */
  public async getRuntimeDirectorySnapshot(): Promise<RuntimeIdentityRecord[]> {
    const { data: memberRows, error: memberError } = await this.client
      .from(AGENT_TABLES.members)
      .select("id, canonical_name, display_name, status")
      .eq("status", "active");
    if (memberError) throw new Error(`Could not load member directory: ${memberError.message}`);
    const ids = (memberRows ?? []).map((row) => String(row.id));
    if (ids.length === 0) return [];
    const [{ data: identifiers, error: identifierError }, { data: roles, error: roleError }] = await Promise.all([
      this.client
        .from(AGENT_TABLES.memberIdentifiers)
        .select("member_id, kind, value, normalized_value, verified")
        .in("member_id", ids)
        .in("kind", ["phone", "whatsapp_jid"])
        .eq("verified", true),
      this.client.from(AGENT_TABLES.memberRoles).select("member_id, role").in("member_id", ids),
    ]);
    if (identifierError) throw new Error(`Could not load member identifiers: ${identifierError.message}`);
    if (roleError) throw new Error(`Could not load member roles: ${roleError.message}`);
    const identifierRows = (identifiers ?? []) as IdentifierRow[];
    const roleRows = (roles ?? []) as RoleRow[];
    return ((memberRows ?? []) as MemberRow[]).map((member) => ({
      id: member.id,
      canonicalName: member.canonical_name,
      displayName: member.display_name,
      phone: identifierRows.find((row) => row.member_id === member.id && row.kind === "phone")?.normalized_value,
      whatsappJid: identifierRows.find((row) => row.member_id === member.id && row.kind === "whatsapp_jid")?.value,
      roles: roleRows.filter((row) => row.member_id === member.id).map((row) => row.role),
    }));
  }

  private async resolveByIdentifiers(values: string[], authoritative: boolean): Promise<MemberIdentity | null> {
    this.pruneCache();
    const normalizedValues = unique(values.filter(Boolean));
    if (normalizedValues.length === 0) return null;
    const cacheKey = `${authoritative ? "a" : "f"}:${normalizedValues.join("|")}`;
    const cached = this.cache.get(cacheKey);
    if (cached && clockService.now().toMillis() - cached.resolvedAt < CACHE_TTL_MS) return cached.identity;

    let query = this.client
      .from(AGENT_TABLES.memberIdentifiers)
      .select("member_id, kind, value, normalized_value, verified")
      .in("normalized_value", normalizedValues);
    if (authoritative) query = query.in("kind", ["phone", "whatsapp_jid"]).eq("verified", true);

    const { data, error } = await query.limit(1).maybeSingle();
    if (error) throw new Error(`Could not resolve transport sender: ${error.message}`);
    if (!data) return null;

    const [identity] = await this.loadMembers([String(data.member_id)]);
    if (!identity || identity.status !== "active") return null;
    this.cache.set(cacheKey, { identity, resolvedAt: clockService.now().toMillis() });
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
    return identity;
  }

  private pruneCache(): void {
    const oldestAllowed = clockService.now().toMillis() - CACHE_TTL_MS;
    for (const [key, value] of this.cache) {
      if (value.resolvedAt <= oldestAllowed) this.cache.delete(key);
    }
  }

  private async loadMembers(ids: string[]): Promise<MemberIdentity[]> {
    if (ids.length === 0) return [];
    const [{ data: members, error: memberError }, { data: roles, error: roleError }] = await Promise.all([
      this.client.from(AGENT_TABLES.members).select("id, canonical_name, display_name, status").in("id", ids),
      this.client.from(AGENT_TABLES.memberRoles).select("member_id, role").in("member_id", ids),
    ]);
    if (memberError) throw new Error(`Could not load members: ${memberError.message}`);
    if (roleError) throw new Error(`Could not load member roles: ${roleError.message}`);

    const roleRows = (roles ?? []) as RoleRow[];
    return ((members ?? []) as MemberRow[]).map((member) => ({
      id: member.id,
      canonicalName: member.canonical_name,
      displayName: member.display_name,
      status: member.status,
      roles: unique(["member" as MemberRole, ...roleRows.filter((row) => row.member_id === member.id).map((row) => row.role)]),
    }));
  }
}

function matchingMemberIds(members: MemberRow[], normalizedName: string): string[] {
  return members.filter((member) =>
    normalizeName(member.canonical_name ?? "") === normalizedName
    || normalizeName(member.display_name) === normalizedName
  ).map((member) => member.id);
}

function toMemberIdentity(member: MemberRow, roles: RoleRow[]): MemberIdentity {
  return {
    id: member.id,
    canonicalName: member.canonical_name,
    displayName: member.display_name,
    status: member.status,
    roles: unique(["member" as MemberRole, ...roles.filter((row) => row.member_id === member.id).map((row) => row.role)]),
  };
}

export function normalizePhone(value: string): string {
  return value.split("@")[0].split(":")[0].replace(/\D/g, "");
}

export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function normalizeIdentifier(kind: "phone" | "whatsapp_jid" | "push_name" | "alias", value: string): string {
  return kind === "phone" || kind === "whatsapp_jid" ? normalizePhone(value) : normalizeName(value);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
