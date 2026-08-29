-- General recurring agent objectives. Tool results remain in the existing
-- execution journal; this table stores only the durable schedule and recipe.

create table if not exists echo_scheduled_agent_tasks (
  id uuid primary key default gen_random_uuid(),
  natural_key text not null,
  chat_id text not null,
  owner_member_id uuid not null references echo_members(id) on delete cascade,
  objective text not null,
  raw_schedule_phrase text not null,
  schedule jsonb not null,
  status text not null default 'active' check (status in ('active', 'paused', 'cancelled')),
  next_run_at timestamptz not null,
  procedure jsonb not null default '[]'::jsonb,
  last_execution_key text,
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists echo_scheduled_agent_tasks_active_natural_key_idx
  on echo_scheduled_agent_tasks (natural_key)
  where status in ('active', 'paused');

create index if not exists echo_scheduled_agent_tasks_recovery_idx
  on echo_scheduled_agent_tasks (status, next_run_at);

create index if not exists echo_scheduled_agent_tasks_owner_idx
  on echo_scheduled_agent_tasks (owner_member_id, chat_id, status);

-- Atomically claims at most one execution and advances its next wake-up before
-- external work begins. This favours avoiding duplicate group messages after a
-- crash while preserving all later recurrences.
drop function if exists echo_claim_scheduled_agent_task(uuid, text, timestamptz, timestamptz);
create or replace function echo_claim_scheduled_agent_task(
  p_task_id uuid,
  p_execution_key text,
  p_expected_run_at timestamptz,
  p_next_run_at timestamptz,
  p_now timestamptz
) returns setof echo_scheduled_agent_tasks
language sql
security definer
set search_path = public
as $$
  update echo_scheduled_agent_tasks
  set last_execution_key = p_execution_key,
      last_run_at = p_now,
      next_run_at = p_next_run_at,
      updated_at = p_now
  where id = p_task_id
    and status = 'active'
    and last_execution_key is distinct from p_execution_key
    and (p_expected_run_at is null or next_run_at = p_expected_run_at)
  returning *;
$$;

alter table echo_scheduled_agent_tasks enable row level security;
revoke all on function echo_claim_scheduled_agent_task(uuid, text, timestamptz, timestamptz, timestamptz) from public;
grant execute on function echo_claim_scheduled_agent_task(uuid, text, timestamptz, timestamptz, timestamptz) to service_role;

-- Keep reverse time travel truthful for local staging. Identity and permanent
-- member memory remain untouched, while user-created tasks on that timeline are removed.
create or replace function echo_reset_staging_timeline(p_chat_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(trim(p_chat_id), '') is null then
    raise exception 'A staging chat ID is required';
  end if;

  delete from echo_agent_approvals where chat_id = p_chat_id;
  delete from echo_conversation_messages where chat_id = p_chat_id;
  delete from echo_agent_obligations where chat_id = p_chat_id;
  delete from echo_scheduled_agent_tasks where chat_id = p_chat_id;
  delete from echo_reminders where chat_id = p_chat_id;
  delete from echo_setlist_submissions where chat_id = p_chat_id;
  delete from echo_agent_events where chat_id = p_chat_id;
  delete from echo_weekly_interpretations where id is not null;
  delete from echo_memory_blocks where scope_type = 'week';
end;
$$;

revoke all on function echo_reset_staging_timeline(text) from public, anon, authenticated;
grant execute on function echo_reset_staging_timeline(text) to service_role;

-- Server-only table. No client RLS policy is intentionally created.
