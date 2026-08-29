-- Deterministic reminder and setlist workflow state. Setlists are accepted
-- immediately after backend leader checks and therefore have no confirmation
-- state or confirmation-message column.

create table if not exists echo_reminders (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null,
  creator_id text not null,
  creator_name text,
  message text not null,
  raw_date_phrase text not null,
  scheduled_for timestamptz not null,
  timezone text not null default 'Europe/London',
  confirmation_message_id text,
  status text not null check (
    status in (
      'pending_confirmation',
      'scheduled',
      'pending_edit_confirmation',
      'pending_cancel_confirmation',
      'completed',
      'cancelled'
    )
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists echo_reminders_active_idx
  on echo_reminders (chat_id, creator_id, status, updated_at desc);

create index if not exists echo_reminders_scheduled_idx
  on echo_reminders (status, scheduled_for);

create index if not exists echo_reminders_confirmation_message_idx
  on echo_reminders (confirmation_message_id)
  where confirmation_message_id is not null;

create table if not exists echo_setlist_submissions (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null,
  submitter_id text not null,
  submitter_name text,
  kind text not null check (kind in ('worship', 'praise', 'setlist')),
  week_start date not null,
  content text not null,
  expires_at timestamptz,
  broadcast_scheduled_for timestamptz,
  broadcast_sent_at timestamptz,
  status text not null check (status in ('submitted', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists echo_setlist_submissions_once_per_week_idx
  on echo_setlist_submissions (kind, week_start)
  where status = 'submitted';

create index if not exists echo_setlist_expiry_idx
  on echo_setlist_submissions (status, expires_at)
  where expires_at is not null;

create index if not exists echo_setlist_broadcast_idx
  on echo_setlist_submissions (status, broadcast_scheduled_for)
  where broadcast_scheduled_for is not null and broadcast_sent_at is null;

-- Workflow state is server-owned, just like the agent persistence tables.
alter table echo_reminders enable row level security;
alter table echo_setlist_submissions enable row level security;
