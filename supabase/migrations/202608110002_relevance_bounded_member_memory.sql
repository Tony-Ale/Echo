create or replace function echo_remember_member_fact(
  p_member_id uuid,
  p_category text,
  p_fact text,
  p_normalized_fact text,
  p_source_message_id text,
  p_importance text,
  p_verified boolean,
  p_remembered_at timestamptz,
  p_max_facts integer
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_importance not in ('low', 'normal', 'high') then
    raise exception 'Invalid member-memory importance';
  end if;

  insert into echo_member_memory_facts (
    member_id, category, fact, normalized_fact, source_message_id,
    learned_at, last_used_at, importance, reinforcement_count, verified
  ) values (
    p_member_id, p_category, p_fact, p_normalized_fact, p_source_message_id,
    p_remembered_at, p_remembered_at, p_importance, 1, p_verified
  )
  on conflict (member_id, category, normalized_fact) do update set
    fact = excluded.fact,
    source_message_id = coalesce(excluded.source_message_id, echo_member_memory_facts.source_message_id),
    last_used_at = excluded.last_used_at,
    importance = case
      when excluded.importance = 'high' or echo_member_memory_facts.importance = 'high' then 'high'
      when excluded.importance = 'normal' or echo_member_memory_facts.importance = 'normal' then 'normal'
      else 'low'
    end,
    reinforcement_count = echo_member_memory_facts.reinforcement_count + 1,
    verified = echo_member_memory_facts.verified or excluded.verified;

  delete from echo_member_memory_facts
  where id in (
    select id
    from echo_member_memory_facts
    where member_id = p_member_id
    order by importance_rank desc, verified desc, reinforcement_count desc, last_used_at desc, learned_at desc
    offset greatest(1, p_max_facts)
  );
end;
$$;

revoke all on function echo_remember_member_fact(uuid, text, text, text, text, text, boolean, timestamptz, integer) from public, anon, authenticated;
grant execute on function echo_remember_member_fact(uuid, text, text, text, text, text, boolean, timestamptz, integer) to service_role;

create index if not exists echo_member_memory_relevance_idx
  on echo_member_memory_facts (
    member_id,
    importance_rank desc,
    verified desc,
    reinforcement_count desc,
    last_used_at desc
  );
