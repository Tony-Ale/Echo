# Echo 3 Deployment

## 1. Apply The Database Migration

- Apply the migrations in `supabase/migrations` in filename order using the Supabase SQL editor or CLI.
- Use a server-side Supabase service-role key. The Echo 3 tables have RLS enabled and intentionally expose no client policies.
- The migrations also create `wa_auth_creds` and `wa_auth_keys`, which preserve Baileys authentication across restarts.

## 2. Seed Member Identity

1. Copy `seeds/identities.example.json` to `seeds/identities.private.json`.
2. Add the known canonical members and their verified WhatsApp phone or JID.
3. Assign `creator` and `superuser` roles in that private file.
4. Run `npm run seed:identities`.

The seed normalizes every creator to also have `superuser` and `member` access. Production startup requires at least one verified creator and one verified superuser; one creator record can satisfy both after normalization.

For the isolated staging database, `npm run seed:identities:staging` loads the
committed fictional identities from `seeds/identities.staging.json` instead.

The seed is a partial bootstrap, not an exhaustive roster. The configured choir group can onboard unlisted participants as ordinary members when they communicate with Echo. The command is idempotent, does not delete unlisted database members, validates privileged identities, prevents one identifier from being assigned to two people, and never logs phone numbers.

## 3. Configure Environment

- Create a private `.env` file containing the deployment's integration credentials and runtime settings.
- Set `ECHO_ENVIRONMENT=production` in the production service.
- Set `WHATSAPP_GROUP_ID` to the one choir group served by that deployment.
- Set `WHATSAPP_ALLOW_ALL_GROUPS=true` only when Echo should accept tagged or reply-based interactions in every joined group. Those accepted groups are treated as choir conversations and may onboard unknown participants as ordinary members. Scheduled choir operations still target `WHATSAPP_GROUP_ID`.
- Set `WHATSAPP_LOG_GROUP_IDS=true` temporarily to log incoming group IDs without logging message text or participant identifiers.
- Set a distinct `WHATSAPP_SESSION_ID` for each production or staging Baileys session.
- Set `AI_MODEL_CONFIG_PATH=config/models.yaml`. The checked-in YAML assigns providers and models to every model role.
- Set `AGENT_CONFIG_PATH=config/agent.yaml`. The checked-in YAML contains bounded agent runtime and context settings.
- Apply the migration and member seed before starting Echo.
- `ECHO_BOOTSTRAP_CREATOR_PHONE` is accepted only outside production. Production startup requires database-backed creator and superuser identities with verified transport identifiers.

### Model Providers

- Keep every provider credential in a private environment variable.
- Provider entries in `config/models.yaml` reference credentials by environment-variable name through `apiKeyEnv`.
- Never put secret values in YAML.
- The YAML `failover` section controls bounded endpoint cooldown after retryable failures.
- Each runtime role has an ordered endpoint list, allowing providers and models to be changed without editing application code.

The checked-in configuration uses OpenRouter for chat roles and Cohere for embeddings. Model assignments follow this model-agnostic shape; `config/models.yaml` remains the source of truth for the deployed model names:

```yaml
roles:
  planner:
    - provider: openrouter
      model: provider/planner-model
      temperature: 0
```

Every role must retain at least one configured endpoint with an available credential, otherwise startup fails with a configuration error.

Embeddings are configured in the `embeddings` section of `config/models.yaml`. It references a configured provider and declares the model, vector dimension and optional batch size. Echo validates the configured dimension against Pinecone. Changing the embedding provider or model requires recreating and repopulating the vector index, even when the dimension happens to match.

### Agent Runtime

- `config/agent.yaml` is the source of truth for execution limits, planner bounds, bounded conversation and member memory, context acquisition, reusable procedures, tool-result retention and retrieval evidence budgets.
- Context budgets are written as approximate tokens for readability. Echo converts them to exact character caps using the configured provider-neutral ratio.
- Secrets, model assignments, prompts and choir-specific rules do not belong in this file.
- Invalid or inconsistent settings fail during startup instead of producing partially configured behavior.

## 4. Verify Without WhatsApp

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

For an interactive end-to-end environment, configure `.env.staging`, run `npm run staging`, and open `http://127.0.0.1:3100`. See `documentation/local-staging-group.md`.

To test through a personal WhatsApp group with isolated staging resources, run `npm run staging:whatsapp`. Alternatively, `WHATSAPP_ALLOW_ALL_GROUPS=true` permits normal mention/reply interactions in any joined group while retaining the configured group as the scheduled-message destination.

## 5. Runtime Recovery

At startup Echo:

- creates its stable persona and operating-policy memory blocks if missing;
- loads the database-backed member directory used by deterministic domain policies;
- restores existing user reminders and workflow confirmation caches;
- restores pending setlist broadcasts, active agent obligations and recurring agent tasks;
- registers recurring choir activation and operational cleanup jobs;
- backfills the current week's setlist planning after a missed Sunday 7 PM activation when future weekday nudge slots still exist.

Each scheduler occurrence has a stable event key, so a retried or recovered wake is not handled twice.

The production HTTP server exposes two health boundaries:

- `/health/live` reports that the Node.js process is running.
- `/health/ready` and `/` report success only after WhatsApp is connected and startup recovery has completed.

Configure the hosting platform's readiness check to use `/health/ready`.

There is one runtime path. Missing required tables or configuration should be corrected rather than bypassed with an alternate mode.
