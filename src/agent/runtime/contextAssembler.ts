import { clockService } from "../../shared/clockService.js";
import { agentConfig } from "../../config/agentConfig.js";
import { estimateTokens } from "./contextLimits.js";
import type {
  ConversationRepository,
  IdentityRepository,
  MemoryRepository,
  AgentContextAssembler,
} from "../ports.js";
import type { AgentEvent, AgentTurnContext, MemberProfile } from "../types.js";

/** Loads only the bounded state required for one turn. Larger data stays behind tools. */
export class DefaultAgentContextAssembler implements AgentContextAssembler {
  public constructor(
    private readonly identities: IdentityRepository,
    private readonly memory: MemoryRepository,
    private readonly conversations: ConversationRepository,
  ) {}

  public async assemble(event: AgentEvent): Promise<AgentTurnContext> {
    const actor = event.message
      ? await this.identities.resolveSender(event.message.sender)
      : event.actorMemberId
        ? await this.identities.getById(event.actorMemberId)
        : null;
    const weekStart = typeof event.payload.weekStart === "string" ? event.payload.weekStart : undefined;
    const loadMemberProfile = shouldLoadMemberProfile(event, actor);
    const [memoryDirectory, memberProfileBlock, recentConversation] = await Promise.all([
      this.memory.listBlockDirectory({ chatId: event.chatId, memberId: actor?.id, weekStart }),
      actor && loadMemberProfile
        ? this.memory.getBlock({ scopeType: "member", scopeId: actor.id, label: "member_profile" })
        : Promise.resolve(null),
      event.source === "transport" && event.chatId
        ? this.conversations.getRecent(
            event.chatId,
            agentConfig.context.recentConversation.messageLimit,
          )
        : Promise.resolve([]),
    ]);

    const memberProfile = parseMemberProfile(memberProfileBlock?.value);
    const approximateCharacters = JSON.stringify({ actor, memberProfile, memoryDirectory, recentConversation }).length;

    return {
      now: clockService.now("Europe/London").toISO()!,
      timezone: "Europe/London",
      actor,
      memberProfile,
      memoryDirectory,
      memoryBlocks: [],
      memberFacts: [],
      activeObligations: [],
      recentConversation,
      contextBudget: {
        recentMessageLimit: agentConfig.context.recentConversation.messageLimit,
        approximateCharacters,
        approximateTokens: estimateTokens(approximateCharacters),
      },
    };
  }
}

/**
 * Identity profile values are useful when a transport name has changed or the
 * member is explicitly discussing their name. Ordinary operational turns only
 * need the resolved backend identity; the profile remains discoverable through
 * memoryDirectory and read_context_memory.
 */
function shouldLoadMemberProfile(
  event: AgentEvent,
  actor: { displayName: string; canonicalName: string | null } | null,
): boolean {
  const message = event.message;
  if (!message) return false;
  if (actor?.canonicalName === null) return true;
  const observed = message.sender.displayName?.trim().toLocaleLowerCase();
  const resolved = actor?.displayName.trim().toLocaleLowerCase();
  if (observed && resolved && observed !== resolved) return true;
  return /\b(call me|my name is|name me|preferred name|nickname|alias)\b/i.test(message.text);
}

function parseMemberProfile(value?: string): MemberProfile | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<MemberProfile>;
    if (typeof parsed.preferredDisplayName !== "string") return null;
    return {
      preferredDisplayName: parsed.preferredDisplayName,
      transportNames: parsed.transportNames && typeof parsed.transportNames === "object" && !Array.isArray(parsed.transportNames)
        ? parsed.transportNames
        : {},
      knownAliases: Array.isArray(parsed.knownAliases)
        ? parsed.knownAliases.filter((alias): alias is string => typeof alias === "string")
        : [],
    };
  } catch {
    return null;
  }
}
