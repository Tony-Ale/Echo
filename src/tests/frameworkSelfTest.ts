import assert from "node:assert/strict";
import { PluginRegistry } from "../framework/plugins/pluginRegistry.js";
import { PromptRegistry } from "../framework/prompts/promptRegistry.js";
import { validateDeploymentProfile } from "../framework/deployments/types.js";
import { WhatsAppFrameworkAdapter } from "../integrations/whatsapp/frameworkAdapter.js";
import { AGENT_CANON_PROMPT_PACK } from "../prompts/canon/agentCanon.js";
import { TOOL_AGENT_PROMPT_PACK } from "../prompts/runtime/toolAgent.js";
import { CHOIR_OPERATIONS_PROMPT_PACK } from "../prompts/domains/choir/operations.js";
import { ECHO_DEPLOYMENT_PROMPT_PACK } from "../prompts/deployments/echo.js";
import { createEchoDeploymentProfile } from "../deployments/echo/profile.js";
import { createDynamicPromptResolver } from "../agent/runtime/dynamicPrompt.js";
import type { AgentPlannerInput } from "../agent/types.js";
import type { WAMessage } from "@whiskeysockets/baileys";
import { applyWhatsAppConversationPolicy } from "../integrations/whatsapp/conversationPolicy.js";
import { isEchoMentioned } from "../integrations/whatsapp/messageUtils.js";
import { echoCapabilityRegistry } from "../deployments/echo/capabilities.js";
import { buildHelpMessage } from "../app/helpText.js";

const ECHO_DEPLOYMENT_PROFILE = createEchoDeploymentProfile();

async function run(): Promise<void> {
  testWhatsAppAdapterContract();
  await testPluginDependencyOrdering();
  await testPluginValidation();
  testPromptComposition();
  testCapabilityRegistry();
  testDeploymentProfile();
  testWhatsAppConversationPolicy();
  console.log("Framework contract self-tests passed.");
}

function testWhatsAppConversationPolicy(): void {
  const message = {
    id: "policy-message",
    conversationId: "choir@g.us",
    transport: "whatsapp",
    sender: { id: "200@s.whatsapp.net", displayName: "Member", identifiers: {} },
    text: "Hello",
    mentions: [],
    mentionedAgent: true,
    metadata: {},
  };
  const allowed = applyWhatsAppConversationPolicy(message, {
    groupId: "choir@g.us",
    allowAllGroups: false,
    privateSenderAllowed: false,
  });
  assert.equal(allowed?.metadata.conversationKind, "choir");
  assert.equal(applyWhatsAppConversationPolicy({ ...message, conversationId: "other@g.us" }, {
    groupId: "choir@g.us",
    allowAllGroups: false,
    privateSenderAllowed: false,
  }), null);
  assert.equal(applyWhatsAppConversationPolicy({ ...message, conversationId: "other@g.us" }, {
    groupId: "choir@g.us",
    allowAllGroups: true,
    privateSenderAllowed: false,
  })?.metadata.conversationKind, "choir");
  assert.equal(applyWhatsAppConversationPolicy({ ...message, mentionedAgent: false }, {
    groupId: "choir@g.us",
    allowAllGroups: true,
    privateSenderAllowed: false,
  }), null);
}

function testWhatsAppAdapterContract(): void {
  const adapter = new WhatsAppFrameworkAdapter(() => ["999@s.whatsapp.net"]);
  const framework = adapter.toFrameworkMessage({
    key: {
      id: "message-1",
      remoteJid: "choir@g.us",
      participant: "200@s.whatsapp.net",
      participantPn: "200@s.whatsapp.net",
    },
    pushName: "Member",
    message: {
      extendedTextMessage: {
        text: "@999 Please explain this",
        contextInfo: {
          mentionedJid: ["999@s.whatsapp.net"],
          stanzaId: "quoted-1",
          participant: "999@s.whatsapp.net",
          quotedMessage: { conversation: "Current rota" },
        },
      },
    },
  } as WAMessage);

  assert.equal(framework?.transport, "whatsapp");
  assert.equal(framework?.conversationId, "choir@g.us");
  assert.equal(framework?.sender.displayName, "Member");
  assert.equal(framework?.quotedMessage?.id, "quoted-1");

  const native = adapter.toNativeMessage({
    text: "Reply",
    mentions: ["200@s.whatsapp.net"],
  });
  assert.deepEqual((native as { mentions?: string[] }).mentions, ["200@s.whatsapp.net"]);

  const tagged = adapter.toNativeMessage({
    text: "Hello @Member",
    mentions: ["200@s.whatsapp.net"],
    mentionLabels: ["Member"],
  }) as { text?: string; mentions?: string[] };
  assert.equal(tagged.text, "Hello @200");
  assert.deepEqual(tagged.mentions, ["200@s.whatsapp.net"]);

  assert.equal(isEchoMentioned(["999@s.whatsapp.net"], ["999@lid", "999@s.whatsapp.net"]), true);
  assert.equal(isEchoMentioned(["888@lid"], ["999@s.whatsapp.net", "888:4@lid"]), true);
}

async function testPluginDependencyOrdering(): Promise<void> {
  const initialized: string[] = [];
  const registry = new PluginRegistry();
  registry.register({
    manifest: { id: "runtime", version: "1.0.0", kind: "runtime", description: "Runtime" },
    async initialize() { initialized.push("runtime"); },
  });
  registry.register({
    manifest: {
      id: "domain",
      version: "1.0.0",
      kind: "domain",
      description: "Domain",
      dependencies: ["runtime"],
    },
    async initialize() { initialized.push("domain"); },
  });

  const activated = await registry.activate(["domain"]);
  assert.deepEqual(activated.plugins.map((plugin) => plugin.manifest.id), ["runtime", "domain"]);
  assert.deepEqual(initialized, ["runtime", "domain"]);
}

async function testPluginValidation(): Promise<void> {
  const missing = new PluginRegistry();
  missing.register({
    manifest: { id: "domain", version: "1.0.0", kind: "domain", description: "Domain", dependencies: ["missing"] },
  });
  await assert.rejects(() => missing.activate(["domain"]), /not registered/);

  const cyclic = new PluginRegistry();
  cyclic.register({
    manifest: { id: "one", version: "1.0.0", kind: "runtime", description: "One", dependencies: ["two"] },
  });
  cyclic.register({
    manifest: { id: "two", version: "1.0.0", kind: "domain", description: "Two", dependencies: ["one"] },
  });
  await assert.rejects(() => cyclic.activate(["one"]), /cycle/);
}

function testPromptComposition(): void {
  const prompts = new PromptRegistry();
  for (const pack of [
    AGENT_CANON_PROMPT_PACK,
    TOOL_AGENT_PROMPT_PACK,
    CHOIR_OPERATIONS_PROMPT_PACK,
    ECHO_DEPLOYMENT_PROMPT_PACK,
  ]) prompts.register(pack);

  const composed = prompts.compose(ECHO_DEPLOYMENT_PROFILE.promptPackIds);
  assert.ok(composed.indexOf("<canon:canon.identity>") < composed.indexOf("<runtime:runtime.tools.core>"));
  assert.ok(composed.indexOf("<runtime:runtime.tools.core>") < composed.indexOf("<domain:domain.choir.operations>"));
  assert.match(composed, /You are Echo/);
  assert.match(composed, /easy to scan/);
  assert.match(composed, /inspect_agent_capabilities/);
  assert.match(composed, /internal tool names are implementation details/i);
  const resolvePrompt = createDynamicPromptResolver(prompts, ECHO_DEPLOYMENT_PROFILE.promptPackIds);
  const casualPrompt = resolvePrompt(promptInput("transport", "message_received"));
  const scheduledPrompt = resolvePrompt(promptInput("scheduler", "weekly_rota_reminder_due"));
  assert.doesNotMatch(casualPrompt, /weekly_rota_reminder_due/);
  assert.match(scheduledPrompt, /weekly_rota_reminder_due/);
  assert.throws(() => prompts.register(AGENT_CANON_PROMPT_PACK), /already registered/);
}

function testCapabilityRegistry(): void {
  const memberIds = echoCapabilityRegistry.listForRoles(["member"]).map(({ id }) => id);
  assert.ok(memberIds.includes("choir_knowledge"));
  assert.ok(memberIds.includes("one_time_reminders"));
  assert.equal(memberIds.includes("recurring_agent_tasks"), false);
  assert.equal(memberIds.includes("application_clock"), false);

  const superuserIds = echoCapabilityRegistry.listForRoles(["member", "superuser"]).map(({ id }) => id);
  assert.ok(superuserIds.includes("recurring_agent_tasks"));
  assert.ok(superuserIds.includes("schedule_visibility"));
  assert.equal(superuserIds.includes("application_clock"), false);

  const creatorIds = echoCapabilityRegistry.listForRoles(["member", "superuser", "creator"]).map(({ id }) => id);
  assert.ok(creatorIds.includes("application_clock"));
  assert.ok(creatorIds.includes("manual_sunday_reminder"));

  assert.doesNotMatch(buildHelpMessage(["member"]), /creator-only `clock`/i);
  assert.match(buildHelpMessage(["member", "superuser", "creator"]), /creator-only `clock`/i);
}

function promptInput(source: "transport" | "scheduler", type: string): AgentPlannerInput {
  return {
    event: { eventKey: `prompt-${source}`, source, type, payload: {} },
    context: {
      now: "2026-08-16T10:00:00.000+01:00",
      timezone: "Europe/London",
      actor: null,
      memberProfile: null,
      memoryDirectory: [],
      memoryBlocks: [],
      memberFacts: [],
      activeObligations: [],
      recentConversation: [],
      contextBudget: { recentMessageLimit: 2, approximateCharacters: 0, approximateTokens: 0 },
    },
    toolCatalog: [],
    availableCapabilities: [],
    previousSteps: [],
    maxSteps: 6,
  };
}

function testDeploymentProfile(): void {
  assert.doesNotThrow(() => validateDeploymentProfile(ECHO_DEPLOYMENT_PROFILE));
  const localProfile = createEchoDeploymentProfile({ transportPluginId: "transport.local-chat" });
  assert.equal(localProfile.transportPluginId, "transport.local-chat");
  assert.ok(localProfile.pluginIds.includes("transport.local-chat"));
  assert.throws(() => validateDeploymentProfile({
    ...ECHO_DEPLOYMENT_PROFILE,
    transportPluginId: "transport.discord",
  }), /does not include its transport plugin/);
}

void run();
