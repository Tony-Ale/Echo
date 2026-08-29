import {
  ATTENDANCE,
  DOCUMENTS_AND_RESOURCES,
  EVENTS_2026,
  MEMBERS,
  ORIGINALS_2026_ROTA,
  SM_LIBRARY,
} from "../../../integrations/googleSheets/utils.js";
import { mapDateStringToMonthlyRota } from "./helpers.js";

export const RETRIEVAL_SOURCE_IDS = [
  "monthly_rota",
  "annual_events",
  "attendance",
  "member_directory",
  "song_library",
  "originals_rota",
  "documents",
  "semantic_knowledge",
] as const;

export type RetrievalSourceId = typeof RETRIEVAL_SOURCE_IDS[number];

export function isRetrievalSourceId(value: string): value is RetrievalSourceId {
  return (RETRIEVAL_SOURCE_IDS as readonly string[]).includes(value);
}

export interface RetrievalSourceDescriptor {
  id: RetrievalSourceId;
  description: string;
  mode: "sheet" | "monthly_sheet" | "semantic";
  sheetName?: string;
}

/** Semantic catalog shown to the selector; vendor-specific names stay internal. */
export const RETRIEVAL_SOURCE_CATALOG: readonly RetrievalSourceDescriptor[] = [
  { id: "monthly_rota", mode: "monthly_sheet", description: "Weekly choir duties, service roles, leaders, rehearsals, Bible study, uniforms and monthly rota assignments." },
  { id: "annual_events", mode: "sheet", sheetName: EVENTS_2026, description: "Dated annual choir and church events, programmes, conferences and special Sundays." },
  { id: "attendance", mode: "sheet", sheetName: ATTENDANCE, description: "Member availability and attendance records." },
  { id: "member_directory", mode: "sheet", sheetName: MEMBERS, description: "Choir membership, names, vocal parts and member roles." },
  { id: "song_library", mode: "sheet", sheetName: SM_LIBRARY, description: "Special ministrations, hymns and songs grouped by theme." },
  { id: "originals_rota", mode: "sheet", sheetName: ORIGINALS_2026_ROTA, description: "Original-song composition assignments, composers and songs." },
  { id: "documents", mode: "sheet", sheetName: DOCUMENTS_AND_RESOURCES, description: "Choir policies, vision, forms, meeting records and shared resource documents." },
  { id: "semantic_knowledge", mode: "semantic", description: "Broad semantic search across indexed choir knowledge when the source is unclear or unstructured." },
] as const;

export interface ResolvedRetrievalSources {
  sheetNames: string[];
  sourceSheets: Partial<Record<RetrievalSourceId, string[]>>;
  unresolvedSources: RetrievalSourceId[];
}

/** Maps semantic source IDs to concrete sheet names using deterministic dates. */
export function resolveRetrievalSources(
  sourceIds: RetrievalSourceId[],
  temporalDates: string[],
): ResolvedRetrievalSources {
  const sourceSheets: Partial<Record<RetrievalSourceId, string[]>> = {};
  const unresolvedSources: RetrievalSourceId[] = [];

  for (const sourceId of sourceIds) {
    const descriptor = RETRIEVAL_SOURCE_CATALOG.find((item) => item.id === sourceId);
    if (!descriptor || descriptor.mode === "semantic") continue;

    if (descriptor.mode === "monthly_sheet") {
      const sheetNames = [...new Set(temporalDates.map(mapDateStringToMonthlyRota))];
      if (sheetNames.length === 0) unresolvedSources.push(sourceId);
      else sourceSheets[sourceId] = sheetNames;
      continue;
    }

    if (descriptor.sheetName) sourceSheets[sourceId] = [descriptor.sheetName];
    else unresolvedSources.push(sourceId);
  }

  return {
    sourceSheets,
    unresolvedSources,
    sheetNames: [...new Set(Object.values(sourceSheets).flatMap((names) => names ?? []))],
  };
}

export function retrievalSourceDescription(sourceId: RetrievalSourceId): string {
  return RETRIEVAL_SOURCE_CATALOG.find((item) => item.id === sourceId)?.description ?? sourceId;
}
