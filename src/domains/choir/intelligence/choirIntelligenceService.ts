import type { PineconeStore } from "@langchain/pinecone";
import type { SheetsRepository } from "../../../integrations/googleSheets/sheetsRepository.js";
import { sha256 } from "../../../shared/utils/hash.js";
import {
  retrieveDocuments,
  type RetrievalProvenance,
} from "./retrievalService.js";
import { isRetrievalSourceId } from "./retrievalSources.js";

/** Focused domain service for current choir evidence. Message composition belongs to the agent. */
export class ChoirIntelligenceService {
  public constructor(
    private readonly vectorStore: PineconeStore,
    private readonly sheets: SheetsRepository,
  ) {}

  public async retrieve(
    query: string,
    routing?: { sourceIds: string[]; semanticSearch: boolean },
  ): Promise<{ context: string; sourceHash: string; provenance: RetrievalProvenance }> {
    const selectedSourceIds = routing?.sourceIds.filter(isRetrievalSourceId) ?? [];
    const selection = {
      sourceIds: selectedSourceIds.length > 0 ? selectedSourceIds : ["semantic_knowledge" as const],
      semanticSearch: selectedSourceIds.length > 0 ? routing?.semanticSearch ?? false : true,
    };
    const { context, provenance } = await retrieveDocuments(
      query,
      this.sheets,
      this.vectorStore,
      selection,
    );
    return { context, sourceHash: sha256(context), provenance };
  }
}
