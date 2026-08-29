-- Idempotent, server-only identity provisioning.
-- Private values are supplied by the deployment seed file, never migrations.
create or replace function echo_seed_member_identity(
  p_canonical_name text,
  p_display_name text,
  p_status text,
  p_identifiers jsonb,
  p_roles text[]
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member_id uuid;
  v_identifier jsonb;
  v_kind text;
  v_value text;
  v_normalized text;
  v_existing_member_id uuid;
  v_role text;
begin
  if nullif(trim(p_canonical_name), '') is null or nullif(trim(p_display_name), '') is null then
    raise exception 'Canonical and display names are required';
  end if;
  if p_status not in ('active', 'inactive') then
    raise exception 'Invalid member status: %', p_status;
  end if;
  if p_identifiers is null or jsonb_typeof(p_identifiers) <> 'array' then
    raise exception 'Identifiers must be a JSON array';
  end if;
  if p_roles is null or array_length(p_roles, 1) is null then
    raise exception 'At least one role is required';
  end if;

  select id into v_member_id
  from echo_members
  where lower(canonical_name) = lower(trim(p_canonical_name));

  if v_member_id is null then
    insert into echo_members (canonical_name, display_name, status)
    values (trim(p_canonical_name), trim(p_display_name), p_status)
    returning id into v_member_id;
  else
    update echo_members
    set display_name = trim(p_display_name), status = p_status, updated_at = now()
    where id = v_member_id;
  end if;

  for v_identifier in select value from jsonb_array_elements(p_identifiers)
  loop
    v_kind := v_identifier ->> 'kind';
    v_value := trim(v_identifier ->> 'value');
    if v_kind not in ('phone', 'whatsapp_jid', 'push_name', 'alias') or v_value = '' then
      raise exception 'Invalid identifier supplied for %', p_canonical_name;
    end if;
    v_normalized := case
      when v_kind in ('phone', 'whatsapp_jid')
        then regexp_replace(split_part(split_part(v_value, '@', 1), ':', 1), '\D', '', 'g')
      else trim(regexp_replace(lower(v_value), '[^a-z0-9[:space:]]', '', 'g'))
    end;
    if v_normalized = '' then raise exception 'Identifier normalizes to an empty value'; end if;

    select member_id into v_existing_member_id
    from echo_member_identifiers
    where kind = v_kind and normalized_value = v_normalized;
    if v_existing_member_id is not null and v_existing_member_id <> v_member_id then
      raise exception 'Identifier is already assigned to another member';
    end if;

    insert into echo_member_identifiers (member_id, kind, value, normalized_value, verified)
    values (v_member_id, v_kind, v_value, v_normalized, coalesce((v_identifier ->> 'verified')::boolean, false))
    on conflict (kind, normalized_value) do update
      set value = excluded.value, verified = excluded.verified, updated_at = now();
  end loop;

  delete from echo_member_roles where member_id = v_member_id;
  foreach v_role in array p_roles
  loop
    if v_role not in ('member', 'superuser', 'creator') then
      raise exception 'Invalid member role: %', v_role;
    end if;
    insert into echo_member_roles (member_id, role) values (v_member_id, v_role)
    on conflict do nothing;
  end loop;

  if p_roles && array['superuser', 'creator']::text[] and not exists (
    select 1 from echo_member_identifiers
    where member_id = v_member_id and kind in ('phone', 'whatsapp_jid') and verified = true
  ) then
    raise exception 'Privileged members require a verified phone or WhatsApp JID';
  end if;

  insert into echo_audit_log (action, target_type, target_id, details)
  values ('identity.seeded', 'member', v_member_id::text, jsonb_build_object('canonicalName', trim(p_canonical_name), 'roles', p_roles));
  return v_member_id;
end;
$$;

revoke all on function echo_seed_member_identity(text, text, text, jsonb, text[]) from public;
grant execute on function echo_seed_member_identity(text, text, text, jsonb, text[]) to service_role;
