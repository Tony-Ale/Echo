# Local Staging Group

The staging group is a browser chat that runs Echo's real application pipeline without Baileys or WhatsApp.

## What It Uses

- The same `MessageRouter` and persistent agent executor
- The same prompts, LangChain models and tools
- The same reminder and setlist workflows
- The same Supabase memory, conversations, approvals and obligations
- The same Google Sheets, Pinecone, scheduler and application clock
- WhatsApp-style reply chains and confirmation message IDs

Only the message transport is replaced by `LocalChatTransport`.

## Setup

1. Copy `.env.staging.example` to the private `.env.staging` file and replace its placeholders.
2. Point every integration at isolated staging resources.
3. Apply all migrations under `supabase/migrations` to the staging Supabase project.
4. Seed the committed fictional staging identities with `npm run seed:identities:staging`.
5. Run `npm run staging`.
6. Open `http://127.0.0.1:3100`.

The server refuses to start unless `.env.staging` contains `ECHO_ENVIRONMENT=staging`.

For a repeatable end-to-end checklist, use
[Live Integration Test Suite](live-integration-tests.md).

## Using The Group

- Select a canonical member from **Speaking as**.
- Use **Add simulated participant** to create an unknown group participant and test first-message onboarding.
- Send normal, retrieval and workflow messages exactly as that member would.
- Use **Reply** on an Echo message to test confirmations and quoted context.
- Switch members to test role and ownership enforcement.
- Open **Operations** to inspect scheduled jobs and active obligations.
- Inspect **Agent activity** to follow planning decisions, capability activation, tool execution and the final response for each turn.
- In **Operations**, set an application time or advance it by an hour, day or week.
- Advancing past a scheduled time runs the same scheduled agent activation and shows its message and execution trace in the staging group.
- Time moves forward within a staging timeline. Setting an earlier time automatically starts a fresh timeline at that time.
- Reverse travel clears staging conversations, workflows, obligations, setlists and execution traces, then rebuilds schedules. Identities, member memory, configuration and source data are preserved.
- Select **Live time** when testing is complete to rebuild schedules against the system clock.

The local group marks itself as an accepted choir conversation for its isolated staging deployment. An unregistered simulated participant therefore exercises the same planner tool, identity repository and profile-memory path used by WhatsApp.

Phone numbers and WhatsApp JIDs never appear in the browser. They remain server-side and are used only to resolve the selected canonical member through the normal identity repository.

## Safety

- Do not reuse production Supabase, Pinecone or Sheets settings unless production mutation is intentional.
- `.env.staging` and `seeds/*.private.json` are ignored by Git.
- The transcript shown by the browser transport is process-local and bounded. The same exchanges are also written through Echo's durable conversation repository.

## WhatsApp Staging

To use a personal WhatsApp group instead, configure its ID and an isolated `WHATSAPP_SESSION_ID` in `.env.staging`, then run:

```powershell
npm.cmd run staging:whatsapp
```

This starts Baileys only when explicitly requested. Use staging Supabase, Pinecone and Sheets resources so test membership and schedules cannot mutate production.
