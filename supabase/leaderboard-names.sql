-- MANGO FX: account display names for member-only practice rankings.
-- Run AFTER schema.sql and leaderboards.sql. Existing data is preserved.
-- The original pseudonym RPC stays unchanged for older installed clients.
begin;

create or replace function public.get_practice_leaderboard_named(
  p_direction text, p_expected_user_id uuid
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare current_id uuid := auth.uid(); result jsonb;
begin
  if current_id is null or p_expected_user_id is null or current_id <> p_expected_user_id then
    raise exception using errcode = '42501', message = 'ACCOUNT_USER_CHANGED';
  end if;
  if p_direction is null or p_direction not in ('profit', 'loss') then
    raise exception using errcode = '22023', message = 'LEADERBOARD_INVALID_DIRECTION';
  end if;

  with eligible as materialized (
    select a.user_id,
      coalesce(chosen.display_name, 'トレーダー' || upper(substr(md5(a.user_id::text), 1, 10))) as display_name,
      case when jsonb_typeof(a.state->'account'->'balance') = 'number' then
        case when (a.state->'account'->>'balance')::numeric between -999999000000 and 1000001000000
          then round((a.state->'account'->>'balance')::numeric - 1000000, 2)
          else null end
        else null end as pnl
    from public.practice_accounts a join auth.users u on u.id = a.user_id
    left join lateral (
      select btrim(left(candidate.name, 40)) as display_name
      from (
        select preference, case when jsonb_typeof(value) = 'string' then
          -- Normalize C0/C1 controls and all JavaScript trim whitespace to spaces.
          -- Validate the complete value before truncating it for display.
          btrim(regexp_replace(value #>> '{}',
            U&'[\0001-\0020\007F-\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+', ' ', 'g'))
          else null end as name
        from (values
          (1, u.raw_user_meta_data->'display_name'),
          (2, u.raw_user_meta_data->'full_name')
        ) names(preference, value)
      ) candidate
      where candidate.name is not null and candidate.name <> ''
        and candidate.name !~ '[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+'
      order by candidate.preference limit 1
    ) chosen on true
    where u.email_confirmed_at is not null
  ), ranked as (
    select user_id, display_name, pnl,
      row_number() over (order by case when p_direction = 'profit' then -pnl else pnl end, user_id) as position,
      rank() over (order by case when p_direction = 'profit' then -pnl else pnl end) as rank
    from eligible
    where case when p_direction = 'profit' then pnl > 0 else pnl < 0 end
  ), formatted as (
    select user_id, position, jsonb_build_object(
      'position', position, 'rank', rank, 'displayName', display_name,
      'realizedPnl', pnl, 'isMe', user_id = current_id
    ) as entry from ranked
  )
  select jsonb_build_object(
    'direction', p_direction,
    'entries', coalesce((select jsonb_agg(entry order by position) from formatted where position <= 100), '[]'::jsonb),
    'ownEntry', (select entry from formatted where user_id = current_id),
    'myRealizedPnl', coalesce((select pnl from eligible where user_id = current_id), 0),
    'participantCount', (select count(*) from ranked),
    'generatedAt', statement_timestamp()
  ) into result;
  return result;
end;
$$;

revoke all on function public.get_practice_leaderboard_named(text, uuid) from public, anon, authenticated;
grant execute on function public.get_practice_leaderboard_named(text, uuid) to authenticated;

notify pgrst, 'reload schema';
select has_function_privilege('authenticated', 'public.get_practice_leaderboard_named(text,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.get_practice_leaderboard_named(text,uuid)', 'execute')
  as leaderboard_names_ready;
commit;
