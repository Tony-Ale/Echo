import { logger } from "../../config/logger.js";

export interface AgentRuntimeMetric {
  kind: "planner" | "tool" | "turn";
  name: string;
  durationMs: number;
  eventKey?: string;
  inputCharacters?: number;
  estimatedInputTokens?: number;
  outputCharacters?: number;
  estimatedOutputTokens?: number;
  status?: string;
}

export interface AgentRuntimeTelemetry {
  record(metric: AgentRuntimeMetric): void;
}

/** Emits bounded structured measurements without retaining an in-process history. */
export class LoggingAgentRuntimeTelemetry implements AgentRuntimeTelemetry {
  public record(metric: AgentRuntimeMetric): void {
    logger.info({ agentMetric: metric }, "Agent runtime metric");
  }
}
