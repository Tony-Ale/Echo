import { z } from "zod";
import { agentConfig } from "../../config/agentConfig.js";
import type { AgentActivityEvent, AgentTurnConstraints } from "../../agent/types.js";

export const stagingEvaluationSchema = z.object({
  allowedTools: z.array(z.string().trim().min(1).max(100)).min(1).max(50),
  maxSteps: z.number().int().min(2).max(agentConfig.execution.maxSteps).default(agentConfig.execution.maxSteps),
  includeRecentConversation: z.boolean().default(true),
  expectedTools: z.array(z.string().trim().min(1).max(100)).max(agentConfig.execution.maxSteps).default([]),
  expectedAnswerIncludes: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
});

export type StagingEvaluationInput = z.infer<typeof stagingEvaluationSchema>;

export interface StagingEvaluationResult {
  messageId: string;
  allowedTools: string[];
  actualTools: string[];
  maxSteps: number;
  includeRecentConversation: boolean;
  expectedTools: string[];
  expectedAnswerIncludes: string[];
  passed: boolean | null;
  issues: string[];
}

export function toTurnConstraints(input: StagingEvaluationInput): AgentTurnConstraints {
  return {
    allowedToolNames: input.allowedTools,
    maxSteps: input.maxSteps,
    includeRecentConversation: input.includeRecentConversation,
  };
}

/** Evaluates observable behaviour only; hidden reasoning is never judged or exposed. */
export function evaluateStagingRun(input: {
  messageId: string;
  eventKey: string;
  evaluation: StagingEvaluationInput;
  activity: AgentActivityEvent[];
  replyText?: string;
}): StagingEvaluationResult {
  const actualTools = input.activity
    // A planned tool may first activate a hidden capability and then be planned
    // again. Count execution starts so the evaluator reports what actually ran.
    .filter((event) => event.eventKey === input.eventKey && event.phase === "tool" && event.status === "started")
    .flatMap((event) => event.tool?.name ? [event.tool.name] : []);
  const issues: string[] = [];

  if (input.evaluation.expectedTools.length > 0 && !sameSequence(actualTools, input.evaluation.expectedTools)) {
    issues.push(`Expected tools: ${input.evaluation.expectedTools.join(" -> ")}; actual: ${actualTools.join(" -> ") || "none"}.`);
  }
  const normalizedReply = input.replyText?.toLocaleLowerCase() ?? "";
  for (const expected of input.evaluation.expectedAnswerIncludes) {
    if (!normalizedReply.includes(expected.toLocaleLowerCase())) {
      issues.push(`Response did not include '${expected}'.`);
    }
  }
  const hasExpectations = input.evaluation.expectedTools.length > 0 || input.evaluation.expectedAnswerIncludes.length > 0;
  return {
    messageId: input.messageId,
    allowedTools: input.evaluation.allowedTools,
    actualTools,
    maxSteps: input.evaluation.maxSteps,
    includeRecentConversation: input.evaluation.includeRecentConversation,
    expectedTools: input.evaluation.expectedTools,
    expectedAnswerIncludes: input.evaluation.expectedAnswerIncludes,
    passed: hasExpectations ? issues.length === 0 : null,
    issues,
  };
}

function sameSequence(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((tool, index) => tool === expected[index]);
}
