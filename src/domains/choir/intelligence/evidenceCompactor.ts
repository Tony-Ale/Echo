export interface EvidenceCompactionReport {
  structuredCharacters: number;
  semanticCharacters: number;
  omittedStructuredRows: number;
  structuredTruncated: boolean;
  semanticTruncated: boolean;
}

/**
 * Bounds evidence before it enters an LLM context. Compaction operates on
 * structured rows rather than slicing serialized JSON, so the model always
 * receives valid records and explicit truncation metadata.
 */
export function compactEvidence(
  evidence: Record<string, Record<string, string>[]>,
  semanticEvidence: string,
): {
  structuredEvidence: Record<string, Record<string, string>[]>;
  semanticEvidence: string;
  report: EvidenceCompactionReport;
} {
  const structuredEvidence: Record<string, Record<string, string>[]> = {};
  let structuredCharacters = 2;
  let omittedStructuredRows = 0;

  for (const [sheetName, rows] of Object.entries(evidence)) {
    const retained: Record<string, string>[] = [];
    for (const row of rows) {
      const compacted = compactRow(row);
      const rowCharacters = JSON.stringify(compacted).length;
      if (structuredCharacters + rowCharacters > AGENT_CONTEXT_LIMITS.structuredEvidenceCharacters) {
        omittedStructuredRows += 1;
        continue;
      }
      retained.push(compacted);
      structuredCharacters += rowCharacters;
    }
    if (retained.length > 0) structuredEvidence[sheetName] = retained;
  }

  const semanticTruncated = semanticEvidence.length > AGENT_CONTEXT_LIMITS.semanticEvidenceCharacters;
  const compactSemanticEvidence = semanticTruncated
    ? semanticEvidence.slice(0, AGENT_CONTEXT_LIMITS.semanticEvidenceCharacters)
    : semanticEvidence;

  return {
    structuredEvidence,
    semanticEvidence: compactSemanticEvidence,
    report: {
      structuredCharacters,
      semanticCharacters: compactSemanticEvidence.length,
      omittedStructuredRows,
      structuredTruncated: omittedStructuredRows > 0 || hasTruncatedField(evidence),
      semanticTruncated,
    },
  };
}

function compactRow(row: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value.length > AGENT_CONTEXT_LIMITS.evidenceFieldCharacters
      ? `${value.slice(0, AGENT_CONTEXT_LIMITS.evidenceFieldCharacters)}\n[Field truncated]`
      : value,
  ]));
}

function hasTruncatedField(evidence: Record<string, Record<string, string>[]>): boolean {
  return Object.values(evidence).some((rows) =>
    rows.some((row) => Object.values(row).some((value) => value.length > AGENT_CONTEXT_LIMITS.evidenceFieldCharacters)),
  );
}
import { AGENT_CONTEXT_LIMITS } from "../../../agent/runtime/contextLimits.js";
