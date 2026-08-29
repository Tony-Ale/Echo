import { ChatPromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import type { ConfiguredChatModel } from "../framework/models/types.js";
import { logData } from "../logger/execLogger.js";
import { DATE_PHRASE_NORMALIZATION_PROMPT } from "../prompts/domains/choir/temporalNormalization.js";

export const datePhraseFallbackSchema = z.object({
  normalizedDatePhrase: z.string().nullable().describe(
    "A clearer raw natural-language date phrase, or null when clarification is required. Never output an ISO timestamp.",
  ),
  needsClarification: z.boolean(),
  clarificationQuestion: z.string().nullable(),
});

export type DatePhraseFallbackExtraction = z.infer<typeof datePhraseFallbackSchema>;

/** Semantic fallback only; deterministic date parsing remains authoritative. */
export class TemporalPhraseService {
  public constructor(private readonly model: ConfiguredChatModel) {}

  public async normalizeForParser(input: {
    rawDatePhrase: string;
    currentUkDateTime: string;
  }): Promise<DatePhraseFallbackExtraction> {
    const prompt = ChatPromptTemplate.fromMessages([
      ["system", DATE_PHRASE_NORMALIZATION_PROMPT],
      ["user", "Current UK date/time: {currentUkDateTime}\nUser date phrase: {rawDatePhrase}"],
    ]);
    const response = await prompt.pipe(this.model.withStructuredOutput(datePhraseFallbackSchema)).invoke(input);
    logData({ input, response }, "LLM date phrase fallback normalization completed");
    return response;
  }
}
