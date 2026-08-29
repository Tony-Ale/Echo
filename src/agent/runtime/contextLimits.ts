import { agentConfig, approximateTokensToCharacters } from "../../config/agentConfig.js";

/**
 * Exact character caps derived from the human-facing approximate-token budgets.
 * Current user text is never truncated here.
 */
export const AGENT_CONTEXT_LIMITS = {
  plannerInputCharacters: approximateTokensToCharacters(agentConfig.context.plannerInputTokens),
  memoryBlockCharacters: approximateTokensToCharacters(agentConfig.context.memoryBlockTokens),
  memoryDirectoryDescriptionCharacters: approximateTokensToCharacters(
    agentConfig.context.memoryDirectory.descriptionTokens,
  ),
  plannerResponseMessageCharacters: approximateTokensToCharacters(
    agentConfig.planning.responseMessageTokens,
  ),
  plannerToolInputCharacters: approximateTokensToCharacters(agentConfig.planning.toolInputTokens),
  plannerReasonCharacters: approximateTokensToCharacters(agentConfig.planning.reasonTokens),
  plannerPlanItemCharacters: approximateTokensToCharacters(agentConfig.planning.planItemTokens),
  reusableProcedureInputCharacters: approximateTokensToCharacters(
    agentConfig.reusableProcedures.inputTokensPerStep,
  ),
  structuredEvidenceCharacters: approximateTokensToCharacters(agentConfig.retrieval.structuredEvidenceTokens),
  semanticEvidenceCharacters: approximateTokensToCharacters(agentConfig.retrieval.semanticEvidenceTokens),
  evidenceFieldCharacters: approximateTokensToCharacters(agentConfig.retrieval.fieldTokens),
  weeklyEvidenceCharacters: approximateTokensToCharacters(agentConfig.retrieval.weeklyEvidenceTokens),
  retainedToolResultCharacters: approximateTokensToCharacters(agentConfig.toolResults.retainedTokens),
  compactedToolResultCharacters: approximateTokensToCharacters(agentConfig.toolResults.compactedTokens),
  recentConversationCharacters: approximateTokensToCharacters(
    agentConfig.context.recentConversation.tokensPerMessage,
  ),
  historySearchMessageCharacters: approximateTokensToCharacters(
    agentConfig.context.historySearch.tokensPerMessage,
  ),
  memoryDirectoryEntries: agentConfig.context.memoryDirectory.maximumEntries,
  compactedMemoryDirectoryEntries: agentConfig.context.memoryDirectory.compactedEntries,
} as const;

export function estimateTokens(characters: number): number {
  return Math.ceil(
    Math.max(0, characters) / agentConfig.budgeting.approximateCharactersPerToken,
  );
}
