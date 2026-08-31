import assert from "node:assert/strict";
import type { PineconeStore } from "@langchain/pinecone";
import { retrieveDocuments } from "../domains/choir/intelligence/retrievalService.js";
import {
  resolveRetrievalSources,
  retrievalSourceToolCatalogue,
} from "../domains/choir/intelligence/retrievalSources.js";
import {
  evidenceMatchesTemporalWindow,
  projectStructuredEvidence,
  projectTextEvidence,
} from "../domains/choir/intelligence/evidenceProjector.js";
import { compactEvidence } from "../domains/choir/intelligence/evidenceCompactor.js";
import {
  findMatchingSheetTitle,
  normalizeSpreadsheetContainsValue,
  projectMatchedCell,
  SheetsRepository,
} from "../integrations/googleSheets/sheetsRepository.js";
import { AGENT_CONTEXT_LIMITS } from "../agent/runtime/contextLimits.js";
import { reorganizeMonthlyRota } from "../integrations/googleSheets/helpers.js";
import { extractSearchTerms, takeDistinctSearchResults } from "../agent/persistence/searchTerms.js";
import { preserveTemporalQueryScope } from "../domains/choir/intelligence/temporalQuery.js";

async function run(): Promise<void> {
  testDeterministicSourceResolution();
  testRetrievalToolCatalogue();
  testTemporalEvidenceProjection();
  testTemporalQueryScopePreservation();
  testTemporalEvidenceMatching();
  testSemanticEvidenceProjection();
  testMonthlyRotaUsesMondayServiceWeeks();
  testEvidenceCompactionPreservesValidRows();
  testNaturalSheetTitleResolution();
  testSpreadsheetDateLocatorNormalization();
  testDurableSearchTermExtraction();
  testMultilineSpreadsheetProjection();
  await testSheetBatchCache();
  await testMultiSourceStructuredRetrieval();
  await testEmptyStructuredSourceUsesBoundedFallback();
  await testStaleSemanticEvidenceDoesNotMatchTargetWeek();
  console.log("Retrieval routing self-tests passed.");
}

function testTemporalQueryScopePreservation(): void {
  assert.match(
    preserveTemporalQueryScope("unavailable members", "Who was unavailable yesterday?"),
    /yesterday/,
  );
  assert.equal(
    preserveTemporalQueryScope("unavailable on 2026-08-30", "Who was unavailable yesterday?"),
    "unavailable on 2026-08-30",
  );
  assert.equal(
    preserveTemporalQueryScope("choir members", "Who is in the choir?"),
    "choir members",
  );
}

function testDurableSearchTermExtraction(): void {
  assert.deepEqual(extractSearchTerms("Rehearsal updates, rehearsal preference"), ["rehearsal", "updates", "preference"]);
  assert.deepEqual(extractSearchTerms("a b valid-term", 2), ["valid-term"]);
  assert.deepEqual(
    takeDistinctSearchResults(["new question", "new question", "earlier statement"], (value) => value, 2),
    ["new question", "earlier statement"],
  );
}

function testSpreadsheetDateLocatorNormalization(): void {
  assert.equal(normalizeSpreadsheetContainsValue("30-August-26 (Saturday)"), "30-August-26");
  assert.equal(normalizeSpreadsheetContainsValue("30-August-26 (Sunday) ->"), "30-August-26");
  assert.equal(normalizeSpreadsheetContainsValue("Member A: unavailable"), "Member A: unavailable");
}

function testRetrievalToolCatalogue(): void {
  const catalogue = retrievalSourceToolCatalogue();
  assert.match(catalogue, /attendance \(tab: 2026 attendance\): Member availability/);
  assert.match(catalogue, /monthly_rota \(monthly tabs such as aug 26\): Weekly choir duties/);
  assert.match(catalogue, /semantic_knowledge: Broad semantic search/);
}

function testMonthlyRotaUsesMondayServiceWeeks(): void {
  const rows = [
    { DATE: "Wednesday 19/08/2026", ROLE: "Bible study P&W", LEAD: "Member A", "SUPPORTING LINK/ INFO": "" },
    { DATE: "Sunday 23/08/2026", ROLE: "Workers prayer worship", LEAD: "Member B", "SUPPORTING LINK/ INFO": "" },
  ];
  const documents = reorganizeMonthlyRota(rows);

  assert.equal(documents.length, 1);
  assert.equal(documents[0].WEEK_START, "2026-08-17");
  assert.match(documents[0].CONTENT, /Wednesday 19\/08\/2026/);
  assert.match(documents[0].CONTENT, /Sunday 23\/08\/2026/);
}

function testSemanticEvidenceProjection(): void {
  const scope = [{ text: "2026-08-10", date_equivalent: "10/08/2026" }];
  const projected = projectTextEvidence([
    "Monthly schedule",
    "Sunday 09/08/2026",
    "- Children's Sunday",
    "Wednesday 12/08/2026",
    "- Bible study",
    "Sunday 23/08/2026",
    "- Later service",
  ].join("\n"), "week starting 2026-08-10", scope);

  assert.match(projected, /Wednesday 12\/08\/2026/);
  assert.match(projected, /Bible study/);
  assert.doesNotMatch(projected, /Children's Sunday/);
  assert.doesNotMatch(projected, /Later service/);
}

function testTemporalEvidenceMatching(): void {
  const scope = [{ text: "2026-08-17", date_equivalent: "17/08/2026" }];
  assert.equal(
    evidenceMatchesTemporalWindow("23-Aug-26 (Sunday) -> Service", "week starting 2026-08-17", scope),
    true,
  );
  assert.equal(
    evidenceMatchesTemporalWindow("16-August-26 (Sunday) -> Service", "week starting 2026-08-17", scope),
    false,
  );
}

async function testSheetBatchCache(): Promise<void> {
  let batchCalls = 0;
  const repository = new SheetsRepository({
    spreadsheets: {
      values: {
        async batchGet() {
          batchCalls += 1;
          return { data: { valueRanges: [
            { values: [["LIST OF OHA MEMBERS"], ["Member A"]] },
            { values: [["THEME", "HYMNS"], ["Faith", "Song A"]] },
          ] } };
        },
        async get() { throw new Error("Individual fallback should not run."); },
      },
    },
  } as never);
  const request = { sheetNames: ["members", "sm library"], normalize: false as const };
  const first = await repository.getAllRowsBySheet(request);
  const second = await repository.getAllRowsBySheet(request);
  assert.equal(batchCalls, 1);
  assert.equal(first.get("members")?.length, 1);
  assert.deepEqual(second, first);
  repository.clearCache();
  await repository.getAllRowsBySheet(request);
  assert.equal(batchCalls, 2);
}

function testMultilineSpreadsheetProjection(): void {
  const value = [
    "08-August-26 (Saturday) -> Member A: N/A",
    "09-August-26 (Sunday) -> Member A: A",
    "15-August-26 (Saturday) -> Member A: A, Member B: NA",
  ].join("\n");
  assert.equal(
    projectMatchedCell(value, "attendance", [{
      column: "attendance",
      operator: "contains",
      value: "15-August-26 (Saturday)",
    }]),
    "15-August-26 (Saturday) -> Member A: A, Member B: NA",
  );
}

function testNaturalSheetTitleResolution(): void {
  const titles = ["Attendance 2024", "Attendance 2025", "2026 attendance", "members", "Aug 26"];
  assert.equal(findMatchingSheetTitle("Attendance sheet", titles), "2026 attendance");
  assert.equal(findMatchingSheetTitle("members tab", titles), "members");
  assert.equal(findMatchingSheetTitle("rota", titles), null);
}

function testEvidenceCompactionPreservesValidRows(): void {
  const oversized = "x".repeat(3_000);
  const compacted = compactEvidence({ attendance: [{ date: "15-August-26", notes: oversized }] }, "y".repeat(7_000));
  assert.equal(compacted.report.structuredTruncated, true);
  assert.equal(compacted.report.semanticTruncated, true);
  assert.match(compacted.structuredEvidence.attendance[0].notes, /Field truncated/);
  assert.equal(compacted.semanticEvidence.length, AGENT_CONTEXT_LIMITS.semanticEvidenceCharacters);
}

function testTemporalEvidenceProjection(): void {
  const projected = projectStructuredEvidence(
    new Map([["attendance", [
      {
        description: "January and August attendance",
        attendance: [
          "10-January-26 (Saturday) -> Member A: A",
          "15-August-26 (Saturday) -> Member A: A, Member B: U",
          "22-August-26 (Saturday) -> Member A: A",
        ].join("\n"),
      },
    ]]]),
    "Saturday rehearsal attendance for the week of 2026-08-10",
    [{ text: "2026-08-10", date_equivalent: "10/08/2026" }],
  );
  const evidence = JSON.stringify(Object.fromEntries(projected));

  assert.match(evidence, /15-August-26/);
  assert.doesNotMatch(evidence, /10-January-26/);
  assert.doesNotMatch(evidence, /22-August-26/);
}

function testDeterministicSourceResolution(): void {
  const resolved = resolveRetrievalSources(
    ["monthly_rota", "annual_events"],
    ["10/08/2026"],
  );
  assert.deepEqual(resolved.sheetNames.sort(), ["2026 events", "aug 26"]);
  assert.deepEqual(resolved.unresolvedSources, []);
}

async function testMultiSourceStructuredRetrieval(): Promise<void> {
  let vectorCalls = 0;
  const result = await retrieveDocuments(
    "Schedule and events for the week starting 2026-08-10",
    fakeSheets(new Map([
      ["aug 26", [{ WEEK_START: "2026-08-09", CONTENT: "Wednesday 12/08/2026\nBible study" }]],
      ["2026 events", [{ DATE: "12/08/2026", EVENT: "Midweek event" }]],
    ])),
    fakeVectorStore(() => {
      vectorCalls += 1;
      return [];
    }),
    { sourceIds: ["monthly_rota", "annual_events"], semanticSearch: false },
  );

  assert.equal(vectorCalls, 0);
  assert.equal(result.provenance.coverage, "complete");
  assert.equal(result.provenance.absenceIsEvidence, false);
  assert.deepEqual(result.provenance.retrievedSources.sort(), ["annual_events", "monthly_rota"]);
  assert.match(result.context, /Wednesday 12\/08\/2026\\nBible study/);
  assert.match(result.context, /Midweek event/);
}

async function testEmptyStructuredSourceUsesBoundedFallback(): Promise<void> {
  let vectorCalls = 0;
  const result = await retrieveDocuments(
    "Find the relevant choir information for 2026-08-10",
    fakeSheets(new Map([["aug 26", []]])),
    fakeVectorStore(() => {
      vectorCalls += 1;
      return [{
        pageContent: "Indexed weekly rota evidence",
        metadata: { sheetName: "aug 26" },
      }];
    }),
    { sourceIds: ["monthly_rota"], semanticSearch: false },
  );

  assert.equal(vectorCalls, 1, "The broad fallback must execute at most once.");
  assert.equal(result.provenance.fallbackUsed, true);
  assert.equal(result.provenance.semanticSearchUsed, true);
  assert.equal(result.provenance.coverage, "none");
}

async function testStaleSemanticEvidenceDoesNotMatchTargetWeek(): Promise<void> {
  const result = await retrieveDocuments(
    "Schedule for the week starting 2026-08-17",
    fakeSheets(new Map([["aug 26", []], ["2026 events", []]])),
    fakeVectorStore(() => [{
      pageContent: "Sunday 16-August-26 service assignments",
      metadata: { sheetName: "aug 26" },
    }]),
    { sourceIds: ["monthly_rota", "annual_events"], semanticSearch: false },
  );

  assert.equal(result.provenance.coverage, "none");
  assert.equal(result.provenance.temporalCoverage, "unmatched");
}

function fakeSheets(rows: Map<string, Record<string, string>[]>): SheetsRepository {
  return {
    async getAllRowsBySheet() { return rows; },
  } as unknown as SheetsRepository;
}

function fakeVectorStore(retrieve: () => Array<{ pageContent: string; metadata: Record<string, unknown> }>): PineconeStore {
  return {
    asRetriever() {
      return { async invoke() { return retrieve(); } };
    },
  } as unknown as PineconeStore;
}

void run();
