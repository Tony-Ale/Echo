# Extending Echo

Echo is the default deployment of a reusable agent framework. Extensions are registered statically in TypeScript so they remain typechecked, reviewable and safe to deploy.

## Add A Transport

1. Implement `TransportAdapter` from `src/framework/contracts/messages.ts`.
2. Convert native messages into `IncomingMessage` without leaking native SDK types into the agent.
3. Convert `OutgoingMessage` into the transport's text, mention and reply format.
4. Register an integration plugin such as `transport.discord`.
5. Select that plugin in a new deployment profile.
6. Add transport contract tests modelled on `frameworkSelfTest.ts`.

WhatsApp is implemented by `src/integrations/whatsapp/frameworkAdapter.ts`. Baileys remains outside the framework runtime.

## Add A Tool Or Domain

1. Define a Zod input schema.
2. Implement an `AgentTool` with an explicit side-effect level.
3. Keep authorization, confirmation and state mutation in backend code.
4. Return evidence or a transport-neutral response.
5. Register the tool through an `AgentPlugin`.
6. Add the plugin ID to the intended deployment profile.

Expose a concise JSON description on the Zod schema so the structured planner receives the real input contract. Keep compound operational workflows behind one focused tool when their intermediate steps are backend-owned and should not require repeated model decisions.

Choir-specific tools are registered by `domain.choir`; reusable identity, memory and obligation tools are registered by `runtime.agent`.

## Add A Prompt Pack

Prompts are composed in this order:

1. `canon`: identity, truth, privacy and non-bypassable policy.
2. `runtime`: planning, tools, memory and scheduler semantics.
3. `domain`: terminology and operating guidance for a domain.
4. `deployment`: the public identity and local communication style.
5. `task`: optional instructions for a focused operation.

Create a `PromptPack`, register it through a plugin and list its ID in the deployment profile. Layer IDs must be unique and their numeric order controls composition.

Canon prompts should stay domain-neutral. A new school or club deployment should replace the choir and Echo packs, not copy and modify the runtime prompt.

## Add A Model Provider

1. Implement `ChatProviderAdapter` from `src/integrations/models/modelRegistry.ts`.
2. Construct a LangChain `BaseChatModel` and disable provider-level retries; the resilient wrapper owns retry and failover policy.
3. Register the adapter with `LangChainModelRegistry`.
4. Add the provider type to the validated configuration schema.
5. Configure model endpoints by role rather than importing the provider in a domain service.

Roles are workload labels, not subagents. Adding or changing a provider does not require changes to the executor, planner, workflow services or domain tools.

Provider instances and ordered role chains are declared in `config/models.yaml`. The YAML stores only environment-variable names for credentials, never secret values.

Embedding provider, model, dimension and batching also belong in that YAML. Keep only the referenced provider credentials in the environment.

## Add A Scheduler

Implement `SchedulerPort`. It supports one-time timers, weekly activation policies and cancellation. General recurring agent tasks calculate their next daily, weekly or monthly occurrence and register it as a one-time timer. Recurring domain policy remains in its domain scheduling service; the transport must not decide what a scheduled event means.

Timers should activate an agent event or durable obligation. They should not compose messages or bypass the domain service that validates whether the action still applies.

## Add Persistence

Implement the repository interfaces in `src/agent/ports.ts` for identity, memory, conversations, obligations, scheduled agent tasks, approvals, weekly interpretations and the execution journal. The current implementations use Supabase, but the executor receives only the interfaces.

## Create A Deployment

A deployment profile selects:

- transport plugin;
- runtime and domain plugins;
- prompt packs;
- primary and fast models;
- application timezone.

Use `src/deployments/echo/profile.ts` and `createEchoAgentRuntime.ts` as the reference. Keep vendor construction inside the deployment factory and keep the framework runtime vendor-neutral.

Runtime limits and context budgets belong in `config/agent.yaml`; provider and model-role assignments belong in `config/models.yaml`. Deployment profiles select components and public identity, not secrets or mutable tuning values.

## Compatibility Rules

- Do not import a native transport SDK into `src/framework` or `src/agent`.
- Do not place secrets or member identifiers in prompts, profiles or migrations.
- Do not allow models to execute writes without typed tool policy.
- Preserve event idempotency and bounded execution.
- Add contract tests for every new adapter or plugin.
- Run typecheck, all simulator tests and the production build before merging.
