-- Echo 3.0 persistent agent foundation.
-- Apply with the Supabase CLI or paste into the Supabase SQL editor before
-- enabling the v3 runtime. No private member data belongs in this migration.

create extension if not exists pgcrypto;

create table if not exists echo_members (
  id uuid primary key default gen_random_uuid(),
  canonical_name text,
  display_name text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists echo_members_canonical_name_idx
  on echo_members (lower(canonical_name));

create table if not exists echo_member_identifiers (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references echo_members(id) on delete cascade,
  kind text not null check (kind in ('phone', 'whatsapp_jid', 'push_name', 'alias')),
  value text not null,
  normalized_value text not null,
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, normalized_value)
);

create index if not exists echo_member_identifiers_member_idx
  on echo_member_identifiers (member_id);

create table if not exists echo_member_roles (
  member_id uuid not null references echo_members(id) on delete cascade,
  role text not null check (role in ('member', 'superuser', 'creator')),
  created_at timestamptz not null default now(),
  primary key (member_id, role)
);

create table if not exists echo_memory_blocks (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null default 'echo',
  scope_type text not null check (scope_type in ('agent', 'chat', 'member', 'week')),
  scope_id text not null,
  label text not null,
  description text not null,
  value text not null default '',
  character_limit integer not null default 4000 check (character_limit between 100 and 20000),
  read_only boolean not null default false,
  expires_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, scope_type, scope_id, label)
);

create index if not exists echo_memory_blocks_active_idx
  on echo_memory_blocks (agent_id, scope_type, scope_id, expires_at);

create table if not exists echo_member_memory_facts (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references echo_members(id) on delete cascade,
  category text not null,
  fact text not null,
  normalized_fact text not null,
  source_message_id text,
  learned_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  importance text not null default 'normal' check (importance in ('low', 'normal', 'high')),
  importance_rank smallint generated always as (
    case importance when 'high' then 3 when 'normal' then 2 else 1 end
  ) stored,
  reinforcement_count integer not null default 1,
  verified boolean not null default false,
  unique (member_id, category, normalized_fact)
);

create index if not exists echo_member_memory_facts_member_idx
  on echo_member_memory_facts (member_id, last_used_at desc);

create table if not exists echo_agent_obligations (
  id uuid primary key default gen_random_uuid(),
  natural_key text not null unique,
  type text not null,
  chat_id text not null,
  week_start date,
  assigned_member_ids uuid[] not null default '{}',
  status text not null check (
    status in ('pending', 'waiting_for_data', 'waiting_for_member', 'satisfied', 'not_applicable', 'cancelled', 'failed')
  ),
  due_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  source_hash text,
  last_evaluated_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists echo_agent_obligations_active_idx
  on echo_agent_obligations (status, due_at);

create table if not exists echo_weekly_interpretations (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  source_hash text not null,
  schedule_context text not null,
  interpretation jsonb not null,
  evaluated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (week_start, source_hash)
);

create table if not exists echo_sync_state (
  source text primary key,
  source_hash text,
  source_modified_at timestamptz,
  last_checked_at timestamptz,
  last_successful_sync_at timestamptz,
  lock_token uuid,
  lock_expires_at timestamptz,
  warnings jsonb not null default '[]'::jsonb,
  last_error text,
  updated_at timestamptz not null default now()
);

create or replace function echo_acquire_sync_lock(
  p_source text,
  p_lock_token uuid,
  p_lock_expires_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  insert into echo_sync_state (source, lock_token, lock_expires_at)
  values (p_source, p_lock_token, p_lock_expires_at)
  on conflict (source) do update
    set lock_token = excluded.lock_token,
        lock_expires_at = excluded.lock_expires_at,
        updated_at = now()
    where echo_sync_state.lock_token is null
       or echo_sync_state.lock_expires_at <= now();
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

create or replace function echo_release_sync_lock(p_source text, p_lock_token uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update echo_sync_state
  set lock_token = null,
      lock_expires_at = null,
      updated_at = now()
  where source = p_source and lock_token = p_lock_token;
$$;

create table if not exists echo_agent_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  source text not null check (source in ('transport', 'scheduler', 'system')),
  type text not null,
  chat_id text,
  actor_member_id uuid references echo_members(id) on delete set null,
  status text not null check (status in ('received', 'running', 'completed', 'failed', 'deferred')),
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  received_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists echo_agent_turns (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references echo_agent_events(id) on delete cascade,
  model text,
  status text not null check (status in ('running', 'completed', 'failed', 'max_steps')),
  step_count integer not null default 0,
  final_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists echo_tool_executions (
  id uuid primary key default gen_random_uuid(),
  turn_id uuid not null references echo_agent_turns(id) on delete cascade,
  step integer not null,
  tool_name text not null,
  idempotency_key text not null unique,
  arguments jsonb not null,
  result jsonb,
  status text not null check (status in ('running', 'success', 'error', 'denied', 'approval_required')),
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists echo_agent_approvals (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null,
  owner_member_id uuid not null references echo_members(id) on delete cascade,
  tool_name text not null,
  arguments jsonb not null,
  status text not null check (status in ('pending', 'approved', 'declined', 'executed', 'failed')),
  confirmation_message_id text,
  result jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists echo_agent_approvals_confirmation_idx
  on echo_agent_approvals (confirmation_message_id)
  where confirmation_message_id is not null;

create index if not exists echo_agent_approvals_pending_idx
  on echo_agent_approvals (status, expires_at);

create table if not exists echo_conversation_messages (
  id uuid primary key default gen_random_uuid(),
  external_message_id text,
  chat_id text not null,
  member_id uuid references echo_members(id) on delete set null,
  role text not null check (role in ('user', 'assistant', 'tool', 'system')),
  content text not null,
  quoted_external_message_id text,
  sender_name_snapshot text,
  created_at timestamptz not null default now()
);

create unique index if not exists echo_conversation_external_message_idx
  on echo_conversation_messages (chat_id, external_message_id);

create index if not exists echo_conversation_recent_idx
  on echo_conversation_messages (chat_id, created_at desc);

create table if not exists echo_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_member_id uuid references echo_members(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table echo_members enable row level security;
alter table echo_member_identifiers enable row level security;
alter table echo_member_roles enable row level security;
alter table echo_memory_blocks enable row level security;
alter table echo_member_memory_facts enable row level security;
alter table echo_agent_obligations enable row level security;
alter table echo_weekly_interpretations enable row level security;
alter table echo_sync_state enable row level security;
alter table echo_agent_events enable row level security;
alter table echo_agent_turns enable row level security;
alter table echo_tool_executions enable row level security;
alter table echo_agent_approvals enable row level security;
alter table echo_conversation_messages enable row level security;
alter table echo_audit_log enable row level security;

revoke all on function echo_acquire_sync_lock(text, uuid, timestamptz) from public;
revoke all on function echo_release_sync_lock(text, uuid) from public;
grant execute on function echo_acquire_sync_lock(text, uuid, timestamptz) to service_role;
grant execute on function echo_release_sync_lock(text, uuid) to service_role;

-- These tables are server-only. Use a Supabase service-role key in the bot;
-- no client policies are intentionally created.
