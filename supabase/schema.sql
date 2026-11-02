-- MANGO FX: run in the SQL Editor of your own Supabase project.
-- Idempotent: existing account rows are preserved. No secret keys are needed by the app.
begin;

create table if not exists public.practice_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null,
  revision bigint not null default 1 check (revision >= 1),
  updated_at timestamptz not null default now()
);

-- Refresh our constraint in this transaction. Validation fails safely if an
-- older installation contains invalid rows; no account data is removed.
alter table public.practice_accounts drop constraint if exists mango_practice_state_shape;
alter table public.practice_accounts add constraint mango_practice_state_shape check (coalesce((
    jsonb_typeof(state) = 'object'
    and state ?& array['version','account','markets','baseline','pair','scenario','timeframe','speed','paused']
    and jsonb_typeof(state->'version') = 'number'
    and state->>'version' = '1'
    and jsonb_typeof(state->'account') = 'object'
    and (state->'account') ?& array['balance','positions','orders','history']
    and jsonb_typeof(state->'account'->'balance') = 'number'
    and jsonb_typeof(state->'account'->'positions') = 'array'
    and jsonb_typeof(state->'account'->'orders') = 'array'
    and jsonb_typeof(state->'account'->'history') = 'array'
    and jsonb_typeof(state->'markets') = 'object'
    and jsonb_typeof(state->'baseline') = 'object'
    and jsonb_typeof(state->'paused') = 'boolean'
    and jsonb_typeof(state->'pair') = 'string'
    and state->>'pair' in ('USDJPY','EURJPY','GBPJPY','EURUSD')
    and jsonb_typeof(state->'scenario') = 'string'
    and state->>'scenario' in ('balanced','bullish','bearish','volatile')
    and jsonb_typeof(state->'timeframe') = 'string'
    and state->>'timeframe' in ('1m','5m','15m','1h')
    and jsonb_typeof(state->'speed') = 'number'
    and state->>'speed' in ('1','2','5')
    and octet_length(state::text) <= 3145728
), false)) not valid;
alter table public.practice_accounts validate constraint mango_practice_state_shape;

alter table public.practice_accounts enable row level security;
alter table public.practice_accounts force row level security;
revoke all on public.practice_accounts from public, anon, authenticated;
grant select on public.practice_accounts to authenticated;

drop policy if exists mango_practice_read_own on public.practice_accounts;
create policy mango_practice_read_own on public.practice_accounts for select to authenticated
  using ((select auth.uid()) = user_id);
-- A restrictive policy also protects against an unrelated permissive policy
-- accidentally being added to the same table later.
drop policy if exists mango_practice_owner_guard on public.practice_accounts;
create policy mango_practice_owner_guard on public.practice_accounts as restrictive for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create or replace function public.save_practice_account(
  p_state jsonb,
  p_expected_revision bigint,
  p_expected_user_id uuid
) returns table(state jsonb, revision bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null or p_expected_user_id is null or current_user_id <> p_expected_user_id then
    raise exception using errcode = '42501', message = 'ACCOUNT_USER_CHANGED';
  end if;
  if p_state is null or jsonb_typeof(p_state) <> 'object'
    or jsonb_typeof(p_state->'version') is distinct from 'number'
    or p_state->>'version' is distinct from '1'
    or jsonb_typeof(p_state->'account') is distinct from 'object'
    or jsonb_typeof(p_state->'account'->'balance') is distinct from 'number'
    or jsonb_typeof(p_state->'account'->'positions') is distinct from 'array'
    or jsonb_typeof(p_state->'account'->'orders') is distinct from 'array'
    or jsonb_typeof(p_state->'account'->'history') is distinct from 'array'
    or jsonb_typeof(p_state->'markets') is distinct from 'object'
    or jsonb_typeof(p_state->'baseline') is distinct from 'object'
    or jsonb_typeof(p_state->'paused') is distinct from 'boolean'
    or jsonb_typeof(p_state->'pair') is distinct from 'string'
    or p_state->>'pair' not in ('USDJPY','EURJPY','GBPJPY','EURUSD')
    or jsonb_typeof(p_state->'scenario') is distinct from 'string'
    or p_state->>'scenario' not in ('balanced','bullish','bearish','volatile')
    or jsonb_typeof(p_state->'timeframe') is distinct from 'string'
    or p_state->>'timeframe' not in ('1m','5m','15m','1h')
    or jsonb_typeof(p_state->'speed') is distinct from 'number'
    or p_state->>'speed' not in ('1','2','5') then
    raise exception using errcode = '22023', message = 'INVALID_ACCOUNT_STATE';
  end if;
  if octet_length(p_state::text) > 3145728 then
    raise exception using errcode = '22023', message = 'ACCOUNT_STATE_TOO_LARGE';
  end if;
  if jsonb_array_length(p_state->'account'->'positions') > 100
    or jsonb_array_length(p_state->'account'->'orders') > 100 then
    raise exception using errcode = '22023', message = 'INVALID_ACCOUNT_STATE';
  end if;

  if p_expected_revision is null then
    return query
      insert into public.practice_accounts as created(user_id, state, revision, updated_at)
      values (current_user_id, p_state, 1, clock_timestamp())
      on conflict (user_id) do nothing
      returning created.state, created.revision, created.updated_at;
  elsif p_expected_revision >= 1 then
    return query
      update public.practice_accounts as existing
      set state = p_state, revision = existing.revision + 1, updated_at = clock_timestamp()
      where existing.user_id = current_user_id and existing.revision = p_expected_revision
      returning existing.state, existing.revision, existing.updated_at;
  else
    raise exception using errcode = '22023', message = 'INVALID_ACCOUNT_REVISION';
  end if;
  if not found then
    raise exception using errcode = 'P0001', message = 'ACCOUNT_CONFLICT';
  end if;
end;
$function$;

revoke all on function public.save_practice_account(jsonb, bigint, uuid) from public, anon;
grant execute on function public.save_practice_account(jsonb, bigint, uuid) to authenticated;

commit;
