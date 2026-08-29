import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { env } from "../../config/env.js";
import {
  CHAT_MODEL_ROLES,
  type ChatModelEndpointConfig,
  type ChatModelRole,
  type ChatProviderConfig,
  type ModelConfiguration,
} from "../../framework/models/types.js";

const providerSchema = z.object({
  id: z.string().trim().min(1),
  type: z.enum(["groq", "openai", "openrouter", "cohere"]),
  apiKeyEnv: z.string().trim().min(1),
  baseUrl: z.string().url().optional(),
  optional: z.boolean().default(false),
});
const endpointSchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
});
const rolesSchema = z.object(Object.fromEntries(
  CHAT_MODEL_ROLES.map((role) => [role, z.array(endpointSchema).min(1)]),
) as Record<ChatModelRole, z.ZodArray<typeof endpointSchema>>);
const embeddingsSchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  dimension: z.number().int().positive(),
  batchSize: z.number().int().positive().max(96).optional(),
});
const configurationSchema = z.object({
  version: z.literal(1),
  failover: z.object({
    initialCooldownMs: z.number().int().min(1_000).max(86_400_000),
    maximumCooldownMs: z.number().int().min(1_000).max(86_400_000),
  }).refine(
    (value) => value.maximumCooldownMs >= value.initialCooldownMs,
    "maximumCooldownMs must be greater than or equal to initialCooldownMs.",
  ),
  providers: z.array(providerSchema).min(1),
  embeddings: embeddingsSchema,
  roles: rolesSchema,
});

/** Loads the visible, versioned model map while keeping provider secrets in environment variables. */
export function loadModelConfiguration(configPath = env.AI_MODEL_CONFIG_PATH): ModelConfiguration {
  const absolutePath = resolve(process.cwd(), configPath);
  let source: string;
  try {
    source = readFileSync(absolutePath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read model configuration at '${absolutePath}'.`, { cause: error });
  }
  return parseModelConfiguration(source);
}

/** Exported separately so configuration behavior can be tested without filesystem or secrets. */
export function parseModelConfiguration(source: string): ModelConfiguration {
  let document: unknown;
  try {
    document = parse(source);
  } catch (error) {
    throw new Error("Model configuration must contain valid YAML.", { cause: error });
  }

  const parsed = configurationSchema.parse(document);
  const providers = availableProviders(parsed.providers);
  const providerIds = new Set(providers.map((provider) => provider.id));
  const roles = Object.fromEntries(CHAT_MODEL_ROLES.map((role) => [
    role,
    parsed.roles[role].filter((endpoint) => providerIds.has(endpoint.provider)),
  ])) as Record<ChatModelRole, ChatModelEndpointConfig[]>;

  validateConfiguration(providers, roles, parsed.embeddings.provider);
  return { providers, roles, embeddings: parsed.embeddings, failover: parsed.failover };
}

function availableProviders(providers: ChatProviderConfig[]): ChatProviderConfig[] {
  const providerIds = new Set<string>();
  return providers.filter((provider) => {
    if (providerIds.has(provider.id)) throw new Error(`Duplicate model provider ID '${provider.id}'.`);
    providerIds.add(provider.id);

    if (process.env[provider.apiKeyEnv]?.trim()) return true;
    if (provider.optional) return false;
    throw new Error(`Model provider '${provider.id}' requires environment variable ${provider.apiKeyEnv}.`);
  });
}

function validateConfiguration(
  providers: ChatProviderConfig[],
  roles: Record<ChatModelRole, ChatModelEndpointConfig[]>,
  embeddingProviderId: string,
): void {
  const providerIds = new Set(providers.map((provider) => provider.id));
  for (const role of CHAT_MODEL_ROLES) {
    if (roles[role].length === 0) {
      throw new Error(`Model role '${role}' has no available endpoint. Check its providers and API keys.`);
    }
    for (const endpoint of roles[role]) {
      if (!providerIds.has(endpoint.provider)) {
        throw new Error(`Model role '${role}' references unknown provider '${endpoint.provider}'.`);
      }
    }
  }

  const embeddingProvider = providers.find((provider) => provider.id === embeddingProviderId);
  if (!embeddingProvider) {
    throw new Error(`Embeddings reference unavailable provider '${embeddingProviderId}'.`);
  }
  if (embeddingProvider.type !== "cohere" && embeddingProvider.type !== "openai") {
    throw new Error(`Provider '${embeddingProviderId}' does not support embeddings.`);
  }
}
