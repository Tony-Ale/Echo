import { Runnable, RunnableLambda, type RunnableConfig } from "@langchain/core/runnables";
import type { BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseLanguageModelInput, StructuredOutputMethodOptions } from "@langchain/core/language_models/base";
import type { infer as InferZod, ZodTypeAny } from "zod";
import { logger } from "../../config/logger.js";
import { clockService } from "../../shared/clockService.js";
import type {
  ChatModelEndpointConfig,
  ChatModelRole,
  ConfiguredChatModel,
  ModelFailoverConfiguration,
} from "../../framework/models/types.js";

export interface ModelEndpoint {
  config: ChatModelEndpointConfig;
  model: BaseChatModel;
}

interface EndpointHealth {
  consecutiveFailures: number;
  unavailableUntil: number;
}

/**
 * Ordered, bounded model failover. Only the failed model invocation is retried;
 * agent steps and tool side effects remain owned by the executor.
 */
export class ResilientChatModel extends Runnable<BaseLanguageModelInput, BaseMessage> implements ConfiguredChatModel {
  public readonly lc_namespace = ["echo", "models"];
  public readonly modelName: string;
  private readonly endpointHealth = new Map<string, EndpointHealth>();

  public constructor(
    public readonly role: ChatModelRole,
    private readonly endpoints: ModelEndpoint[],
    private readonly failover: ModelFailoverConfiguration,
  ) {
    super();
    if (endpoints.length === 0) throw new Error(`Model role '${role}' has no configured endpoints.`);
    this.modelName = endpoints.map(endpointLabel).join("|");
  }

  public invoke(input: BaseLanguageModelInput, options?: Partial<RunnableConfig>): Promise<BaseMessage> {
    return this.invokeWithFailover(
      (endpoint) => endpoint.model.invoke(input, options),
      options?.signal,
    );
  }

  public withStructuredOutput<Schema extends ZodTypeAny>(
    schema: Schema,
    config?: StructuredOutputMethodOptions<false>,
  ): Runnable<BaseLanguageModelInput, InferZod<Schema>> {
    return RunnableLambda.from(async (input: BaseLanguageModelInput, options?: RunnableConfig) =>
      this.invokeWithFailover(
        (endpoint) => endpoint.model.withStructuredOutput<InferZod<Schema>>(schema, config).invoke(input, options),
        options?.signal,
      ));
  }

  private async invokeWithFailover<T>(
    invoke: (endpoint: ModelEndpoint) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const available = this.availableEndpoints();
    if (available.length === 0) {
      throw new Error(`All endpoints for model role '${this.role}' are temporarily unavailable.`);
    }

    let lastError: unknown;
    for (let index = 0; index < available.length; index += 1) {
      const endpoint = available[index];
      if (signal?.aborted) throw signal.reason ?? new Error("Model invocation aborted.");
      try {
        const result = await invoke(endpoint);
        this.endpointHealth.delete(endpointKey(endpoint));
        logger.debug({ role: this.role, endpoint: endpointLabel(endpoint) }, "Model invocation completed");
        return result;
      } catch (error) {
        lastError = error;
        if (signal?.aborted || !isRetryableModelError(error)) throw error;
        const key = endpointKey(endpoint);
        const consecutiveFailures = (this.endpointHealth.get(key)?.consecutiveFailures ?? 0) + 1;
        const cooldownMs = calculateBackoffMs(consecutiveFailures, this.failover);
        this.endpointHealth.set(key, {
          consecutiveFailures,
          unavailableUntil: clockService.now().toMillis() + cooldownMs,
        });
        logger.warn(
          {
            role: this.role,
            endpoint: endpointLabel(endpoint),
            consecutiveFailures,
            cooldownMs,
            error: summarizeModelError(error),
          },
          index < available.length - 1 ? "Model endpoint failed; trying fallback" : "Model fallback chain exhausted",
        );
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private availableEndpoints(): ModelEndpoint[] {
    const now = clockService.now().toMillis();
    return this.endpoints.filter((endpoint) => (this.endpointHealth.get(endpointKey(endpoint))?.unavailableUntil ?? 0) <= now);
  }

}

/** First failure uses the initial cooldown; each consecutive failure doubles it. */
export function calculateBackoffMs(
  consecutiveFailures: number,
  configuration: ModelFailoverConfiguration,
): number {
  const exponential = configuration.initialCooldownMs * (2 ** Math.min(Math.max(consecutiveFailures - 1, 0), 30));
  return Math.min(exponential, configuration.maximumCooldownMs);
}

export function isRetryableModelError(error: unknown): boolean {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const status = numericStatus(record.status ?? record.statusCode ?? record.code) ?? numericStatus(message);
  if (status === 400 || status === 404 || status === 413 || status === 422) return false;
  if (status === 401 || status === 403 || status === 408 || status === 409 || status === 429 || (status !== null && status >= 500)) {
    return true;
  }
  return /rate.?limit|quota|timeout|timed out|connection|network|socket|econn|fetch failed|temporar/.test(message);
}

function numericStatus(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value);
  const match = typeof value === "string" ? value.match(/\b(4\d{2}|5\d{2})\b/) : null;
  return match ? Number(match[1]) : null;
}

function endpointKey(endpoint: ModelEndpoint): string {
  return `${endpoint.config.provider}:${endpoint.config.model}`;
}

function endpointLabel(endpoint: ModelEndpoint): string {
  return endpointKey(endpoint);
}

function summarizeModelError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}
