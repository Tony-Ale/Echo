import { randomUUID } from "node:crypto";
import { clockService } from "../../shared/clockService.js";
import type { ExternalIdentity, IncomingMessage, OutgoingMessage } from "../../framework/contracts/messages.js";
import type { ScheduledTask, SchedulerPort, WeeklyScheduledTask } from "../../framework/ports/index.js";
import { agentConfig } from "../../config/agentConfig.js";
import type {
  AgentContextAssembler,
  AgentApproval,
  ApprovalRepository,
  AgentJournal,
  AgentMessageTransport,
  ConversationRepository,
  IdentityRepository,
  MemoryRepository,
  ObligationRepository,
  ScheduledAgentTaskRepository,
  WeeklyInterpretation,
  WeeklyInterpretationRepository,
} from "../ports.js";
import type {
  AgentEvent,
  AgentObligation,
  AgentPlanner,
  AgentPlannerInput,
  AgentTurnContext,
  AgentTurnResult,
  ConversationEntry,
  MemberIdentity,
  MemoryBlock,
  ObligationStatus,
  AgentDecision,
  AgentProcedureStep,
  RecurringSchedule,
  ScheduledAgentTask,
} from "../types.js";

export interface FakeMember extends MemberIdentity {
  identifiers: Array<{ kind: "phone" | "whatsapp_jid" | "push_name" | "alias"; value: string; verified: boolean }>;
}

export class InMemoryIdentityRepository implements IdentityRepository {
  public readonly members: FakeMember[] = [];

  public addMember(member: FakeMember): void {
    this.members.push(member);
  }

  public async resolveSender(sender: ExternalIdentity): Promise<MemberIdentity | null> {
    const transportValues = [sender.id, ...Object.values(sender.identifiers)].filter((value): value is string => Boolean(value));
    const authoritative = this.members.find((member) => member.identifiers.some((identifier) =>
      identifier.verified &&
      (identifier.kind === "phone" || identifier.kind === "whatsapp_jid") &&
      transportValues.some((value) => normalizePhone(value) === normalizePhone(identifier.value))
    ));
    return authoritative ? stripIdentifiers(authoritative) : null;
  }

  public async getById(memberId: string): Promise<MemberIdentity | null> {
    const member = this.members.find((candidate) => candidate.id === memberId && candidate.status === "active");
    return member ? stripIdentifiers(member) : null;
  }

  public async resolveByName(name: string): Promise<MemberIdentity[]> {
    const normalized = normalizeName(name);
    return this.members
      .filter((member) =>
        (member.canonicalName ? normalizeName(member.canonicalName) === normalized : false) ||
        normalizeName(member.displayName) === normalized ||
        member.identifiers.some((identifier) =>
          (identifier.kind === "alias" || identifier.kind === "push_name") && normalizeName(identifier.value) === normalized
        )
      )
      .map(stripIdentifiers);
  }

  public async resolveByNames(names: string[]): Promise<Array<{ name: string; matches: MemberIdentity[] }>> {
    return Promise.all(names.map(async (name) => ({ name, matches: await this.resolveByName(name) })));
  }

  public async getMentionTargets(memberIds: string[], transport: string): Promise<string[]> {
    if (transport !== "whatsapp") return [];
    return memberIds.flatMap((memberId) => {
      const member = this.members.find((candidate) => candidate.id === memberId);
      const jid = member?.identifiers.find((identifier) => identifier.kind === "whatsapp_jid" && identifier.verified)?.value;
      const phone = member?.identifiers.find((identifier) => identifier.kind === "phone" && identifier.verified)?.value;
      return jid ? [jid] : phone ? [`${normalizePhone(phone)}@s.whatsapp.net`] : [];
    });
  }

  public async addIdentifier(input: {
    memberId: string;
    kind: "phone" | "whatsapp_jid" | "push_name" | "alias";
    value: string;
    verified: boolean;
  }): Promise<void> {
    const member = this.members.find((candidate) => candidate.id === input.memberId);
    if (!member) throw new Error("Member not found.");
    member.identifiers = member.identifiers.filter((identifier) =>
      !(identifier.kind === input.kind && normalizeIdentifier(identifier.value) === normalizeIdentifier(input.value))
    );
    member.identifiers.push({ kind: input.kind, value: input.value, verified: input.verified });
  }

  public async onboardSender(input: {
    sender: ExternalIdentity;
    transport: string;
    chatId: string;
  }): Promise<MemberIdentity> {
    const existing = await this.resolveSender(input.sender);
    if (existing) return existing;
    const value = input.sender.identifiers.participantPhoneJid
      ?? input.sender.identifiers.phone
      ?? input.sender.identifiers.whatsappJid
      ?? input.sender.id;
    if (!normalizePhone(value)) throw new Error("Missing authoritative sender identifier.");
    const member: FakeMember = {
      id: randomUUID(),
      canonicalName: null,
      displayName: input.sender.displayName?.trim() || "Choir member",
      status: "active",
      roles: ["member"],
      identifiers: [{ kind: value.includes("@") ? "whatsapp_jid" : "phone", value, verified: true }],
    };
    this.members.push(member);
    return stripIdentifiers(member);
  }

  public async setCanonicalName(input: { actorMemberId: string; memberId: string; canonicalName: string }): Promise<void> {
    const member = this.members.find((candidate) => candidate.id === input.memberId);
    if (!member) throw new Error("Member not found.");
    member.canonicalName = input.canonicalName.trim();
  }
}

export class InMemoryMemoryRepository implements MemoryRepository {
  public readonly blocks: MemoryBlock[] = [];
  public readonly facts = new Map<string, Array<{
    category: string;
    fact: string;
    importance: "low" | "normal" | "high";
    reinforced: number;
    sequence: number;
  }>>();
  private factSequence = 0;

  public async getBlocks(input: { chatId?: string; memberId?: string; weekStart?: string }): Promise<MemoryBlock[]> {
    const now = clockService.now().toMillis();
    return this.blocks.filter((block) => {
      if (block.expiresAt && clockService.Date(block.expiresAt).getTime() <= now) return false;
      if (block.scopeType === "agent") return true;
      if (block.scopeType === "chat") return block.scopeId === input.chatId;
      if (block.scopeType === "member") return block.scopeId === input.memberId;
      return block.scopeId === input.weekStart;
    });
  }

  public async getBlock(input: {
    scopeType: MemoryBlock["scopeType"];
    scopeId: string;
    label: string;
  }): Promise<MemoryBlock | null> {
    const block = this.blocks.find((candidate) =>
      candidate.scopeType === input.scopeType
      && candidate.scopeId === input.scopeId
      && candidate.label === input.label
    );
    if (!block || (block.expiresAt && clockService.Date(block.expiresAt).getTime() <= clockService.now().toMillis())) {
      return null;
    }
    return block;
  }

  public async listBlockDirectory(input: { chatId?: string; memberId?: string; weekStart?: string }) {
    const blocks = await this.getBlocks(input);
    return blocks.map(({ value: _value, ...entry }) => entry);
  }

  public async upsertBlock(input: Omit<MemoryBlock, "id" | "version"> & { id?: string }): Promise<MemoryBlock> {
    const index = this.blocks.findIndex((block) =>
      block.scopeType === input.scopeType && block.scopeId === input.scopeId && block.label === input.label
    );
    const block: MemoryBlock = {
      ...input,
      id: input.id ?? this.blocks[index]?.id ?? randomUUID(),
      value: input.value.slice(0, input.characterLimit),
      version: (this.blocks[index]?.version ?? 0) + 1,
    };
    if (index >= 0) this.blocks[index] = block;
    else this.blocks.push(block);
    return block;
  }

  public async getMemberFacts(memberId: string, limit: number, query?: string): Promise<string[]> {
    const search = query?.trim().toLowerCase();
    return [...(this.facts.get(memberId) ?? [])]
      .filter((fact) => !search || fact.fact.toLowerCase().includes(search))
      .sort(compareMemoryRelevance)
      .slice(0, limit)
      .map((fact) => fact.fact);
  }

  public async rememberMemberFact(input: {
    memberId: string;
    category: string;
    fact: string;
    sourceMessageId?: string;
    importance: "low" | "normal" | "high";
    verified: boolean;
  }): Promise<void> {
    const facts = this.facts.get(input.memberId) ?? [];
    const normalized = normalizeName(input.fact);
    const existing = facts.find((fact) => fact.category === input.category && normalizeName(fact.fact) === normalized);
    if (existing) {
      existing.fact = input.fact;
      existing.importance = higherImportance(existing.importance, input.importance);
      existing.reinforced += 1;
      existing.sequence = ++this.factSequence;
    } else {
      facts.push({ category: input.category, fact: input.fact, importance: input.importance, reinforced: 1, sequence: ++this.factSequence });
    }
    this.facts.set(
      input.memberId,
      [...facts].sort(compareMemoryRelevance).slice(0, agentConfig.context.memberMemory.maximumFacts),
    );
  }

  public async updateMemberProfile(input: {
    memberId: string;
    transport: string;
    transportName?: string;
    preferredDisplayName?: string;
    aliases: string[];
  }): Promise<import("../types.js").MemberProfile> {
    const existing = this.blocks.find((block) =>
      block.scopeType === "member" && block.scopeId === input.memberId && block.label === "member_profile"
    );
    const current = existing ? JSON.parse(existing.value) as import("../types.js").MemberProfile : {
      preferredDisplayName: input.transportName ?? "Choir member",
      transportNames: {},
      knownAliases: [],
    };
    const preferredDisplayName = input.preferredDisplayName?.trim()
      || input.transportName?.trim()
      || current.preferredDisplayName;
    const profile: import("../types.js").MemberProfile = {
      preferredDisplayName,
      transportNames: {
        ...current.transportNames,
        ...(input.transportName ? { [input.transport]: input.transportName.trim() } : {}),
      },
      knownAliases: [...new Set([...current.knownAliases, ...input.aliases])]
        .filter((alias) => normalizeName(alias) !== normalizeName(preferredDisplayName))
        .slice(0, 10),
    };
    await this.upsertBlock({
      scopeType: "member",
      scopeId: input.memberId,
      label: "member_profile",
      description: "Permanent member profile used for names and conversational identity.",
      value: JSON.stringify(profile),
      characterLimit: 3000,
      readOnly: false,
    });
    return profile;
  }

  public async deleteBlock(input: { scopeType: MemoryBlock["scopeType"]; scopeId: string; label: string }): Promise<void> {
    const index = this.blocks.findIndex((block) =>
      block.scopeType === input.scopeType && block.scopeId === input.scopeId && block.label === input.label
    );
    if (index >= 0) this.blocks.splice(index, 1);
  }

  public async pruneExpiredBlocks(): Promise<number> {
    const before = this.blocks.length;
    const now = clockService.now().toMillis();
    for (let index = this.blocks.length - 1; index >= 0; index -= 1) {
      const expiry = this.blocks[index].expiresAt;
      if (expiry && clockService.Date(expiry).getTime() <= now) this.blocks.splice(index, 1);
    }
    return before - this.blocks.length;
  }
}

function compareMemoryRelevance(
  left: { importance: "low" | "normal" | "high"; reinforced: number; sequence: number },
  right: { importance: "low" | "normal" | "high"; reinforced: number; sequence: number },
): number {
  return importanceRank(right.importance) - importanceRank(left.importance)
    || right.reinforced - left.reinforced
    || right.sequence - left.sequence;
}

function importanceRank(value: "low" | "normal" | "high"): number {
  return value === "high" ? 3 : value === "normal" ? 2 : 1;
}

function higherImportance(
  left: "low" | "normal" | "high",
  right: "low" | "normal" | "high",
): "low" | "normal" | "high" {
  return importanceRank(left) >= importanceRank(right) ? left : right;
}

export class InMemoryObligationRepository implements ObligationRepository {
  public readonly obligations: AgentObligation[] = [];

  public async listActive(chatId?: string): Promise<AgentObligation[]> {
    return this.obligations.filter((obligation) =>
      ["pending", "waiting_for_data", "waiting_for_member"].includes(obligation.status) &&
      (!chatId || obligation.chatId === chatId)
    );
  }

  public async upsert(input: Omit<AgentObligation, "id">): Promise<AgentObligation> {
    const index = this.obligations.findIndex((obligation) => obligation.naturalKey === input.naturalKey);
    const obligation = { ...input, id: index >= 0 ? this.obligations[index].id : randomUUID() };
    if (index >= 0) this.obligations[index] = obligation;
    else this.obligations.push(obligation);
    return obligation;
  }

  public async updateStatus(id: string, status: ObligationStatus, reason?: string): Promise<AgentObligation> {
    const obligation = this.obligations.find((candidate) => candidate.id === id);
    if (!obligation) throw new Error("Obligation not found.");
    obligation.status = status;
    obligation.lastEvaluatedAt = clockService.now().toISO()!;
    if (reason) obligation.payload = { ...obligation.payload, statusReason: reason };
    return obligation;
  }
}

export class InMemoryScheduledAgentTaskRepository implements ScheduledAgentTaskRepository {
  public readonly tasks: ScheduledAgentTask[] = [];

  public async create(input: {
    naturalKey: string;
    chatId: string;
    ownerMemberId: string;
    objective: string;
    rawSchedulePhrase: string;
    schedule: RecurringSchedule;
    nextRunAt: string;
  }): Promise<{ task: ScheduledAgentTask; created: boolean }> {
    const duplicate = this.tasks.find((task) =>
      task.naturalKey === input.naturalKey && ["active", "paused"].includes(task.status)
    );
    if (duplicate) return { task: duplicate, created: false };
    const now = clockService.now().toISO()!;
    const task: ScheduledAgentTask = {
      ...input,
      id: randomUUID(),
      status: "active",
      procedure: [],
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.push(task);
    return { task, created: true };
  }

  public async get(id: string): Promise<ScheduledAgentTask | null> {
    return this.tasks.find((task) => task.id === id) ?? null;
  }

  public async listActive(): Promise<ScheduledAgentTask[]> {
    return this.tasks.filter((task) => task.status === "active");
  }

  public async listOwned(ownerMemberId: string, chatId: string): Promise<ScheduledAgentTask[]> {
    return this.tasks.filter((task) =>
      task.ownerMemberId === ownerMemberId
      && task.chatId === chatId
      && ["active", "paused"].includes(task.status)
    );
  }

  public async updateOwned(
    id: string,
    ownerMemberId: string,
    updates: Partial<Pick<ScheduledAgentTask, "naturalKey" | "objective" | "rawSchedulePhrase" | "schedule" | "status" | "nextRunAt">>,
  ): Promise<ScheduledAgentTask | null> {
    const task = this.tasks.find((candidate) => candidate.id === id && candidate.ownerMemberId === ownerMemberId);
    if (!task || !["active", "paused"].includes(task.status)) return null;
    Object.assign(task, updates, { updatedAt: clockService.now().toISO()! });
    return task;
  }

  public async claimExecution(input: {
    id: string;
    executionKey: string;
    expectedRunAt?: string;
    nextRunAt: string;
  }): Promise<ScheduledAgentTask | null> {
    const task = this.tasks.find((candidate) => candidate.id === input.id);
    if (!task || task.status !== "active" || task.lastExecutionKey === input.executionKey) return null;
    if (input.expectedRunAt && task.nextRunAt !== input.expectedRunAt) return null;
    task.lastExecutionKey = input.executionKey;
    task.lastRunAt = clockService.now().toISO()!;
    task.nextRunAt = input.nextRunAt;
    return task;
  }

  public async recordExecution(input: {
    id: string;
    executionKey: string;
    procedure?: AgentProcedureStep[];
    succeeded: boolean;
    error?: string;
  }): Promise<void> {
    const task = this.tasks.find((candidate) =>
      candidate.id === input.id && candidate.lastExecutionKey === input.executionKey
    );
    if (!task) return;
    if (input.procedure?.length) task.procedure = input.procedure;
    task.lastSuccessAt = input.succeeded ? clockService.now().toISO()! : task.lastSuccessAt;
    task.lastError = input.succeeded ? undefined : input.error ?? "Scheduled task execution failed.";
  }
}

export class InMemorySchedulerPort implements SchedulerPort {
  public readonly oneTime = new Map<string, ScheduledTask>();
  public readonly weekly = new Map<string, WeeklyScheduledTask>();

  public scheduleOnce(task: ScheduledTask): void {
    this.oneTime.set(task.id, task);
  }

  public scheduleWeekly(task: WeeklyScheduledTask): void {
    this.weekly.set(task.id, task);
  }

  public cancel(taskId: string): void {
    this.oneTime.delete(taskId);
    this.weekly.delete(taskId);
  }

  public async run(taskId: string): Promise<void> {
    const task = this.oneTime.get(taskId) ?? this.weekly.get(taskId);
    if (!task) throw new Error(`Scheduled task '${taskId}' was not found.`);
    await task.action();
    if (this.oneTime.has(taskId)) this.oneTime.delete(taskId);
  }
}

export class InMemoryConversationRepository implements ConversationRepository {
  public readonly entries = new Map<string, Array<ConversationEntry & { externalMessageId?: string }>>();
  private readonly externalIds = new Set<string>();

  public async append(input: {
    externalMessageId?: string;
    chatId: string;
    role: ConversationEntry["role"];
    content: string;
    senderName?: string;
  }): Promise<void> {
    const externalKey = input.externalMessageId ? `${input.chatId}:${input.externalMessageId}` : undefined;
    if (externalKey && this.externalIds.has(externalKey)) return;
    if (externalKey) this.externalIds.add(externalKey);
    const entries = this.entries.get(input.chatId) ?? [];
    entries.push({
      role: input.role,
      content: input.content,
      senderName: input.senderName,
      createdAt: clockService.now().toISO()!,
      externalMessageId: input.externalMessageId,
    });
    this.entries.set(input.chatId, entries);
  }

  public async getRecent(chatId: string, limit: number): Promise<ConversationEntry[]> {
    return (this.entries.get(chatId) ?? []).slice(-limit);
  }

  public async search(chatId: string, query: string, limit: number, excludeExternalMessageId?: string): Promise<ConversationEntry[]> {
    const terms = query.toLowerCase().match(/[a-z0-9']{2,}/g) ?? [];
    return (this.entries.get(chatId) ?? [])
      .filter((entry) => entry.externalMessageId !== excludeExternalMessageId)
      .filter((entry) => terms.some((term) => `${entry.senderName ?? ""} ${entry.content}`.toLowerCase().includes(term)))
      .slice(-limit);
  }
}

export class InMemoryAgentJournal implements AgentJournal {
  public readonly events = new Map<string, { id: string; result?: AgentTurnResult }>();
  public readonly executions: Array<{ toolName: string; status: string; idempotencyKey: string }> = [];
  private readonly turnEvents = new Map<string, string>();

  public async beginEvent(event: AgentEvent): Promise<{ eventId: string; duplicateResult?: AgentTurnResult }> {
    const existing = this.events.get(event.eventKey);
    if (existing) return { eventId: existing.id, duplicateResult: existing.result };
    const record = { id: randomUUID() };
    this.events.set(event.eventKey, record);
    return { eventId: record.id };
  }

  public async beginTurn(eventId: string): Promise<string> {
    const turnId = randomUUID();
    this.turnEvents.set(turnId, eventId);
    return turnId;
  }

  public async recordToolExecution(input: { toolName: string; status: string; idempotencyKey: string }): Promise<void> {
    const existing = this.executions.find((execution) => execution.idempotencyKey === input.idempotencyKey);
    if (existing) existing.status = input.status;
    else this.executions.push(input);
  }

  public async completeTurn(turnId: string, result: AgentTurnResult): Promise<void> {
    const eventId = this.turnEvents.get(turnId);
    const record = [...this.events.values()].find((event) => event.id === eventId);
    if (record) record.result = result;
  }

  public async failTurn(_turnId: string, _error: string): Promise<void> {}

  public async failEvent(eventId: string, error: string): Promise<void> {
    const record = [...this.events.values()].find((event) => event.id === eventId);
    if (record) record.result = { eventKey: "failed", status: "failed", reply: null, steps: [], error };
  }
}

export class InMemoryApprovalRepository implements ApprovalRepository {
  public readonly approvals: AgentApproval[] = [];

  public async create(input: Omit<AgentApproval, "id" | "status">): Promise<AgentApproval> {
    const approval: AgentApproval = { ...input, id: randomUUID(), status: "pending" };
    this.approvals.push(approval);
    return approval;
  }

  public async attachConfirmationMessage(approvalId: string, messageId: string): Promise<void> {
    const approval = this.approvals.find((candidate) => candidate.id === approvalId);
    if (approval) approval.confirmationMessageId = messageId;
  }

  public async findPendingByConfirmationMessage(messageId: string): Promise<AgentApproval | null> {
    return this.approvals.find((approval) =>
      approval.confirmationMessageId === messageId &&
      approval.status === "pending" &&
      clockService.Date(approval.expiresAt).getTime() > clockService.now().toMillis()
    ) ?? null;
  }

  public async updateStatus(id: string, status: AgentApproval["status"]): Promise<void> {
    const approval = this.approvals.find((candidate) => candidate.id === id);
    if (approval) approval.status = status;
  }
}

export class InMemoryWeeklyInterpretationRepository implements WeeklyInterpretationRepository {
  public readonly values: WeeklyInterpretation[] = [];

  public async get(weekStart: string, sourceHash: string): Promise<WeeklyInterpretation | null> {
    return this.values.find((value) =>
      value.weekStart === weekStart
      && value.sourceHash === sourceHash
      && clockService.Date(value.expiresAt).getTime() > clockService.now().toMillis()
    ) ?? null;
  }

  public async getLatest(weekStart: string): Promise<WeeklyInterpretation | null> {
    return this.values
      .filter((value) => value.weekStart === weekStart && clockService.Date(value.expiresAt).getTime() > clockService.now().toMillis())
      .sort((left, right) => right.evaluatedAt.localeCompare(left.evaluatedAt))[0] ?? null;
  }

  public async save(input: Omit<WeeklyInterpretation, "id">): Promise<WeeklyInterpretation> {
    const value = { ...input, id: randomUUID() };
    const index = this.values.findIndex((candidate) =>
      candidate.weekStart === input.weekStart && candidate.sourceHash === input.sourceHash
    );
    if (index >= 0) this.values[index] = value;
    else this.values.push(value);
    return value;
  }
}

export class ScriptedAgentPlanner implements AgentPlanner {
  public readonly modelName = "scripted-test-model";

  public constructor(private readonly handler: (input: AgentPlannerInput) => AgentDecision | Promise<AgentDecision>) {}

  public decide(input: AgentPlannerInput): Promise<AgentDecision> {
    return Promise.resolve(this.handler(input));
  }
}

export class FakeAgentTransport implements AgentMessageTransport {
  public readonly sent: Array<{ chatId: string; reply: OutgoingMessage }> = [];

  public async send(chatId: string, reply: OutgoingMessage): Promise<{ messageId: string }> {
    this.sent.push({ chatId, reply });
    return { messageId: `echo-${this.sent.length}` };
  }
}

export class StaticContextAssembler implements AgentContextAssembler {
  public constructor(private readonly context: AgentTurnContext) {}
  public async assemble(): Promise<AgentTurnContext> {
    return this.context;
  }
}

export class GroupChatSimulator {
  public readonly transcript: Array<{ sender: string; text: string; reply?: OutgoingMessage | null }> = [];
  private sequence = 0;

  public constructor(
    private readonly chatId: string,
    private readonly handler: (message: IncomingMessage) => Promise<OutgoingMessage | null>,
  ) {}

  public async send(input: {
    senderId: string;
    senderName: string;
    text: string;
    quotedMessageId?: string;
    quotedText?: string;
  }): Promise<OutgoingMessage | null> {
    this.sequence += 1;
    const message: IncomingMessage = {
      id: `user-${this.sequence}`,
      conversationId: this.chatId,
      transport: "whatsapp",
      sender: { id: input.senderId, displayName: input.senderName, identifiers: { participantPhoneJid: input.senderId } },
      text: input.text,
      mentions: ["echo@s.whatsapp.net"],
      mentionedAgent: true,
      repliedToAgent: Boolean(input.quotedMessageId),
      quotedMessage: input.quotedText
          ? { id: input.quotedMessageId, authorId: "echo@s.whatsapp.net", text: input.quotedText }
          : undefined,
      metadata: {},
    };
    const reply = await this.handler(message);
    this.transcript.push({ sender: input.senderName, text: input.text, reply });
    return reply;
  }
}

function stripIdentifiers(member: FakeMember): MemberIdentity {
  const { identifiers: _identifiers, ...identity } = member;
  return identity;
}

function normalizePhone(value: string): string {
  return value.split("@")[0].split(":")[0].replace(/\D/g, "");
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function normalizeIdentifier(value: string): string {
  return /\d/.test(value) ? normalizePhone(value) : normalizeName(value);
}
