import type { BaseMessage } from "@langchain/core/messages";
import type { BaseLanguageModelInput, StructuredOutputMethodOptions } from "@langchain/core/language_models/base";
import type { Runnable } from "@langchain/core/runnables";
import type { infer as InferZod, ZodTypeAny } from "zod";

export const CHAT_MODEL_ROLES = [
  "planner",
  "fast",
  "extraction",
] as const;

export type ChatModelRole = typeof CHAT_MODEL_ROLES[number];
export type ChatProviderType = "groq" | "openai" | "openrouter" | "cohere";

export interface ChatProviderConfig {
  id: string;
  type: ChatProviderType;
  /** Environment variable containing the secret. Secrets never enter role config. */
  apiKeyEnv: string;
  baseUrl?: string;
  /** Optional providers are ignored when their API-key environment variable is absent. */
  optional?: boolean;
}

export interface ChatModelEndpointConfig {
  provider: string;
  model: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

export interface ChatModelConfiguration {
  providers: ChatProviderConfig[];
  roles: Record<ChatModelRole, ChatModelEndpointConfig[]>;
  failover: ModelFailoverConfiguration;
}

export interface ModelFailoverConfiguration {
  initialCooldownMs: number;
  maximumCooldownMs: number;
}

export interface EmbeddingModelConfiguration {
  provider: string;
  model: string;
  dimension: number;
  batchSize?: number;
}

export interface ModelConfiguration extends ChatModelConfiguration {
  embeddings: EmbeddingModelConfiguration;
}

/** Provider-neutral model consumed by planners and model-backed services. */
export interface ConfiguredChatModel extends Runnable<BaseLanguageModelInput, BaseMessage> {
  readonly role: ChatModelRole;
  readonly modelName: string;
  withStructuredOutput<Schema extends ZodTypeAny>(
    schema: Schema,
    config?: StructuredOutputMethodOptions<false>,
  ): Runnable<BaseLanguageModelInput, InferZod<Schema>>;
}

export interface ChatModelResolver {
  get(role: ChatModelRole): ConfiguredChatModel;
}
