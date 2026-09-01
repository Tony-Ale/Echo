import type { PineconeStore } from "@langchain/pinecone";
import type { SheetsRepository } from "../../../integrations/googleSheets/sheetsRepository.js";
import { sha256 } from "../../../shared/utils/hash.js";
import {
  retrieveDocuments,
  type RetrievalProvenance,
} from "./retrievalService.js";
import { isRetrievalSourceId } from "./retrievalSources.js";
import { indexedDocumentSourceName } from "./retrievalSources.js";
import type { VectorRepository } from "../../../integrations/pinecone/vectorRepository.js";

/** Focused domain service for current choir evidence. Message composition belongs to the agent. */
export class ChoirIntelligenceService {
  public constructor(
    private readonly vectorStore: PineconeStore,
    private readonly sheets: SheetsRepository,
    private readonly vectors?: VectorRepository,
  ) {}

  public async retrieve(
    query: string,
    routing?: { sourceIds: string[]; semanticSearch: boolean; semanticResultLimit?: number },
  ): Promise<{ context: string; sourceHash: string; provenance: RetrievalProvenance }> {
    const selectedSourceIds = routing?.sourceIds.filter(isRetrievalSourceId) ?? [];
    const selection = {
      sourceIds: selectedSourceIds.length > 0 ? selectedSourceIds : ["semantic_knowledge" as const],
      semanticSearch: selectedSourceIds.length > 0 ? routing?.semanticSearch ?? false : true,
      semanticResultLimit: routing?.semanticResultLimit,
    };
    const { context, provenance } = await retrieveDocuments(
      query,
      this.sheets,
      this.vectorStore,
      selection,
    );
    return { context, sourceHash: sha256(context), provenance };
  }

  public async readIndexedSource(input: {
    sourceId: string;
    offset: number;
    limit: number;
  }): Promise<{
    sourceId: string;
    sourceName: string;
    documents: Array<{ content: string; metadata: Record<string, unknown> }>;
    nextOffset?: number;
    coverage: "complete" | "partial" | "none";
  }> {
    if (!this.vectors) throw new Error("Complete indexed-source retrieval is not configured.");
    if (!isRetrievalSourceId(input.sourceId)) throw new Error(`Unknown retrieval source '${input.sourceId}'.`);
    const sourceName = indexedDocumentSourceName(input.sourceId);
    if (!sourceName) throw new Error(`Source '${input.sourceId}' is not an indexed document.`);

    const page = await this.vectors.fetchDocumentsBySource({
      sourceName,
      offset: input.offset,
      limit: input.limit,
    });
    return {
      sourceId: input.sourceId,
      sourceName,
      documents: page.documents,
      nextOffset: page.nextOffset,
      coverage: page.documents.length === 0
        ? "none"
        : page.nextOffset !== undefined ? "partial" : "complete",
    };
  }
}
