-- Planner-driven member onboarding and permanent profile memory.
-- The application verifies the trusted conversation; these RPCs atomically
-- enforce identifier ownership, base roles, profile state and audit records.

create or replace function echo_onboard_group_member(
  p_identifier_kind text,
  p_identifier_value text,
  p_transport text,
  p_transport_name text,
  p_chat_id text,
  p_now timestamptz
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member_id uuid;
  v_normalized text;
  v_display_name text;
  v_profile jsonb;
begin
  if p_identifier_kind not in ('phone', 'whatsapp_jid') then
    raise exception 'Onboarding requires an authoritative transport identifier';
  end if;
  v_normalized := regexp_replace(
    split_part(split_part(trim(p_identifier_value), '@', 1), ':', 1),
    '\D', '', 'g'
  );
  if v_normalized = '' then raise exception 'Transport identifier is invalid'; end if;
  perform pg_advisory_xact_lock(hashtext(v_normalized));

  select member_id into v_member_id
  from echo_member_identifiers
  where kind in ('phone', 'whatsapp_jid')
    and normalized_value = v_normalized
  limit 1;

  v_display_name := coalesce(nullif(trim(p_transport_name), ''), 'Choir member');
  if v_member_id is null then
    insert into echo_members (canonical_name, display_name, status, created_at, updated_at)
    values (null, v_display_name, 'active', p_now, p_now)
    returning id into v_member_id;

    insert into echo_member_identifiers (
      member_id, kind, value, normalized_value, verified, created_at, updated_at
    ) values (
      v_member_id, p_identifier_kind, trim(p_identifier_value), v_normalized, true, p_now, p_now
    );
    insert into echo_member_roles (member_id, role, created_at)
    values (v_member_id, 'member', p_now)
    on conflict do nothing;
  else
    update echo_members
    set status = 'active', updated_at = p_now
    where id = v_member_id;
    update echo_member_identifiers
    set verified = true, updated_at = p_now
    where member_id = v_member_id
      and kind in ('phone', 'whatsapp_jid')
      and normalized_value = v_normalized;
  end if;

  v_profile := jsonb_build_object(
    'preferredDisplayName', v_display_name,
    'transportNames', jsonb_build_object(p_transport, v_display_name),
    'knownAliases', '[]'::jsonb
  );
  insert into echo_memory_blocks (
    agent_id, scope_type, scope_id, label, description, value,
    character_limit, read_only, expires_at, created_at, updated_at
  ) values (
    'echo', 'member', v_member_id::text, 'member_profile',
    'Permanent member profile used for names and conversational identity.',
    v_profile::text, 3000, false, null, p_now, p_now
  ) on conflict (agent_id, scope_type, scope_id, label) do nothing;

  insert into echo_audit_log (actor_member_id, action, target_type, target_id, details, created_at)
  values (
    v_member_id, 'member.onboarded', 'member', v_member_id::text,
    jsonb_build_object('transport', p_transport, 'chatId', p_chat_id), p_now
  );
  return v_member_id;
end;
$$;

create or replace function echo_update_member_profile(
  p_member_id uuid,
  p_transport text,
  p_transport_name text,
  p_preferred_display_name text,
  p_aliases text[],
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_display text;
  v_existing jsonb := '{}'::jsonb;
  v_existing_aliases text[] := '{}'::text[];
  v_aliases text[] := '{}'::text[];
  v_display_name text;
  v_transport_names jsonb := '{}'::jsonb;
  v_profile jsonb;
begin
  select display_name into v_current_display
  from echo_members where id = p_member_id and status = 'active' for update;
  if not found then raise exception 'Active member not found'; end if;

  select value::jsonb into v_existing
  from echo_memory_blocks
  where agent_id = 'echo' and scope_type = 'member'
    and scope_id = p_member_id::text and label = 'member_profile'
  for update;
  v_existing := coalesce(v_existing, '{}'::jsonb);
  v_transport_names := coalesce(v_existing -> 'transportNames', '{}'::jsonb);
  select coalesce(array_agg(value), '{}'::text[]) into v_existing_aliases
  from jsonb_array_elements_text(coalesce(v_existing -> 'knownAliases', '[]'::jsonb));

  v_display_name := coalesce(
    nullif(trim(p_preferred_display_name), ''),
    nullif(trim(p_transport_name), ''),
    nullif(trim(v_current_display), ''),
    'Choir member'
  );
  if nullif(trim(p_transport), '') is not null and nullif(trim(p_transport_name), '') is not null then
    v_transport_names := jsonb_set(v_transport_names, array[p_transport], to_jsonb(trim(p_transport_name)), true);
  end if;

  select coalesce(array_agg(alias_value order by alias_value), '{}'::text[]) into v_aliases
  from (
    select distinct trim(alias_value) as alias_value
    from unnest(v_existing_aliases || coalesce(p_aliases, '{}'::text[]) || array[v_current_display]) alias_value
    where nullif(trim(alias_value), '') is not null
      and lower(trim(alias_value)) <> lower(v_display_name)
    order by trim(alias_value)
    limit 10
  ) aliases;

  v_profile := jsonb_build_object(
    'preferredDisplayName', v_display_name,
    'transportNames', v_transport_names,
    'knownAliases', to_jsonb(v_aliases)
  );
  update echo_members
  set display_name = v_display_name, updated_at = p_now
  where id = p_member_id;

  insert into echo_memory_blocks (
    agent_id, scope_type, scope_id, label, description, value,
    character_limit, read_only, expires_at, created_at, updated_at
  ) values (
    'echo', 'member', p_member_id::text, 'member_profile',
    'Permanent member profile used for names and conversational identity.',
    v_profile::text, 3000, false, null, p_now, p_now
  ) on conflict (agent_id, scope_type, scope_id, label) do update
    set value = excluded.value, updated_at = excluded.updated_at,
        version = echo_memory_blocks.version + 1;

  insert into echo_audit_log (actor_member_id, action, target_type, target_id, details, created_at)
  values (
    p_member_id, 'member.profile_updated', 'member', p_member_id::text,
    jsonb_build_object('transport', p_transport, 'displayName', v_display_name), p_now
  );
  return v_profile;
end;
$$;

create or replace function echo_set_member_canonical_name(
  p_actor_member_id uuid,
  p_member_id uuid,
  p_canonical_name text,
  p_now timestamptz
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(trim(p_canonical_name), '') is null then
    raise exception 'Canonical name is required';
  end if;
  update echo_members
  set canonical_name = trim(p_canonical_name), updated_at = p_now
  where id = p_member_id;
  if not found then raise exception 'Member not found'; end if;

  insert into echo_audit_log (actor_member_id, action, target_type, target_id, details, created_at)
  values (
    p_actor_member_id, 'member.canonical_name_set', 'member', p_member_id::text,
    jsonb_build_object('canonicalName', trim(p_canonical_name)), p_now
  );
end;
$$;

revoke all on function echo_onboard_group_member(text, text, text, text, text, timestamptz) from public;
revoke all on function echo_update_member_profile(uuid, text, text, text, text[], timestamptz) from public;
revoke all on function echo_set_member_canonical_name(uuid, uuid, text, timestamptz) from public;
grant execute on function echo_onboard_group_member(text, text, text, text, text, timestamptz) to service_role;
grant execute on function echo_update_member_profile(uuid, text, text, text, text[], timestamptz) to service_role;
grant execute on function echo_set_member_canonical_name(uuid, uuid, text, timestamptz) to service_role;
