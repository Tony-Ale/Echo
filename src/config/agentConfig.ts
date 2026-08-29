import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { env } from "./env.js";

const tokenBudget = z.number().int().positive();
const agentConfigurationSchema = z.object({
  version: z.literal(1),
  execution: z.object({
    maxSteps: z.number().int().min(2).max(20),
    maxFailures: z.number().int().min(1).max(10),
    turnTimeoutMs: z.number().int().min(30_000).max(300_000),
  }),
  budgeting: z.object({
    approximateCharactersPerToken: z.number().int().min(2).max(8),
  }),
  context: z.object({
    plannerInputTokens: tokenBudget,
    memoryBlockTokens: tokenBudget,
    recentConversation: z.object({
      messageLimit: z.number().int().min(1).max(30),
      tokensPerMessage: tokenBudget,
    }),
    historySearch: z.object({
      defaultLimit: z.number().int().min(1).max(20),
      maximumLimit: z.number().int().min(1).max(20),
      tokensPerMessage: tokenBudget,
    }).refine(
      (value) => value.defaultLimit <= value.maximumLimit,
      "historySearch.defaultLimit must not exceed historySearch.maximumLimit",
    ),
    memoryDirectory: z.object({
      maximumEntries: z.number().int().positive(),
      compactedEntries: z.number().int().positive(),
      descriptionTokens: tokenBudget,
    }).refine(
      (value) => value.compactedEntries <= value.maximumEntries,
      "memoryDirectory.compactedEntries must not exceed memoryDirectory.maximumEntries",
    ),
    memberMemory: z.object({
      maximumFacts: z.number().int().positive(),
      defaultSearchLimit: z.number().int().positive(),
      maximumSearchLimit: z.number().int().positive(),
    }).refine(
      (value) => value.defaultSearchLimit <= value.maximumSearchLimit,
      "memberMemory.defaultSearchLimit must not exceed memberMemory.maximumSearchLimit",
    ),
  }),
  planning: z.object({
    responseMessageTokens: tokenBudget,
    toolInputTokens: tokenBudget,
    reasonTokens: tokenBudget,
    maximumPlanItems: z.number().int().positive(),
    planItemTokens: tokenBudget,
    maximumParallelContextRequests: z.number().int().min(1).max(10),
  }),
  reusableProcedures: z.object({
    maximumSteps: z.number().int().positive(),
    inputTokensPerStep: tokenBudget,
  }),
  toolResults: z.object({
    retainedTokens: tokenBudget,
    compactedTokens: tokenBudget,
  }).refine(
    (value) => value.compactedTokens <= value.retainedTokens,
    "toolResults.compactedTokens must not exceed toolResults.retainedTokens",
  ),
  retrieval: z.object({
    structuredEvidenceTokens: tokenBudget,
    semanticEvidenceTokens: tokenBudget,
    fieldTokens: tokenBudget,
    weeklyEvidenceTokens: tokenBudget,
  }),
});

export type AgentConfiguration = z.infer<typeof agentConfigurationSchema>;

/** Parses configuration text independently of filesystem loading for tests and tooling. */
export function parseAgentConfiguration(source: string): AgentConfiguration {
  return agentConfigurationSchema.parse(parse(source));
}

/** Loads and validates the single source of truth for agent runtime tuning. */
export function loadAgentConfiguration(configPath = env.AGENT_CONFIG_PATH): AgentConfiguration {
  const absolutePath = resolve(process.cwd(), configPath);
  let source: string;
  try {
    source = readFileSync(absolutePath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read agent configuration at '${absolutePath}'.`, { cause: error });
  }

  try {
    return parseAgentConfiguration(source);
  } catch (error) {
    throw new Error(`Agent configuration at '${absolutePath}' is invalid.`, { cause: error });
  }
}

export const agentConfig = deepFreeze(loadAgentConfiguration());

/** Converts human-facing approximate-token budgets into exact character caps. */
export function approximateTokensToCharacters(tokens: number): number {
  return tokens * agentConfig.budgeting.approximateCharactersPerToken;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
