-- MANGO FX: member-only rankings of saved practice account results.
-- Run AFTER schema.sql. Existing accounts, shop data and roles are preserved.
begin;

create or replace function public.get_practice_leaderboard(
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

  -- A finite range keeps cent-rounded amounts distinct in JavaScript numbers.
  -- CASE bounds the input BEFORE subtraction, including extreme JSON numerics.
  with eligible as materialized (
    select a.user_id, case when jsonb_typeof(a.state->'account'->'balance') = 'number' then
      case when (a.state->'account'->>'balance')::numeric between -999999000000 and 1000001000000
        then round((a.state->'account'->>'balance')::numeric - 1000000, 2)
        else null end
      else null end as pnl
    from public.practice_accounts a join auth.users u on u.id = a.user_id
    where u.email_confirmed_at is not null
  ), ranked as (
    select user_id, pnl,
      row_number() over (order by case when p_direction = 'profit' then -pnl else pnl end, user_id) as position,
      rank() over (order by case when p_direction = 'profit' then -pnl else pnl end) as rank
    from eligible
    where case when p_direction = 'profit' then pnl > 0 else pnl < 0 end
  ), formatted as (
    select user_id, position, jsonb_build_object(
      'position', position, 'rank', rank,
      'displayName', 'トレーダー' || upper(substr(md5(user_id::text), 1, 10)),
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

revoke all on function public.get_practice_leaderboard(text, uuid) from public, anon, authenticated;
grant execute on function public.get_practice_leaderboard(text, uuid) to authenticated;

notify pgrst, 'reload schema';
select has_function_privilege('authenticated', 'public.get_practice_leaderboard(text,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.get_practice_leaderboard(text,uuid)', 'execute')
  as leaderboards_ready;
commit;
