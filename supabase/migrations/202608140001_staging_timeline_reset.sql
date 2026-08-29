-- Local staging uses this transaction when reverse time travel starts a fresh
-- timeline. Identity, member memory, source data, and sync state are preserved.
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
  delete from echo_reminders where chat_id = p_chat_id;
  delete from echo_setlist_submissions where chat_id = p_chat_id;

  -- Deleting events cascades through turns and tool executions, removing the
  -- scheduler idempotency keys belonging to the discarded timeline.
  delete from echo_agent_events where chat_id = p_chat_id;

  -- These are derived operational caches. They are rebuilt from source data.
  delete from echo_weekly_interpretations where id is not null;
  delete from echo_memory_blocks where scope_type = 'week';
end;
$$;

revoke all on function echo_reset_staging_timeline(text) from public, anon, authenticated;
grant execute on function echo_reset_staging_timeline(text) to service_role;
