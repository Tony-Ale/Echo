import assert from "node:assert/strict";
import type { IncomingMessage } from "../framework/contracts/messages.js";
import { InMemoryIdentityRepository, InMemoryWeeklyInterpretationRepository } from "../agent/testing/fakes.js";
import { clockService } from "../shared/clockService.js";
import type { TemporalPhraseService } from "../workflows/temporalPhraseService.js";
import { SetlistService } from "../workflows/setlistService.js";
import type { SetlistKind, SetlistSubmissionRecord } from "../workflows/types.js";
import type { WorkflowRepository } from "../workflows/workflowRepository.js";
import { WorkflowService } from "../workflows/workflowService.js";

const CHAT_ID = "setlist-test@g.us";
const CREATOR_PHONE = "15550001001";

class InMemorySetlistRepository {
  public records: SetlistSubmissionRecord[] = [];

  public async createSetlistSubmission(input: Omit<SetlistSubmissionRecord, "id">): Promise<SetlistSubmissionRecord> {
    const record = { ...input, id: `setlist-${this.records.length + 1}`, updatedAt: clockService.now().toISO()! };
    this.records.push(record);
    return record;
  }

  public async updateSetlistSubmission(id: string, updates: Partial<SetlistSubmissionRecord>): Promise<SetlistSubmissionRecord> {
    const index = this.records.findIndex((record) => record.id === id);
    assert.notEqual(index, -1);
    this.records[index] = { ...this.records[index], ...updates, updatedAt: clockService.now().toISO()! };
    return this.records[index];
  }

  public async getSetlistSubmission(id: string): Promise<SetlistSubmissionRecord | null> {
    return this.records.find((record) => record.id === id) ?? null;
  }

  public async getSubmittedSetlist(kind: SetlistKind, weekStart: string): Promise<SetlistSubmissionRecord | null> {
    return this.records.find((record) => record.kind === kind && record.weekStart === weekStart && record.status === "submitted") ?? null;
  }

  public async getSubmittedSetlistsForWeek(weekStart: string): Promise<SetlistSubmissionRecord[]> {
    return this.records.filter((record) => record.weekStart === weekStart && record.status === "submitted");
  }

  public async hasSubmittedSetlist(kind: SetlistKind, weekStart: string): Promise<boolean> {
    const accepted = kind === "setlist" ? ["setlist"] : [kind, "setlist"];
    return this.records.some((record) => accepted.includes(record.kind) && record.weekStart === weekStart && record.status === "submitted");
  }

  public async clearPendingSetlistBroadcasts(weekStart: string): Promise<void> {
    for (const record of this.records) {
      if (record.weekStart === weekStart && record.status === "submitted" && !record.broadcastSentAt) {
        record.broadcastScheduledFor = undefined;
      }
    }
  }

  public async cancelPartialSetlists(weekStart: string): Promise<void> {
    for (const record of this.records) {
      if (record.weekStart === weekStart && record.status === "submitted" && record.kind !== "setlist") {
        record.status = "cancelled";
        record.broadcastScheduledFor = undefined;
      }
    }
  }
}

async function run(): Promise<void> {
  clockService.setMockTime("2026-08-10 09:00");
  try {
    const repository = new InMemorySetlistRepository();
    const identities = new InMemoryIdentityRepository();
    identities.addMember({
      id: "11111111-1111-4111-8111-111111111111",
      canonicalName: "Test Creator",
      displayName: "Creator",
      status: "active",
      roles: ["member", "superuser", "creator"],
      identifiers: [{ kind: "phone", value: CREATOR_PHONE, verified: true }],
    });
    const setlists = new SetlistService(
      repository as unknown as WorkflowRepository,
      identities,
      new InMemoryWeeklyInterpretationRepository(),
    );

    assert.equal(setlists.detectSubmissionKind("#submit_worship"), null);
    assert.equal(setlists.detectSubmissionKind("#submit_praise"), null);
    assert.equal(setlists.detectSubmissionKind("Songs\n#submit_setlist"), "setlist");

    const worship = await setlists.submit(message("Worship only\n1. Spirit Song\n#submit_setlist"), "worship");
    assert.match(worship.text, /keep waiting for the praise section/i);
    assert.equal(worship.submittedSetlist?.broadcastScheduledFor, undefined);

    const praise = await setlists.submit(message("Praise only\n1. Joyful Song\n#submit_setlist"), "praise");
    assert.match(praise.text, /weekly setlist is now complete/i);
    assert.ok(praise.submittedSetlist?.broadcastScheduledFor);
    assert.equal(repository.records.filter((record) => Boolean(record.broadcastScheduledFor)).length, 1);

    const workflows = new WorkflowService(
      repository as unknown as WorkflowRepository,
      {} as TemporalPhraseService,
      {} as never,
      setlists,
      {} as never,
    );
    const broadcast = await workflows.getSetlistBroadcast(praise.submittedSetlist!.id);
    assert.match(broadcast?.content ?? "", /Worship Setlist/);
    assert.match(broadcast?.content ?? "", /Spirit Song/);
    assert.match(broadcast?.content ?? "", /Praise Setlist/);
    assert.match(broadcast?.content ?? "", /Joyful Song/);

    const worshipCorrection = await setlists.submit(message("Worship only\n1. Corrected Spirit Song\n#submit_setlist"), "worship");
    assert.match(worshipCorrection.text, /worship section has been updated/i);
    assert.equal(repository.records.filter((record) => Boolean(record.broadcastScheduledFor)).length, 1);
    const correctedBroadcast = await workflows.getSetlistBroadcast(worshipCorrection.submittedSetlist!.id);
    assert.match(correctedBroadcast?.content ?? "", /Corrected Spirit Song/);
    assert.match(correctedBroadcast?.content ?? "", /Joyful Song/);

    const combined = await setlists.submit(message("Combined songs\n1. Complete Song\n#submit_setlist"), "combined");
    assert.match(combined.text, /worship\/praise setlist has been saved/i);
    assert.equal(repository.records.filter((record) => record.status === "submitted").length, 1);
    assert.equal(repository.records.find((record) => record.status === "submitted")?.kind, "setlist");
    assert.equal(repository.records.filter((record) => Boolean(record.broadcastScheduledFor)).length, 1);

    const partialAfterCombined = await setlists.submit(message("Praise only\n1. Replacement Song\n#submit_setlist"), "praise");
    assert.match(partialAfterCombined.text, /combined setlist already exists/i);
    assert.equal(repository.records.filter((record) => record.status === "submitted").length, 1);

    clockService.setMockTime("2026-08-16 20:00");
    const lateRepository = new InMemorySetlistRepository();
    const lateSetlists = new SetlistService(
      lateRepository as unknown as WorkflowRepository,
      identities,
      new InMemoryWeeklyInterpretationRepository(),
    );
    const lateSubmission = await lateSetlists.submit(
      message("Worship and Praise Setlist\n1. Late Song\n#submit_setlist"),
      "combined",
    );
    assert.equal(lateSubmission.submittedSetlist?.broadcastScheduledFor, undefined);
    assert.equal(lateRepository.records.some((record) => Boolean(record.broadcastScheduledFor)), false);

    const leaderPhone = "15550001002";
    identities.addMember({
      id: "22222222-2222-4222-8222-222222222222",
      canonicalName: "Assigned Leader",
      displayName: "Assigned Leader",
      status: "active",
      roles: ["member"],
      identifiers: [{ kind: "phone", value: leaderPhone, verified: true }],
    });
    const weekly = new InMemoryWeeklyInterpretationRepository();
    await weekly.save({
      weekStart: "2026-08-10",
      sourceHash: "weekly-source",
      scheduleContext: "Assigned Leader leads praise and worship this week.",
      interpretation: {
        sundayActivityCancelled: false,
        setlistRequired: true,
        assignedMemberNames: ["Assigned Leader"],
        worshipPraiseLeaderNames: ["Assigned Leader"],
        applicableObligations: ["setlist_followup_due"],
        summary: "Normal choir week.",
        ambiguities: [],
      },
      evaluatedAt: clockService.now().toISO()!,
      expiresAt: clockService.now().plus({ weeks: 1 }).toISO()!,
    });
    const leaderRepository = new InMemorySetlistRepository();
    const leaderSetlists = new SetlistService(leaderRepository as unknown as WorkflowRepository, identities, weekly);
    const leaderSubmission = await leaderSetlists.submit(
      message("1. Leader Song\n#submit_setlist", leaderPhone, "Assigned Leader"),
      "combined",
    );
    assert.match(leaderSubmission.text, /has been saved/i);
    assert.equal(leaderRepository.records.length, 1);

    const inlineCorrection = await leaderSetlists.submit({
      ...message("Corrected inline song\n#submit_setlist", leaderPhone, "Assigned Leader"),
      quotedMessage: { id: "old-setlist", text: "Old quoted song" },
    }, "combined");
    assert.match(inlineCorrection.submittedSetlist?.content ?? "", /Corrected inline song/);
    assert.doesNotMatch(inlineCorrection.submittedSetlist?.content ?? "", /Old quoted song/);

    console.log("Setlist workflow self-tests passed.");
  } finally {
    clockService.clearMockTime();
  }
}

function message(text: string, phone = CREATOR_PHONE, displayName = "Creator"): IncomingMessage {
  return {
    id: `message-${Math.random()}`,
    conversationId: CHAT_ID,
    transport: "local-chat",
    sender: {
      id: `${phone}@s.whatsapp.net`,
      displayName,
      identifiers: { participantPhoneJid: `${phone}@s.whatsapp.net` },
    },
    text,
    mentions: [],
    metadata: { conversationKind: "choir" },
  };
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
