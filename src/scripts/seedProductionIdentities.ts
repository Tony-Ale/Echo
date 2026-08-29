import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { clockService } from "../shared/clockService.js";

const envFile = readArgument("--env-file") ?? ".env";
config({ path: envFile });

const identifierSchema = z.object({
  kind: z.enum(["phone", "whatsapp_jid", "push_name", "alias"]),
  value: z.string().trim().min(1),
  verified: z.boolean().default(false),
});

const memberSchema = z.object({
  canonicalName: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  status: z.enum(["active", "inactive"]).default("active"),
  identifiers: z.array(identifierSchema).min(1),
  roles: z.array(z.enum(["member", "superuser", "creator"])).min(1),
  profile: z.object({
    preferredDisplayName: z.string().trim().min(1).optional(),
    aliases: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
  }).optional(),
});

const seedSchema = z.object({ members: z.array(memberSchema).min(1) });

async function main(): Promise<void> {
  // An explicit CLI path lets the committed staging seed remain independent
  // from a developer's private production seed configuration.
  const seedPath = path.resolve(
    readArgument("--seed-file")
      ?? process.env.ECHO_IDENTITY_SEED_FILE
      ?? "seeds/identities.private.json",
  );
  const parsed = seedSchema.parse(JSON.parse(await readFile(seedPath, "utf8")));
  validateSeed(parsed.members);
  if (process.argv.includes("--validate-only")) {
    console.log(`Identity seed is valid: ${parsed.members.length} member(s).`);
    return;
  }

  const supabaseUrl = z.string().url().parse(process.env.SUPABASE_URL);
  const serviceRoleKey = z.string().min(1).parse(process.env.SUPABASE_KEY);

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  for (const member of parsed.members) {
    const roles = normalizeRoles(member.roles);
    const { data: memberId, error } = await client.rpc("echo_seed_member_identity", {
      p_canonical_name: member.canonicalName,
      p_display_name: member.displayName,
      p_status: member.status,
      p_identifiers: member.identifiers,
      p_roles: roles,
    });
    if (error) throw new Error(`Could not seed ${member.canonicalName}: ${error.message}`);
    const { error: profileError } = await client.rpc("echo_update_member_profile", {
      p_member_id: memberId,
      p_transport: "seed",
      p_transport_name: member.displayName,
      p_preferred_display_name: member.profile?.preferredDisplayName ?? member.displayName,
      p_aliases: member.profile?.aliases ?? [],
      p_now: clockService.now().toISO(),
    });
    if (profileError) throw new Error(`Could not initialize ${member.canonicalName}'s profile: ${profileError.message}`);
    console.log(`Seeded ${member.canonicalName} (${roles.join(", ")})`);
  }
  console.log(`Identity seed complete: ${parsed.members.length} member(s).`);
}

function validateSeed(members: Array<z.infer<typeof memberSchema>>): void {
  if (!members.some((member) => member.roles.includes("creator"))) {
    throw new Error("The production identity seed must contain at least one creator.");
  }
  if (!members.some((member) => member.roles.includes("superuser") || member.roles.includes("creator"))) {
    throw new Error("The production identity seed must contain at least one superuser.");
  }
  for (const member of members) {
    if (!member.roles.some((role) => role === "creator" || role === "superuser")) continue;
    const hasVerifiedTransportId = member.identifiers.some(
      (identifier) => identifier.verified && (identifier.kind === "phone" || identifier.kind === "whatsapp_jid"),
    );
    if (!hasVerifiedTransportId) {
      throw new Error(`${member.canonicalName} needs a verified phone or WhatsApp JID for privileged access.`);
    }
  }
}

function normalizeRoles(roles: Array<"member" | "superuser" | "creator">): string[] {
  const normalized = new Set(roles);
  normalized.add("member");
  if (normalized.has("creator")) normalized.add("superuser");
  return [...normalized];
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
