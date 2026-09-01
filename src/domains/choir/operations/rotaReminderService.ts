import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { DateTime } from "luxon";
import { z } from "zod";
import type {
  ChoirKnowledgeService,
  IdentityRepository,
  SyncCoordinator,
  WeeklyInterpretation,
  WeeklyInterpretationRepository,
} from "../../../agent/ports.js";
import type { OutgoingMessage } from "../../../framework/contracts/messages.js";
import type { ConfiguredChatModel } from "../../../framework/models/types.js";
import { clockService } from "../../../shared/clockService.js";
import { sha256 } from "../../../shared/utils/hash.js";

const LONDON_ZONE = "Europe/London";

const scheduleAssessmentSchema = z.object({
  sundayActivityCancelled: z.boolean().nullable(),
  setlistRequired: z.boolean().nullable(),
  summary: z.string().trim().min(1).max(1_000),
  ambiguities: z.array(z.string().trim().min(1).max(300)).max(8),
});

// Model-authored explanations are normalized before they enter the stricter
// domain contract. Operational values remain strictly typed and untouched.
const rawScheduleAssessmentSchema = scheduleAssessmentSchema.extend({
  ambiguities: z.array(z.string()),
});

export type WeeklyScheduleAssessment = z.infer<typeof scheduleAssessmentSchema>;

export interface WeeklyScheduleAssessor {
  assess(input: {
    weekStart: string;
    weekEnd: string;
    evidence: string;
    signal: AbortSignal;
  }): Promise<WeeklyScheduleAssessment>;
}

export interface RotaPreparation {
  status: "ready" | "not_applicable" | "insufficient_evidence";
  summary: string;
  reply?: OutgoingMessage;
}

export interface WeeklyContextPreparation {
  status: "ready" | "not_applicable" | "insufficient_evidence";
  summary: string;
  interpretation?: WeeklyInterpretation;
}

interface LoadedWeeklyContext extends WeeklyContextPreparation {
  monday?: DateTime;
  schedule?: ParsedWeekSchedule;
}

/**
 * Performs the one semantic decision that cannot safely be inferred from rota
 * syntax alone. Message composition and all dates remain backend-owned.
 */
export class ModelWeeklyScheduleAssessor implements WeeklyScheduleAssessor {
  public constructor(private readonly model: ConfiguredChatModel) {}

  public async assess(input: {
    weekStart: string;
    weekEnd: string;
    evidence: string;
    signal: AbortSignal;
  }): Promise<WeeklyScheduleAssessment> {
    const structured = this.model.withStructuredOutput(rawScheduleAssessmentSchema, {
      name: "assess_weekly_rota_schedule",
    });
    const assessment = await structured.invoke([
      new SystemMessage([
        "Assess whether the evidence explicitly cancels or replaces the choir's dated Sunday activity for the exact Monday-to-Sunday window supplied, and whether a setlist is required.",
        "Use only the evidence. Understand Sunday cancellations, another group ministering, non-participation, and unusual service arrangements semantically.",
        "Do not draft a message, parse dates, invent assignments, or return confidence scores.",
        "A dated assignment is evidence that its activity is scheduled. sundayActivityCancelled may be true only when the evidence explicitly cancels or replaces the Sunday choir activity; an event name or missing source is not cancellation.",
        "Use null when the evidence cannot establish a boolean safely, and list the unresolved issue in ambiguities.",
      ].join(" ")),
      new HumanMessage(JSON.stringify({
        targetWindow: { start: input.weekStart, end: input.weekEnd, inclusive: true },
        evidence: input.evidence,
      })),
    ], { signal: input.signal });
    return normalizeScheduleAssessment(assessment);
  }
}

export function normalizeScheduleAssessment(
  assessment: z.infer<typeof rawScheduleAssessmentSchema>,
): WeeklyScheduleAssessment {
  return scheduleAssessmentSchema.parse({
    ...assessment,
    ambiguities: assessment.ambiguities
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 8)
      .map((value) => value.slice(0, 300)),
  });
}

/**
 * Compound rota operation used by scheduled and creator-triggered runs.
 * It deliberately performs one bounded model assessment rather than exposing a
 * multi-round retrieve -> interpret -> validate -> compose plan to the agent.
 */
export class RotaReminderService {
  public constructor(
    private readonly knowledge: ChoirKnowledgeService,
    private readonly interpretations: WeeklyInterpretationRepository,
    private readonly identities: IdentityRepository,
    private readonly sync: SyncCoordinator,
    private readonly assessor: WeeklyScheduleAssessor,
  ) {}

  public async prepare(input: {
    weekStart: string;
    transport: string;
    kind: "sunday" | "midweek";
    signal: AbortSignal;
  }): Promise<RotaPreparation> {
    const weekly = await this.loadWeeklyContext(input);
    if (weekly.status !== "ready" || !weekly.interpretation || !weekly.schedule || !weekly.monday) {
      return { status: weekly.status, summary: weekly.summary };
    }
    const { interpretation, schedule, monday } = weekly;
    const hasSundayAssignments = hasDatedAssignments(schedule, monday.plus({ days: 6 }));
    const midweekDate = monday.plus({ days: 2 });
    const hasMidweekAssignments = hasDatedAssignments(schedule, midweekDate);
    const sundayCancelled = interpretation.interpretation.sundayActivityCancelled === true;
    if (input.kind === "sunday" && (sundayCancelled || !hasSundayAssignments)) {
      return {
        status: sundayCancelled ? "not_applicable" : "insufficient_evidence",
        summary: sundayCancelled
          ? "Current weekly evidence explicitly cancels or replaces the Sunday choir activity."
          : "No dated Sunday choir assignment is available for the requested week.",
      };
    }
    if (input.kind === "midweek" && !hasMidweekAssignments) {
      return {
        status: "not_applicable",
        summary: "No active dated Wednesday choir assignment is available for the requested week.",
      };
    }

    const targetDate = input.kind === "sunday" ? monday.plus({ days: 6 }) : monday.plus({ days: 2 });
    const deliverySchedule = input.kind === "sunday"
      ? schedule
      : activeScheduleForDate(schedule, targetDate);
    if (deliverySchedule.sections.length === 0 || deliverySchedule.sections.every((section) => section.items.length === 0)) {
      return {
        status: "insufficient_evidence",
        summary: `No dated ${input.kind === "sunday" ? "Sunday" : "Wednesday"} rota entries were available for the requested service week.`,
      };
    }

    const resolved = await resolveScheduleMembers(deliverySchedule, this.identities, input.transport);
    return {
      status: "ready",
      summary: `The source-validated ${input.kind === "sunday" ? "Sunday" : "Wednesday"} rota reminder is ready for delivery.`,
      reply: {
        text: renderRotaReminder(deliverySchedule, resolved.displayNames, targetDate),
        ...(resolved.mentions.length > 0 ? { mentions: resolved.mentions } : {}),
        ...(resolved.mentionLabels.length > 0 ? { mentionLabels: resolved.mentionLabels } : {}),
      },
    };
  }

  /** Reuses the compound rota evidence path without composing a rota message. */
  public async ensureWeeklyInterpretation(input: {
    weekStart: string;
    signal: AbortSignal;
  }): Promise<WeeklyContextPreparation> {
    const weekly = await this.loadWeeklyContext(input);
    return {
      status: weekly.status,
      summary: weekly.summary,
      ...(weekly.interpretation ? { interpretation: weekly.interpretation } : {}),
    };
  }

  private async loadWeeklyContext(input: {
    weekStart: string;
    signal: AbortSignal;
  }): Promise<LoadedWeeklyContext> {
    const monday = parseMonday(input.weekStart);
    if (!monday) {
      return { status: "insufficient_evidence", summary: "The rota reminder has an invalid service-week boundary." };
    }
    const weekEnd = monday.plus({ days: 6 }).toISODate()!;
    let evidence = await this.retrieveWeek(input.weekStart, weekEnd);

    // One freshness recovery is allowed only when the requested window has no
    // usable evidence. A failed or skipped sync never aborts the whole agent.
    if (!hasUsableWeekEvidence(evidence, input.weekStart)) {
      const recovery = await this.sync.syncIfStale({
        reason: `Rota evidence for ${input.weekStart} is empty or does not cover the requested week.`,
        force: false,
      }).catch(() => null);
      if (recovery?.synced && recovery.sourceChanged) {
        evidence = await this.retrieveWeek(input.weekStart, weekEnd);
      }
    }

    const schedule = parseWeekSchedule(evidence.context, input.weekStart);
    if (schedule.sections.length === 0) {
      return {
        status: "insufficient_evidence",
        summary: "No dated rota entries were available for the requested service week.",
      };
    }

    const sourceHash = evidence.sourceHash ?? sha256(evidence.context);
    const cached = await this.interpretations.get(input.weekStart, sourceHash);
    const assessment = cached?.interpretation ?? await this.assessor.assess({
      weekStart: input.weekStart,
      weekEnd,
      evidence: extractAssessmentEvidence(evidence.context),
      signal: input.signal,
    });
    const assignedMemberNames = unique(schedule.sections.flatMap((section) =>
      section.items.flatMap((item) => item.leaderNames)
    ));
    const worshipPraiseLeaderNames = unique(schedule.sections
      .filter((section) => section.date.hasSame(monday.plus({ days: 6 }), "day"))
      .flatMap((section) => section.items
        .filter((item) => isSetlistLeadershipRole(item.role))
        .flatMap((item) => item.leaderNames)));
    const hasMidweekAssignments = hasDatedAssignments(schedule, monday.plus({ days: 2 }));
    const hasSundayAssignments = hasDatedAssignments(schedule, monday.plus({ days: 6 }));

    const interpretation = cached ?? await this.saveInterpretation({
      weekStart: input.weekStart,
      weekEnd,
      sourceHash,
      scheduleContext: evidence.context,
      assessment,
      hasSundayAssignments,
      hasMidweekAssignments,
      assignedMemberNames,
      worshipPraiseLeaderNames,
      expiresAt: monday.plus({ weeks: 2 }).toISO()!,
    });
    return {
      status: "ready",
      summary: "The weekly choir context is source-validated and ready.",
      interpretation,
      monday,
      schedule,
    };
  }

  private retrieveWeek(weekStart: string, weekEnd: string) {
    return this.knowledge.retrieve(
      `Return scheduled choir activities, services, rehearsals, events and assignments from Monday ${weekStart} through Sunday ${weekEnd}, inclusive.`,
      { sourceIds: ["monthly_rota", "annual_events"], semanticSearch: false },
    );
  }

  private saveInterpretation(input: {
    weekStart: string;
    weekEnd: string;
    sourceHash: string;
    scheduleContext: string;
    assessment: WeeklyScheduleAssessment;
    hasSundayAssignments: boolean;
    hasMidweekAssignments: boolean;
    assignedMemberNames: string[];
    worshipPraiseLeaderNames: string[];
    expiresAt: string;
  }): Promise<WeeklyInterpretation> {
    const sundayExpected = input.hasSundayAssignments && input.assessment.sundayActivityCancelled !== true;
    const applicableObligations = [
      ...(sundayExpected ? ["weekly_rota_reminder_due"] : []),
      ...(input.hasMidweekAssignments ? ["midweek_rota_reminder_due"] : []),
      ...(sundayExpected && input.assessment.setlistRequired === true
        ? ["setlist_weekly_planning_due", "setlist_followup_due", "setlist_broadcast_due"]
        : []),
    ];
    return this.interpretations.save({
      weekStart: input.weekStart,
      sourceHash: input.sourceHash,
      scheduleContext: [
        `Target service window: Monday ${input.weekStart} through Sunday ${input.weekEnd}, inclusive.`,
        input.scheduleContext,
      ].join("\n\n"),
      interpretation: {
        ...input.assessment,
        assignedMemberNames: input.assignedMemberNames,
        worshipPraiseLeaderNames: input.worshipPraiseLeaderNames,
        applicableObligations,
      },
      evaluatedAt: clockService.now(LONDON_ZONE).toISO()!,
      expiresAt: input.expiresAt,
    });
  }
}

/** Distinguishes the main setlist leader from prayer assignments that happen to mention worship. */
export function isSetlistLeadershipRole(role: string): boolean {
  const isPraiseRole = /(?:\bpraise\b|p\s*&\s*w)/i.test(role);
  if (/\bprayer\b/i.test(role) && !isPraiseRole) return false;
  return isPraiseRole || /\bworship\b/i.test(role);
}

interface RotaItem {
  role: string;
  leaderNames: string[];
  supportingInfo?: string;
}

interface RotaSection {
  date: DateTime;
  items: RotaItem[];
}

interface ParsedWeekSchedule {
  sections: RotaSection[];
}

function hasDatedAssignments(schedule: ParsedWeekSchedule, date: DateTime): boolean {
  return activeScheduleForDate(schedule, date).sections.some((section) => section.items.length > 0);
}

function activeScheduleForDate(schedule: ParsedWeekSchedule, date: DateTime): ParsedWeekSchedule {
  return {
    sections: schedule.sections
      .filter((section) => section.date.hasSame(date, "day"))
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => !isCancellationItem(item)),
      })),
  };
}

function isCancellationItem(item: RotaItem): boolean {
  const value = [item.role, ...item.leaderNames, item.supportingInfo ?? ""].join(" ");
  return /\b(?:cancelled|canceled|postponed|not holding|no bible study|no choir activity)\b/i.test(value);
}

function parseMonday(value: string): DateTime | null {
  const parsed = DateTime.fromISO(value, { zone: LONDON_ZONE }).startOf("day");
  return parsed.isValid && parsed.weekday === 1 ? parsed : null;
}

function hasUsableWeekEvidence(
  evidence: Awaited<ReturnType<ChoirKnowledgeService["retrieve"]>>,
  weekStart: string,
): boolean {
  if (evidence.provenance?.coverage === "none") return false;
  if (evidence.provenance?.temporalCoverage === "unmatched") return false;
  return parseWeekSchedule(evidence.context, weekStart).sections.length > 0;
}

function parseWeekSchedule(context: string, weekStart: string): ParsedWeekSchedule {
  const structured = extractStructuredEvidence(context);
  const content = Object.values(structured).flatMap((rows) => rows)
    .filter((row) => !row.WEEK_START || row.WEEK_START === weekStart)
    .map((row) => row.CONTENT ?? "")
    .filter(Boolean)
    .join("\n");
  const source = content || extractSemanticEvidence(context);
  const sections: RotaSection[] = [];
  let current: RotaSection | null = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    const date = parseRotaDate(line);
    if (date) {
      current = { date, items: [] };
      sections.push(current);
      continue;
    }
    if (!current || !line.startsWith("- ")) continue;
    const item = parseRotaItem(line.slice(2).trim());
    if (item) current.items.push(item);
  }
  return { sections: deduplicateSections(sections) };
}

function extractStructuredEvidence(context: string): Record<string, Record<string, string>[]> {
  const line = context.split(/\r?\n/).find((value) => value.startsWith("Structured evidence:"));
  if (!line) return {};
  try {
    const parsed: unknown = JSON.parse(line.slice("Structured evidence:".length).trim());
    return isStructuredEvidence(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isStructuredEvidence(value: unknown): value is Record<string, Record<string, string>[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((rows) =>
    Array.isArray(rows) && rows.every((row) =>
      row && typeof row === "object" && !Array.isArray(row)
      && Object.values(row).every((field) => typeof field === "string")
    )
  );
}

function extractSemanticEvidence(context: string): string {
  const marker = "Semantic evidence:";
  const start = context.indexOf(marker);
  if (start < 0) return "";
  return context.slice(start + marker.length).split("\n\nSheet descriptions:")[0].trim();
}

/** Keeps the specialized model input to evidence, not retrieval bookkeeping. */
function extractAssessmentEvidence(context: string): string {
  const structured = extractStructuredEvidence(context);
  const semantic = extractSemanticEvidence(context);
  return [
    `Structured evidence: ${JSON.stringify(structured)}`,
    `Semantic evidence: ${semantic || "None"}`,
  ].join("\n\n");
}

function parseRotaDate(line: string): DateTime | null {
  const match = line.match(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})$/i);
  if (!match) return null;
  const parsed = DateTime.fromObject(
    { day: Number(match[1]), month: Number(match[2]), year: Number(match[3]) },
    { zone: LONDON_ZONE },
  );
  return parsed.isValid ? parsed : null;
}

function parseRotaItem(value: string): RotaItem | null {
  if (!value) return null;
  const supportingStart = value.indexOf(" (");
  const main = supportingStart >= 0 ? value.slice(0, supportingStart) : value;
  const supportingInfo = supportingStart >= 0 ? value.slice(supportingStart + 2, -1).trim() : undefined;
  const separator = main.indexOf(":");
  const role = (separator >= 0 ? main.slice(0, separator) : main).trim();
  const leaderText = separator >= 0 ? main.slice(separator + 1).trim() : "";
  if (!role) return null;
  return {
    role,
    leaderNames: splitLeaderNames(leaderText),
    ...(supportingInfo ? { supportingInfo } : {}),
  };
}

function splitLeaderNames(value: string): string[] {
  if (!value || /^(?:n\/a|none|tbc|to be confirmed)$/i.test(value)) return [];
  return value.split(/\s*(?:,|&|\band\b)\s*/i).map((name) => name.trim()).filter(Boolean);
}

function deduplicateSections(sections: RotaSection[]): RotaSection[] {
  const byDate = new Map<string, RotaSection>();
  for (const section of sections) {
    const key = section.date.toISODate()!;
    const existing = byDate.get(key) ?? { date: section.date, items: [] };
    const seen = new Set(existing.items.map((item) => JSON.stringify(item)));
    for (const item of section.items) {
      const key = JSON.stringify(item);
      if (!seen.has(key)) existing.items.push(item);
      seen.add(key);
    }
    byDate.set(key, existing);
  }
  return [...byDate.values()].sort((left, right) => left.date.toMillis() - right.date.toMillis());
}

async function resolveScheduleMembers(
  schedule: ParsedWeekSchedule,
  identities: IdentityRepository,
  transport: string,
): Promise<{ displayNames: Map<string, string>; mentions: string[]; mentionLabels: string[] }> {
  const names = unique(schedule.sections.flatMap((section) => section.items.flatMap((item) => item.leaderNames)));
  const resolutions = await identities.resolveByNames(names);
  const displayNames = new Map<string, string>();
  const memberIds: string[] = [];
  const mentionLabels: string[] = [];
  for (const resolution of resolutions) {
    if (resolution.matches.length !== 1) continue;
    const member = resolution.matches[0];
    const label = member.displayName || member.canonicalName || resolution.name;
    displayNames.set(resolution.name, label);
    memberIds.push(member.id);
    mentionLabels.push(label);
  }
  const mentions = await identities.getMentionTargets(unique(memberIds), transport);
  return {
    displayNames,
    mentions,
    mentionLabels: mentions.length === mentionLabels.length ? mentionLabels : [],
  };
}

function renderRotaReminder(
  schedule: ParsedWeekSchedule,
  displayNames: Map<string, string>,
  targetDate: DateTime,
): string {
  const sections = schedule.sections.map((section) => {
    const items = section.items.map((item) => {
      const leaders = item.leaderNames.map((name) => {
        const displayName = displayNames.get(name);
        return displayName ? `@${displayName}` : name;
      }).join(" & ");
      const assignment = leaders ? `${item.role}: ${leaders}` : item.role;
      return `- ${assignment}${item.supportingInfo ? ` (${item.supportingInfo})` : ""}`;
    });
    return [`*${section.date.toFormat("cccc, d LLLL")}*`, ...items].join("\n");
  });
  return [`*Choir Rota - ${targetDate.toFormat("cccc, d LLLL yyyy")}*`, ...sections].join("\n\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
