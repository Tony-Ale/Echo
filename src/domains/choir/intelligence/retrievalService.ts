import { addTemporalContext } from "./temporalQuery.js";
import type { SheetsRepository } from "../../../integrations/googleSheets/sheetsRepository.js";
import type { PineconeStore } from "@langchain/pinecone";
import { buildSheetDescriptionsJSON, formatDocumentsForLLM } from "./helpers.js";
import { logData } from "../../../logger/execLogger.js";
import {
    resolveRetrievalSources,
    retrievalSourceDescription,
    type RetrievalSourceId,
} from "./retrievalSources.js";
import {
    evidenceMatchesTemporalWindow,
    projectStructuredEvidence,
    projectTextEvidence,
} from "./evidenceProjector.js";
import { compactEvidence, type EvidenceCompactionReport } from "./evidenceCompactor.js";
import { clockService } from "../../../shared/clockService.js";
import { sha256 } from "../../../shared/utils/hash.js";

export interface RetrievalSourceSelection {
    sourceIds: RetrievalSourceId[];
    semanticSearch: boolean;
}

export interface RetrievalProvenance {
    selectedSources: RetrievalSourceId[];
    retrievedSources: RetrievalSourceId[];
    missingSources: RetrievalSourceId[];
    sheetNames: string[];
    semanticSearchUsed: boolean;
    fallbackUsed: boolean;
    coverage: "complete" | "partial" | "none";
    absenceIsEvidence: false;
    retrievedAt: string;
    temporalScope: Array<{ phrase: string; date: string; endDate?: string }>;
    temporalCoverage: "not_requested" | "matched" | "unmatched";
    compaction: EvidenceCompactionReport;
}


export async function retrieveDocuments(
    userQuery: string,
    sheetRepository: SheetsRepository,
    vectordb: PineconeStore,
    selection: RetrievalSourceSelection,
) {
    // The central planner owns semantic query/source selection. Retrieval owns
    // deterministic temporal resolution and evidence handling only.
    const { query, temporalData, augmentedQuery } = addTemporalContext(userQuery)
    logData(augmentedQuery, "check if time data and add temporal context if required")
    logData(selection, "Planner-selected retrieval sources")

    const resolved = resolveRetrievalSources(
        selection.sourceIds,
        temporalData.map((item) => item.date_equivalent),
    )
    const semanticInitiallyRequired = selection.semanticSearch || resolved.unresolvedSources.length > 0
    const semanticPromise = semanticInitiallyRequired
        ? retrieveSemanticDocuments(vectordb, augmentedQuery, selection, resolved.sheetNames, temporalData.length > 0)
        : null
    const rowsBySheet = resolved.sheetNames.length > 0
        ? await sheetRepository.getAllRowsBySheet({ sheetNames: resolved.sheetNames, normalize: false })
        : new Map<string, Record<string, string>[]>()
    const projectedRows = projectStructuredEvidence(rowsBySheet, query, temporalData)
    const structuredEvidence = Object.fromEntries(
        [...projectedRows.entries()].filter(([, rows]) => rows.length > 0),
    )
    logData(structuredEvidence, "Retrieved structured source evidence")

    const retrievedSources = selectedSourcesWithRows(selection, resolved.sourceSheets, structuredEvidence)
    const initiallyMissing = selection.sourceIds.filter((sourceId) =>
        sourceId !== "semantic_knowledge" && !retrievedSources.includes(sourceId)
    )
    let semanticSearchUsed = semanticInitiallyRequired
    let fallbackUsed = false

    // A single broad fallback keeps source-selection failures recoverable without
    // creating a nested or unbounded retrieval loop.
    if (!semanticSearchUsed && (retrievedSources.length === 0 || initiallyMissing.length > 0)) {
        semanticSearchUsed = true
        fallbackUsed = true
    }

    let retrievedDocuments = ""
    let retrievedDocumentEvidence: Array<{ pageContent: string; metadata: Record<string, unknown> }> = []
    const retrievedSheetTitles: string[] = []
    if (semanticSearchUsed) {
        const semanticSheetNames = fallbackUsed
            ? [...new Set(initiallyMissing.flatMap((sourceId) => resolved.sourceSheets[sourceId] ?? []))]
            : resolved.sheetNames
        const rawRetrieved = semanticPromise
            ? await semanticPromise
            : await retrieveSemanticDocuments(vectordb, augmentedQuery, selection, semanticSheetNames, temporalData.length > 0)
        const retrieved = temporalData.length === 0
            ? rawRetrieved
            : rawRetrieved.flatMap((document) => {
                const combinedEvidence = JSON.stringify({
                    content: document.pageContent,
                    metadata: document.metadata,
                })
                if (!evidenceMatchesTemporalWindow(combinedEvidence, query, temporalData)) return []
                const pageContent = projectTextEvidence(document.pageContent, query, temporalData)
                return pageContent ? [{ ...document, pageContent }] : []
            })
        retrievedDocumentEvidence = retrieved
        for (const document of retrieved) {
            const sheetName = typeof document.metadata.sheetName === "string"
                ? document.metadata.sheetName.toLowerCase()
                : undefined
            if (sheetName) retrievedSheetTitles.push(sheetName)
        }
        retrievedDocuments = formatDocumentsForLLM(retrieved)
        if (retrieved.length > 0) retrievedSources.push("semantic_knowledge")
        logData(retrievedDocuments, "Retrieved documents from vector db")
    }

    const uniqueRetrievedSources = [...new Set(retrievedSources)]
    const missingSources = selection.sourceIds.filter((sourceId) => !uniqueRetrievedSources.includes(sourceId))
    const evidenceCount = Object.keys(structuredEvidence).length + (retrievedDocuments ? 1 : 0)
    const coverage: RetrievalProvenance["coverage"] = evidenceCount === 0
        ? "none"
        : missingSources.length > 0 ? "partial" : "complete"
    const allSheetTitles = [...new Set([...resolved.sheetNames, ...retrievedSheetTitles])]
    const compacted = compactEvidence(structuredEvidence, retrievedDocuments)
    const temporalEvidence = [
        JSON.stringify(structuredEvidence),
        ...retrievedDocumentEvidence.map((document) => JSON.stringify({
            content: document.pageContent,
            metadata: document.metadata,
        })),
    ].join("\n")
    const temporalCoverage: RetrievalProvenance["temporalCoverage"] = temporalData.length === 0
        ? "not_requested"
        : evidenceMatchesTemporalWindow(temporalEvidence, query, temporalData)
            ? "matched"
            : "unmatched"
    const provenance: RetrievalProvenance = {
        selectedSources: selection.sourceIds,
        retrievedSources: uniqueRetrievedSources,
        missingSources,
        sheetNames: allSheetTitles,
        semanticSearchUsed,
        fallbackUsed,
        coverage,
        absenceIsEvidence: false,
        retrievedAt: clockService.now("Europe/London").toISO()!,
        temporalScope: temporalData.map((item) => ({
            phrase: item.text,
            date: item.date_equivalent,
            endDate: item.end_date_equivalent,
        })),
        temporalCoverage,
        compaction: compacted.report,
    }
    const sheetDescriptions = buildSheetDescriptionsJSON(allSheetTitles)
    const sourceDescriptions = selection.sourceIds.map((sourceId) => ({
        id: sourceId,
        description: retrievalSourceDescription(sourceId),
    }))
    logData(provenance, "Retrieval provenance")

    const context = [
        `Retrieval provenance: ${JSON.stringify(provenance)}`,
        `Selected source descriptions: ${JSON.stringify(sourceDescriptions)}`,
        `Structured evidence: ${JSON.stringify(compacted.structuredEvidence)}`,
        `Semantic evidence: ${compacted.semanticEvidence || "None"}`,
        `Sheet descriptions: ${JSON.stringify(sheetDescriptions)}`,
    ].join("\n\n")
    logData(context, "Context")

    return { context, augmentedQuery, provenance }

}

async function retrieveSemanticDocuments(
    vectordb: PineconeStore,
    query: string,
    selection: RetrievalSourceSelection,
    sheetNames: string[],
    hasTemporalScope: boolean,
) {
    const narrowQuery = hasTemporalScope && selection.sourceIds.length <= 2
    const restrictToSelectedSheets = sheetNames.length > 0 && !selection.sourceIds.includes("semantic_knowledge")
    const retriever = vectordb.asRetriever({
        k: narrowQuery ? 3 : 5,
        ...(restrictToSelectedSheets ? {
            filter: { sheetName: { $in: sheetNames.map((name) => name.toLowerCase().trim()) } },
        } : {}),
    })
    return deduplicateDocuments(await retriever.invoke(query))
}

function deduplicateDocuments<T extends { pageContent: string; metadata: Record<string, unknown> }>(documents: T[]): T[] {
    const seen = new Set<string>()
    return documents.filter((document) => {
        const key = typeof document.metadata.rowId === "string"
            ? `row:${document.metadata.rowId}`
            : `content:${sha256(document.pageContent.trim().toLowerCase())}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

function selectedSourcesWithRows(
    selection: RetrievalSourceSelection,
    sourceSheets: Partial<Record<RetrievalSourceId, string[]>>,
    evidence: Record<string, Record<string, string>[]>,
): RetrievalSourceId[] {
    return selection.sourceIds.filter((sourceId) =>
        sourceId !== "semantic_knowledge"
        && (sourceSheets[sourceId] ?? []).some((sheetName) => (evidence[sheetName]?.length ?? 0) > 0)
    )
}
