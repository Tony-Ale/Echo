import assert from "node:assert/strict";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { RunnableLambda } from "@langchain/core/runnables";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { z } from "zod";
import {
  calculateBackoffMs,
  ResilientChatModel,
  isRetryableModelError,
} from "../integrations/models/resilientChatModel.js";
import { LangChainModelRegistry } from "../integrations/models/modelRegistry.js";
import { parseModelConfiguration } from "../integrations/models/modelConfiguration.js";
import { CHAT_MODEL_ROLES, type ChatModelConfiguration } from "../framework/models/types.js";
import { parseAgentConfiguration } from "../config/agentConfig.js";

const TEST_FAILOVER = { initialCooldownMs: 60_000, maximumCooldownMs: 86_400_000 };

async function run(): Promise<void> {
  await testTextInvocationFallsBack();
  await testStructuredInvocationFallsBack();
  await testInvalidRequestDoesNotFallBack();
  testProviderAndRoleRegistry();
  testOpenRouterProviderRegistry();
  testYamlConfigurationFiltersUnavailableOptionalProviders();
  testRetryClassification();
  testIncreasingBackoff();
  testAgentConfigurationValidation();
  console.log("Model infrastructure self-tests passed.");
}

function testAgentConfigurationValidation(): void {
  const source = `
version: 1
execution:
  maxSteps: 10
  maxFailures: 2
  turnTimeoutMs: 300000
budgeting:
  approximateCharactersPerToken: 4
context:
  plannerInputTokens: 6000
  memoryBlockTokens: 2000
  recentConversation: { messageLimit: 2, tokensPerMessage: 200 }
  historySearch: { defaultLimit: 5, maximumLimit: 10, tokensPerMessage: 200 }
  memoryDirectory: { maximumEntries: 20, compactedEntries: 10, descriptionTokens: 60 }
  memberMemory: { maximumFacts: 20, defaultSearchLimit: 5, maximumSearchLimit: 10 }
planning:
  responseMessageTokens: 1000
  toolInputTokens: 2000
  reasonTokens: 125
  maximumPlanItems: 6
  planItemTokens: 75
  maximumParallelContextRequests: 3
reusableProcedures: { maximumSteps: 12, inputTokensPerStep: 1000 }
toolResults: { retainedTokens: 2000, compactedTokens: 1000 }
retrieval:
  structuredEvidenceTokens: 1750
  semanticEvidenceTokens: 750
  fieldTokens: 375
  weeklyEvidenceTokens: 2000
`;
  const configuration = parseAgentConfiguration(source);
  assert.equal(configuration.execution.maxSteps, 10);
  assert.equal(configuration.context.historySearch.maximumLimit, 10);

  assert.throws(() => parseAgentConfiguration(
    source.replace("defaultLimit: 5", "defaultLimit: 11"),
  ));
}

function testOpenRouterProviderRegistry(): void {
  process.env.TEST_OPENROUTER_KEY = "test-key";
  try {
    const roles = Object.fromEntries(CHAT_MODEL_ROLES.map((role) => [role, [{
      provider: "openrouter-test",
      model: `test/${role}-model`,
      temperature: 0,
    }]])) as ChatModelConfiguration["roles"];
    const registry = new LangChainModelRegistry({
      providers: [{ id: "openrouter-test", type: "openrouter", apiKeyEnv: "TEST_OPENROUTER_KEY" }],
      roles,
      failover: TEST_FAILOVER,
    });

    assert.equal(registry.get("planner").modelName, "openrouter-test:test/planner-model");
    assert.equal(registry.get("fast").modelName, "openrouter-test:test/fast-model");
  } finally {
    delete process.env.TEST_OPENROUTER_KEY;
  }
}

function testYamlConfigurationFiltersUnavailableOptionalProviders(): void {
  process.env.TEST_PRIMARY_KEY = "test-key";
  delete process.env.TEST_OPTIONAL_KEY;
  try {
    const roleYaml = CHAT_MODEL_ROLES.map((role) => `  ${role}:\n    - provider: primary\n      model: ${role}\n    - provider: optional\n      model: ${role}`).join("\n");
    const configuration = parseModelConfiguration(`
version: 1
failover:
  initialCooldownMs: 60000
  maximumCooldownMs: 86400000
providers:
  - id: primary
    type: cohere
    apiKeyEnv: TEST_PRIMARY_KEY
  - id: optional
    type: groq
    apiKeyEnv: TEST_OPTIONAL_KEY
    optional: true
embeddings:
  provider: primary
  model: test-embedding
  dimension: 1024
roles:
${roleYaml}
`);

    assert.deepEqual(configuration.providers.map((provider) => provider.id), ["primary"]);
    assert.equal(configuration.roles.planner.length, 1);
    assert.equal(configuration.roles.planner[0]?.provider, "primary");
    assert.deepEqual(configuration.embeddings, {
      provider: "primary",
      model: "test-embedding",
      dimension: 1024,
    });
  } finally {
    delete process.env.TEST_PRIMARY_KEY;
  }
}

function testProviderAndRoleRegistry(): void {
  process.env.TEST_GROQ_KEY = "test-key";
  try {
    const roles = Object.fromEntries(CHAT_MODEL_ROLES.map((role) => [role, [{
      provider: "groq-test",
      model: `${role}-model`,
      maxTokens: 100,
      temperature: 0,
    }]])) as ChatModelConfiguration["roles"];
    const registry = new LangChainModelRegistry({
      providers: [{ id: "groq-test", type: "groq", apiKeyEnv: "TEST_GROQ_KEY" }],
      roles,
      failover: TEST_FAILOVER,
    });

    assert.equal(registry.get("planner").modelName, "groq-test:planner-model");
    assert.equal(registry.get("extraction").role, "extraction");
  } finally {
    delete process.env.TEST_GROQ_KEY;
  }
}

async function testTextInvocationFallsBack(): Promise<void> {
  const primary = failingModel("429 rate limit exceeded");
  const secondary = new FakeListChatModel({ responses: ["fallback response"] });
  let secondaryCalls = 0;
  const secondaryInvoke = secondary.invoke.bind(secondary);
  secondary.invoke = async (...args) => {
    secondaryCalls += 1;
    return secondaryInvoke(...args);
  };
  const model = new ResilientChatModel("fast", [
    { config: { provider: "primary", model: "fast" }, model: primary },
    { config: { provider: "secondary", model: "fast" }, model: secondary },
  ], TEST_FAILOVER);

  const response = await model.invoke("hello");
  assert.equal(response.content, "fallback response");
  assert.equal(secondaryCalls, 1);

  await model.invoke("hello again");
  assert.equal(secondaryCalls, 2, "The failed primary endpoint should remain on cooldown.");
}

async function testStructuredInvocationFallsBack(): Promise<void> {
  const primary = failingModel("503 provider temporarily unavailable");
  const secondary = new FakeListChatModel({ responses: [JSON.stringify({ route: "knowledge" })] });
  const model = new ResilientChatModel("extraction", [
    { config: { provider: "primary", model: "router" }, model: primary },
    { config: { provider: "secondary", model: "router" }, model: secondary },
  ], TEST_FAILOVER);
  const schema = z.object({ route: z.literal("knowledge") });

  const response = await model.withStructuredOutput(schema).invoke("choose a route");
  assert.deepEqual(response, { route: "knowledge" });
}

async function testInvalidRequestDoesNotFallBack(): Promise<void> {
  const primary = failingModel("400 invalid request payload");
  const secondary = new FakeListChatModel({ responses: ["must not run"] });
  let secondaryCalls = 0;
  const secondaryInvoke = secondary.invoke.bind(secondary);
  secondary.invoke = async (...args) => {
    secondaryCalls += 1;
    return secondaryInvoke(...args);
  };
  const model = new ResilientChatModel("planner", [
    { config: { provider: "primary", model: "planner" }, model: primary },
    { config: { provider: "secondary", model: "planner" }, model: secondary },
  ], TEST_FAILOVER);

  await assert.rejects(() => model.invoke("invalid"), /400 invalid request/i);
  assert.equal(secondaryCalls, 0);
}

function testRetryClassification(): void {
  assert.equal(isRetryableModelError(Object.assign(new Error("quota"), { status: 429 })), true);
  assert.equal(isRetryableModelError(new Error("network connection reset")), true);
  assert.equal(isRetryableModelError(new Error("413 request too large")), false);
  assert.equal(isRetryableModelError(new Error("422 invalid structured input")), false);
}

function testIncreasingBackoff(): void {
  assert.equal(calculateBackoffMs(1, TEST_FAILOVER), 60_000);
  assert.equal(calculateBackoffMs(2, TEST_FAILOVER), 120_000);
  assert.equal(calculateBackoffMs(3, TEST_FAILOVER), 240_000);
  assert.equal(calculateBackoffMs(20, TEST_FAILOVER), 86_400_000, "Backoff must stop at 24 hours.");
}

function failingModel(message: string): BaseChatModel {
  const model = new FakeListChatModel({ responses: [""] });
  model.invoke = async () => { throw new Error(message); };
  model.withStructuredOutput = (() => RunnableLambda.from(async () => {
    throw new Error(message);
  })) as typeof model.withStructuredOutput;
  return model;
}

void run();
