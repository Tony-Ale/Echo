-- Persistent Baileys authentication state.
-- These tables reproduce the storage contract used by
-- src/integrations/whatsapp/auth.ts on a fresh Supabase deployment.

create table if not exists wa_auth_creds (
  session_id text primary key,
  data jsonb not null
);

create table if not exists wa_auth_keys (
  session_id text not null,
  type text not null,
  id text not null,
  data jsonb not null,
  primary key (session_id, type, id)
);

create index if not exists wa_auth_keys_session_idx
  on wa_auth_keys (session_id);

alter table wa_auth_creds enable row level security;
alter table wa_auth_keys enable row level security;

-- Baileys authentication material is server-only. Echo connects with the
-- service-role key, so no browser, anon or authenticated policies are created.
