-- MANGO FX: virtual-profit prize draws with administrator-approved delivery.
-- Run AFTER schema.sql, photo-shop.sql and shop-files.sql. Existing data stays intact.
begin;

create table if not exists public.shop_lotteries (
  product_id uuid primary key references public.shop_photos(id) on delete restrict,
  entry_cost integer not null check (entry_cost between 1 and 100000000),
  win_rate_bps integer not null check (win_rate_bps between 1 and 10000),
  enabled boolean not null default false,
  revision bigint not null default 1 check (revision >= 1),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists public.shop_lottery_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  request_id uuid not null,
  product_id uuid not null references public.shop_photos(id) on delete restrict,
  outcome text not null check (outcome in ('win', 'lose')),
  cost integer not null check (cost between 1 and 100000000),
  created_at timestamptz not null default clock_timestamp(),
  order_id uuid unique references public.shop_file_orders(id) on delete restrict,
  refunded_at timestamptz,
  unique (user_id, request_id),
  constraint shop_lottery_result_shape check (
    (outcome = 'win' and order_id is not null)
    or (outcome = 'lose' and order_id is null and refunded_at is null)
  )
);
create index if not exists shop_lottery_entries_owner on public.shop_lottery_entries(user_id, created_at desc);

alter table public.shop_lotteries enable row level security;
alter table public.shop_lotteries force row level security;
alter table public.shop_lottery_entries enable row level security;
alter table public.shop_lottery_entries force row level security;
revoke all on public.shop_lotteries, public.shop_lottery_entries from public, anon, authenticated;
grant select on public.shop_lottery_entries to authenticated;
drop policy if exists mango_lottery_entries_read on public.shop_lottery_entries;
create policy mango_lottery_entries_read on public.shop_lottery_entries for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists mango_lottery_entries_guard on public.shop_lottery_entries;
create policy mango_lottery_entries_guard on public.shop_lottery_entries as restrictive for all to authenticated
  using (user_id = (select auth.uid())) with check (false);

-- UUID v4 uses PostgreSQL's strong random source. Rejection sampling removes
-- modulo bias. Neither a random seed nor an outcome is accepted from the client.
create or replace function public.shop_lottery_roll() returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare sample bigint;
begin
  loop
    sample := ('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint;
    exit when sample < 4294960000;
  end loop;
  return mod(sample, 10000)::integer;
end;
$$;

create or replace function public.shop_reward_wallet(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare profit bigint := 0; spent bigint := 0;
begin
  if p_user_id is not null then
    select least(9007199254740991::numeric, greatest(0::numeric,
      floor((a.state->'account'->>'balance')::numeric - 1000000)))::bigint
      into profit from public.practice_accounts a where a.user_id = p_user_id;
    select coalesce(sum(value), 0)::bigint into spent from (
      select b.paid_price::bigint as value from public.shop_purchases b where b.user_id = p_user_id
      union all select o.paid_price::bigint from public.shop_file_orders o
        where o.user_id = p_user_id and o.status in ('pending', 'approved')
      union all select e.cost::bigint from public.shop_lottery_entries e
        where e.user_id = p_user_id and e.refunded_at is null
    ) charges;
  end if;
  return jsonb_build_object('realizedProfit', coalesce(profit, 0), 'spentProfit', spent,
    'availableProfit', greatest(0::bigint, coalesce(profit, 0) - spent));
end;
$$;

create or replace function public.get_reward_shop(p_expected_user_id uuid default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare result jsonb; products jsonb;
begin
  result := public.shop_reward_snapshot(p_expected_user_id);
  select coalesce(jsonb_agg(item.value || jsonb_build_object('lottery',
    case when lottery.product_id is not null and item.value->>'saleMode' = 'lottery'
      then jsonb_build_object('entryCost', lottery.entry_cost, 'winRateBps', lottery.win_rate_bps,
        'enabled', lottery.enabled, 'revision', lottery.revision)
      else null end) order by item.position), '[]'::jsonb)
    into products from jsonb_array_elements(result->'photos') with ordinality item(value, position)
    left join public.shop_lotteries lottery on lottery.product_id = (item.value->>'id')::uuid;
  return jsonb_set(result, '{photos}', products) || jsonb_build_object('lotteriesReady', true);
end;
$$;

-- A price edit through the ordinary product form must also invalidate stale
-- draw confirmations. configure_shop_lottery updates its row first, so it does
-- not increment this revision twice.
create or replace function public.shop_sync_lottery_price() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.sale_mode = 'lottery' then
    update public.shop_lotteries set entry_cost = new.price, revision = revision + 1,
      updated_at = clock_timestamp() where product_id = new.id and entry_cost is distinct from new.price;
  end if;
  return new;
end;
$$;
drop trigger if exists mango_sync_lottery_price on public.shop_photos;
create trigger mango_sync_lottery_price after update of price on public.shop_photos
  for each row execute function public.shop_sync_lottery_price();

create or replace function public.shop_refund_rejected_lottery_order() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.status = 'pending' and new.status = 'rejected' and new.source = 'lottery' then
    update public.shop_lottery_entries set refunded_at = coalesce(refunded_at, clock_timestamp())
      where order_id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists mango_refund_rejected_lottery_order on public.shop_file_orders;
create trigger mango_refund_rejected_lottery_order after update of status on public.shop_file_orders
  for each row execute function public.shop_refund_rejected_lottery_order();

create or replace function public.shop_lottery_entry_json(p_entry public.shop_lottery_entries) returns jsonb
language sql stable security definer set search_path = ''
as $$ select jsonb_build_object('id', p_entry.id, 'requestId', p_entry.request_id,
  'productId', p_entry.product_id, 'outcome', p_entry.outcome, 'cost', p_entry.cost,
  'createdAt', p_entry.created_at, 'refunded', p_entry.refunded_at is not null, 'orderId', p_entry.order_id) $$;

create or replace function public.configure_shop_lottery(
  p_product_id uuid, p_entry_cost integer, p_win_rate_bps integer, p_enabled boolean,
  p_expected_revision bigint, p_expected_user_id uuid
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare current_id uuid := auth.uid(); product public.shop_photos%rowtype; config public.shop_lotteries%rowtype;
begin
  if current_id is null or current_id is distinct from p_expected_user_id then
    raise exception using errcode = '42501', message = 'ACCOUNT_USER_CHANGED';
  end if;
  if not public.shop_has_admin_access() then raise exception using errcode = '42501', message = 'SHOP_ADMIN_REQUIRED'; end if;
  if p_product_id is null or p_entry_cost is null or p_entry_cost not between 1 and 100000000
    or p_win_rate_bps is null or p_win_rate_bps not between 1 and 10000 or p_enabled is null then
    raise exception using errcode = '22023', message = 'SHOP_INVALID_LOTTERY';
  end if;
  select * into product from public.shop_photos where id = p_product_id for update;
  if not found or product.kind <> 'file' then raise exception using errcode = 'P0001', message = 'SHOP_LOTTERY_NOT_FOUND'; end if;
  select * into config from public.shop_lotteries where product_id = p_product_id for update;
  if found then
    if p_expected_revision is null or p_expected_revision < 1 or p_expected_revision <> config.revision then
      raise exception using errcode = 'P0001', message = 'SHOP_LOTTERY_CONFLICT';
    end if;
    update public.shop_lotteries set entry_cost = p_entry_cost, win_rate_bps = p_win_rate_bps,
      enabled = p_enabled, revision = revision + 1, updated_at = clock_timestamp() where product_id = p_product_id;
  else
    if p_expected_revision is not null then raise exception using errcode = 'P0001', message = 'SHOP_LOTTERY_CONFLICT'; end if;
    insert into public.shop_lotteries(product_id, entry_cost, win_rate_bps, enabled)
      values(p_product_id, p_entry_cost, p_win_rate_bps, p_enabled);
  end if;
  update public.shop_photos set sale_mode = 'lottery', price = p_entry_cost,
    revision = revision + 1, updated_at = clock_timestamp() where id = p_product_id;
  return public.get_reward_shop(current_id);
end;
$$;

create or replace function public.get_shop_lottery_entry(
  p_product_id uuid, p_request_id uuid, p_expected_user_id uuid
) returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare current_id uuid := auth.uid(); entry public.shop_lottery_entries%rowtype;
begin
  if current_id is null or current_id is distinct from p_expected_user_id then
    raise exception using errcode = '42501', message = 'ACCOUNT_USER_CHANGED';
  end if;
  select * into entry from public.shop_lottery_entries where user_id = current_id
    and product_id = p_product_id and request_id = p_request_id;
  return case when found then public.shop_lottery_entry_json(entry) else null end;
end;
$$;

create or replace function public.draw_shop_lottery(
  p_product_id uuid, p_expected_revision bigint, p_request_id uuid, p_expected_user_id uuid
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare current_id uuid := auth.uid(); product public.shop_photos%rowtype; config public.shop_lotteries%rowtype;
  entry public.shop_lottery_entries%rowtype; wallet jsonb; result text; winning_order uuid;
begin
  if current_id is null or current_id is distinct from p_expected_user_id then
    raise exception using errcode = '42501', message = 'ACCOUNT_USER_CHANGED';
  end if;
  if p_product_id is null or p_request_id is null then raise exception using errcode = '22023', message = 'SHOP_INVALID_LOTTERY'; end if;
  select * into entry from public.shop_lottery_entries where user_id = current_id and request_id = p_request_id;
  if found then
    if entry.product_id <> p_product_id then raise exception using errcode = '22023', message = 'SHOP_LOTTERY_REQUEST_CONFLICT'; end if;
    return jsonb_build_object('shop', public.get_reward_shop(current_id), 'entry', public.shop_lottery_entry_json(entry));
  end if;
  perform 1 from public.practice_accounts where user_id = current_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'SHOP_ACCOUNT_REQUIRED'; end if;
  -- Recheck after the shared wallet lock, including concurrent retries.
  select * into entry from public.shop_lottery_entries where user_id = current_id and request_id = p_request_id;
  if found then
    if entry.product_id <> p_product_id then raise exception using errcode = '22023', message = 'SHOP_LOTTERY_REQUEST_CONFLICT'; end if;
    return jsonb_build_object('shop', public.get_reward_shop(current_id), 'entry', public.shop_lottery_entry_json(entry));
  end if;
  select * into product from public.shop_photos where id = p_product_id for update;
  if not found or product.kind <> 'file' or product.sale_mode <> 'lottery' then
    raise exception using errcode = 'P0001', message = 'SHOP_LOTTERY_NOT_FOUND';
  end if;
  select * into config from public.shop_lotteries where product_id = p_product_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'SHOP_LOTTERY_NOT_FOUND'; end if;
  if not product.published or not config.enabled then raise exception using errcode = 'P0001', message = 'SHOP_LOTTERY_UNAVAILABLE'; end if;
  if p_expected_revision is null or p_expected_revision <> config.revision then
    raise exception using errcode = 'P0001', message = 'SHOP_LOTTERY_CHANGED';
  end if;
  if exists(select 1 from public.shop_file_orders where photo_id = p_product_id and status in ('pending', 'approved')) then
    raise exception using errcode = 'P0001', message = 'SHOP_OUT_OF_STOCK';
  end if;
  wallet := public.shop_reward_wallet(current_id);
  if (wallet->>'availableProfit')::bigint < config.entry_cost then
    raise exception using errcode = 'P0001', message = 'SHOP_INSUFFICIENT_PROFIT';
  end if;
  result := case when public.shop_lottery_roll() < config.win_rate_bps then 'win' else 'lose' end;
  if result = 'win' then
    insert into public.shop_file_orders(user_id, photo_id, paid_price, source)
      values(current_id, p_product_id, 0, 'lottery') returning id into winning_order;
  end if;
  insert into public.shop_lottery_entries(user_id, request_id, product_id, outcome, cost, order_id)
    values(current_id, p_request_id, p_product_id, result, config.entry_cost, winning_order) returning * into entry;
  return jsonb_build_object('shop', public.get_reward_shop(current_id), 'entry', public.shop_lottery_entry_json(entry));
end;
$$;

revoke all on function public.shop_lottery_roll(), public.shop_reward_wallet(uuid),
  public.shop_sync_lottery_price(), public.shop_refund_rejected_lottery_order(),
  public.shop_lottery_entry_json(public.shop_lottery_entries) from public, anon, authenticated;
revoke all on function public.get_reward_shop(uuid),
  public.configure_shop_lottery(uuid, integer, integer, boolean, bigint, uuid),
  public.draw_shop_lottery(uuid, bigint, uuid, uuid), public.get_shop_lottery_entry(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_reward_shop(uuid) to anon, authenticated;
grant execute on function public.configure_shop_lottery(uuid, integer, integer, boolean, bigint, uuid),
  public.draw_shop_lottery(uuid, bigint, uuid, uuid), public.get_shop_lottery_entry(uuid, uuid, uuid)
  to authenticated;

notify pgrst, 'reload schema';
commit;
