-- MANGO FX: add single-stock digital files with administrator-reviewed delivery.
-- Run AFTER schema.sql and photo-shop.sql. Existing photos and purchases are preserved.
begin;

alter table public.shop_photos add column if not exists kind text not null default 'photo';
alter table public.shop_photos add column if not exists file_ext text;
alter table public.shop_photos add column if not exists sale_mode text not null default 'direct';
alter table public.shop_photos drop constraint if exists shop_product_sale_mode;
alter table public.shop_photos add constraint shop_product_sale_mode check (sale_mode in ('direct', 'lottery'));
alter table public.shop_photos alter column preview_path drop not null;
alter table public.shop_photos drop constraint if exists shop_photo_paths;
alter table public.shop_photos drop constraint if exists shop_product_paths;
alter table public.shop_photos add constraint shop_product_paths check (coalesce((
  (kind = 'photo' and file_ext is null and preview_path = id::text || '/preview.jpg'
    and original_path in (id::text || '/original.jpg', id::text || '/original.png', id::text || '/original.webp'))
  or (kind = 'file' and file_ext in ('txt', 'pdf', 'zip') and preview_path is null
    and original_path = id::text || '/original.' || file_ext)
), false));

create table if not exists public.shop_file_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  photo_id uuid not null references public.shop_photos(id) on delete restrict,
  paid_price integer not null check (paid_price between 0 and 100000000),
  source text not null default 'purchase' check (source in ('purchase', 'lottery')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  purchased_at timestamptz not null default clock_timestamp(),
  reviewed_at timestamptz,
  reviewer_id uuid references auth.users(id) on delete set null,
  constraint shop_file_payment_source check (paid_price >= 1 or source = 'lottery'),
  constraint shop_file_review_shape check (
    (status = 'pending' and reviewed_at is null and reviewer_id is null)
    or (status in ('approved', 'rejected') and reviewed_at is not null)
  )
);
-- Refresh only constraints introduced by this extension; preserve existing orders.
alter table public.shop_file_orders add column if not exists source text not null default 'purchase'
  check (source in ('purchase', 'lottery'));
alter table public.shop_file_orders drop constraint if exists shop_file_orders_paid_price_check;
alter table public.shop_file_orders add constraint shop_file_orders_paid_price_check
  check (paid_price between 0 and 100000000);
alter table public.shop_file_orders drop constraint if exists shop_file_payment_source;
alter table public.shop_file_orders add constraint shop_file_payment_source check (paid_price >= 1 or source = 'lottery');

-- Approved allocations survive deleting the buyer's auth account, so a code
-- already delivered can never become saleable again through account deletion.
create unique index if not exists shop_file_one_active_order
  on public.shop_file_orders(photo_id) where status in ('pending', 'approved');
create index if not exists shop_file_orders_owner on public.shop_file_orders(user_id, purchased_at desc);

alter table public.shop_file_orders enable row level security;
alter table public.shop_file_orders force row level security;
revoke all on public.shop_file_orders from public, anon, authenticated;
grant select on public.shop_file_orders to authenticated;
grant select (kind, file_ext, sale_mode) on public.shop_photos to anon, authenticated;
drop policy if exists mango_shop_file_orders_read on public.shop_file_orders;
create policy mango_shop_file_orders_read on public.shop_file_orders for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists mango_shop_file_orders_guard on public.shop_file_orders;
create policy mango_shop_file_orders_guard on public.shop_file_orders as restrictive for all to authenticated
  using (user_id = (select auth.uid())) with check (false);

create or replace function public.shop_photo_visible(p_photo_id uuid, p_published boolean) returns boolean
language sql stable security definer set search_path = ''
as $$ select p_published or public.shop_has_admin_access() or exists (
  select 1 from public.shop_purchases where user_id = auth.uid() and photo_id = p_photo_id
) or exists (
  select 1 from public.shop_file_orders where user_id = auth.uid() and photo_id = p_photo_id
) $$;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('shop-files', 'shop-files', false, 15728640,
  array['text/plain', 'application/pdf', 'application/zip', 'application/octet-stream'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.shop_can_read_file(p_name text) returns boolean
language sql stable security definer set search_path = ''
as $$ select auth.uid() is not null and (public.shop_has_admin_access() or exists (
  select 1 from public.shop_photos p join public.shop_file_orders o on o.photo_id = p.id
  where p.kind = 'file' and p.original_path = p_name and o.user_id = auth.uid() and o.status = 'approved'
)) $$;
create or replace function public.shop_can_upload_file(p_name text) returns boolean
language sql stable security definer set search_path = ''
as $$ select public.shop_has_admin_access()
  and p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/original[.](txt|pdf|zip)$' $$;
create or replace function public.shop_can_delete_file(p_name text) returns boolean
language sql stable security definer set search_path = ''
as $$ select public.shop_has_admin_access() and not exists (
  select 1 from public.shop_photos p where p.kind = 'file' and p.original_path = p_name
) $$;

drop policy if exists mango_shop_files_read on storage.objects;
create policy mango_shop_files_read on storage.objects for select to anon, authenticated
  using (bucket_id = 'shop-files' and public.shop_can_read_file(name));
drop policy if exists mango_shop_files_insert on storage.objects;
create policy mango_shop_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'shop-files' and public.shop_can_upload_file(name));
drop policy if exists mango_shop_files_delete on storage.objects;
create policy mango_shop_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'shop-files' and public.shop_can_delete_file(name));
drop policy if exists mango_shop_files_read_guard on storage.objects;
create policy mango_shop_files_read_guard on storage.objects as restrictive for select to anon, authenticated
  using (bucket_id <> 'shop-files' or public.shop_can_read_file(name));
drop policy if exists mango_shop_files_insert_guard on storage.objects;
create policy mango_shop_files_insert_guard on storage.objects as restrictive for insert to anon, authenticated
  with check (bucket_id <> 'shop-files' or public.shop_can_upload_file(name));
drop policy if exists mango_shop_files_update_guard on storage.objects;
create policy mango_shop_files_update_guard on storage.objects as restrictive for update to anon, authenticated
  using (bucket_id <> 'shop-files') with check (bucket_id <> 'shop-files');
drop policy if exists mango_shop_files_delete_guard on storage.objects;
create policy mango_shop_files_delete_guard on storage.objects as restrictive for delete to anon, authenticated
  using (bucket_id <> 'shop-files' or public.shop_can_delete_file(name));
drop policy if exists mango_shop_files_bucket_update_guard on storage.buckets;
create policy mango_shop_files_bucket_update_guard on storage.buckets as restrictive for update to anon, authenticated
  using (id <> 'shop-files') with check (id <> 'shop-files');
drop policy if exists mango_shop_files_bucket_delete_guard on storage.buckets;
create policy mango_shop_files_bucket_delete_guard on storage.buckets as restrictive for delete to anon, authenticated
  using (id <> 'shop-files');

-- Internal helper only. There is no public API to inspect another person's wallet.
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
    ) s;
  end if;
  return jsonb_build_object('realizedProfit', coalesce(profit, 0), 'spentProfit', spent,
    'availableProfit', greatest(0::bigint, coalesce(profit, 0) - spent));
end;
$$;
revoke all on function public.shop_reward_wallet(uuid) from public, anon, authenticated;

create or replace function public.shop_reward_snapshot(p_expected_user_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare current_id uuid := auth.uid(); actor_role text; catalog jsonb; review_orders jsonb := '[]'::jsonb;
begin
  if current_id is distinct from p_expected_user_id then
    raise exception using errcode = '42501', message = 'ACCOUNT_USER_CHANGED';
  end if;
  if current_id is not null then select role into actor_role from public.shop_roles where user_id = current_id; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'title', p.title, 'description', p.description, 'price', p.price,
    'published', p.published, 'previewPath', p.preview_path, 'revision', p.revision, 'createdAt', p.created_at,
    'kind', p.kind, 'fileType', p.file_ext, 'saleMode', p.sale_mode,
    'stockRemaining', case when p.kind = 'file' then case when exists (
      select 1 from public.shop_file_orders held where held.photo_id = p.id and held.status in ('pending', 'approved')
    ) then 0 else 1 end else null end,
    'purchased', case when p.kind = 'photo' then b.user_id is not null else coalesce(o.status in ('pending', 'approved'), false) end,
    'paidPrice', case when p.kind = 'photo' then b.paid_price else o.paid_price end,
    'purchasedAt', case when p.kind = 'photo' then b.purchased_at else o.purchased_at end,
    'orderId', o.id, 'orderSource', o.source,
    'deliveryStatus', case when p.kind = 'photo' then case when b.user_id is not null then 'approved' else 'not_purchased' end
      else coalesce(o.status, 'not_purchased') end
  ) order by p.created_at desc, p.id), '[]'::jsonb) into catalog
  from public.shop_photos p
  left join public.shop_purchases b on b.photo_id = p.id and b.user_id = current_id
  left join lateral (select fo.* from public.shop_file_orders fo
    where fo.photo_id = p.id and fo.user_id = current_id order by fo.purchased_at desc, fo.id desc limit 1) o on true
  where p.published or actor_role in ('developer', 'admin') or b.user_id is not null or o.id is not null;
  if actor_role in ('developer', 'admin') then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id, 'productId', o.photo_id, 'productTitle', p.title,
      'buyerLabel', coalesce(u.email, case when o.user_id is null then '削除済みアカウント' else left(o.user_id::text, 8) end),
      'paidPrice', o.paid_price, 'status', o.status, 'source', o.source, 'purchasedAt', o.purchased_at, 'reviewedAt', o.reviewed_at
    ) order by o.purchased_at desc, o.id), '[]'::jsonb) into review_orders
    from public.shop_file_orders o join public.shop_photos p on p.id = o.photo_id
    left join auth.users u on u.id = o.user_id;
  end if;
  return public.shop_reward_wallet(current_id) || jsonb_build_object('role', actor_role,
    'photos', catalog, 'orders', review_orders);
end;
$$;

revoke all on function public.shop_reward_snapshot(uuid) from public, anon, authenticated;

create or replace function public.get_reward_shop(p_expected_user_id uuid default null) returns jsonb
language sql security definer set search_path = ''
as $$ select public.shop_reward_snapshot(p_expected_user_id) $$;

create or replace function public.purchase_shop_product(
  p_product_id uuid, p_expected_price integer, p_expected_user_id uuid
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare current_id uuid := auth.uid(); product public.shop_photos%rowtype; wallet jsonb;
begin
  if current_id is null or current_id is distinct from p_expected_user_id then
    raise exception using errcode = '42501', message = 'ACCOUNT_USER_CHANGED';
  end if;
  -- Serialize purchases of different products against this user's shared wallet.
  perform 1 from public.practice_accounts where user_id = current_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'SHOP_ACCOUNT_REQUIRED'; end if;
  select * into product from public.shop_photos where id = p_product_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'SHOP_PHOTO_NOT_FOUND'; end if;
  if product.kind = 'photo' then
    if exists(select 1 from public.shop_purchases where user_id = current_id and photo_id = product.id) then
      return public.get_reward_shop(current_id);
    end if;
  else
    if exists(select 1 from public.shop_file_orders where user_id = current_id and photo_id = product.id and status in ('pending', 'approved')) then
      return public.get_reward_shop(current_id);
    end if;
    if exists(select 1 from public.shop_file_orders where photo_id = product.id and status in ('pending', 'approved')) then
      raise exception using errcode = 'P0001', message = 'SHOP_OUT_OF_STOCK';
    end if;
  end if;
  if product.sale_mode <> 'direct' then raise exception using errcode = 'P0001', message = 'SHOP_LOTTERY_REQUIRED'; end if;
  if not product.published then raise exception using errcode = 'P0001', message = 'SHOP_PHOTO_UNAVAILABLE'; end if;
  if p_expected_price is distinct from product.price then raise exception using errcode = 'P0001', message = 'SHOP_PRICE_CHANGED'; end if;
  wallet := public.shop_reward_wallet(current_id);
  if (wallet->>'availableProfit')::bigint < product.price then
    raise exception using errcode = 'P0001', message = 'SHOP_INSUFFICIENT_PROFIT';
  end if;
  if product.kind = 'photo' then
    insert into public.shop_purchases(user_id, photo_id, paid_price) values (current_id, product.id, product.price);
  else
    insert into public.shop_file_orders(user_id, photo_id, paid_price) values (current_id, product.id, product.price);
  end if;
  return public.get_reward_shop(current_id);
end;
$$;

create or replace function public.save_shop_product(
  p_product_id uuid, p_kind text, p_title text, p_description text, p_price integer, p_published boolean,
  p_preview_path text, p_original_path text, p_file_ext text, p_expected_revision bigint, p_expected_user_id uuid
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare current_id uuid := auth.uid(); existing public.shop_photos%rowtype;
  item_preview text; item_original text; item_ext text; item_bucket text;
begin
  if current_id is null or current_id is distinct from p_expected_user_id then
    raise exception using errcode = '42501', message = 'ACCOUNT_USER_CHANGED';
  end if;
  if not public.shop_has_admin_access() then raise exception using errcode = '42501', message = 'SHOP_ADMIN_REQUIRED'; end if;
  if p_product_id is null or p_kind is null or p_kind not in ('photo', 'file')
    or p_title is null or char_length(btrim(p_title)) not between 1 and 120
    or char_length(coalesce(p_description, '')) > 2000 or p_price is null or p_price not between 1 and 100000000
    or p_published is null then raise exception using errcode = '22023', message = 'SHOP_INVALID_PHOTO'; end if;
  if p_expected_revision is null then
    if exists(select 1 from public.shop_photos where id = p_product_id) then
      raise exception using errcode = 'P0001', message = 'SHOP_PHOTO_CONFLICT';
    end if;
    item_preview := p_preview_path; item_original := p_original_path; item_ext := p_file_ext;
  else
    select * into existing from public.shop_photos where id = p_product_id for update;
    if not found then raise exception using errcode = 'P0001', message = 'SHOP_PHOTO_NOT_FOUND'; end if;
    if p_expected_revision < 1 or existing.revision <> p_expected_revision then
      raise exception using errcode = 'P0001', message = 'SHOP_PHOTO_CONFLICT';
    end if;
    if p_kind <> existing.kind or (p_preview_path is not null and p_preview_path is distinct from existing.preview_path)
      or (p_original_path is not null and p_original_path <> existing.original_path)
      or (p_file_ext is not null and p_file_ext is distinct from existing.file_ext) then
      raise exception using errcode = '22023', message = 'SHOP_FILES_IMMUTABLE';
    end if;
    item_preview := existing.preview_path; item_original := existing.original_path; item_ext := existing.file_ext;
  end if;
  if p_kind = 'photo' then
    if item_preview is distinct from p_product_id::text || '/preview.jpg' or item_ext is not null
      or item_original is null or item_original not in (p_product_id::text || '/original.jpg', p_product_id::text || '/original.png', p_product_id::text || '/original.webp') then
      raise exception using errcode = '22023', message = 'SHOP_INVALID_PHOTO';
    end if;
    item_bucket := 'photo-originals';
    if not exists(select 1 from storage.objects where bucket_id = 'photo-previews' and name = item_preview) then
      raise exception using errcode = 'P0001', message = 'SHOP_FILES_MISSING';
    end if;
  else
    if item_preview is not null or item_ext is null or item_ext not in ('txt', 'pdf', 'zip')
      or item_original is distinct from p_product_id::text || '/original.' || item_ext then
      raise exception using errcode = '22023', message = 'SHOP_INVALID_PHOTO';
    end if;
    item_bucket := 'shop-files';
  end if;
  if not exists(select 1 from storage.objects where bucket_id = item_bucket and name = item_original) then
    raise exception using errcode = 'P0001', message = 'SHOP_FILES_MISSING';
  end if;
  if p_expected_revision is null then
    insert into public.shop_photos(id, kind, file_ext, title, description, price, published, preview_path, original_path)
      values(p_product_id, p_kind, item_ext, btrim(p_title), coalesce(p_description, ''), p_price, p_published, item_preview, item_original)
      on conflict(id) do nothing;
    if not found then raise exception using errcode = 'P0001', message = 'SHOP_PHOTO_CONFLICT'; end if;
  else
    update public.shop_photos set title = btrim(p_title), description = coalesce(p_description, ''), price = p_price,
      published = p_published, revision = revision + 1, updated_at = clock_timestamp() where id = p_product_id;
  end if;
  return public.get_reward_shop(current_id);
end;
$$;

create or replace function public.get_shop_product_download(p_product_id uuid, p_expected_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare current_id uuid := auth.uid(); product public.shop_photos%rowtype; clean_title text; order_status text;
begin
  if current_id is null or current_id is distinct from p_expected_user_id then
    raise exception using errcode = '42501', message = 'ACCOUNT_USER_CHANGED';
  end if;
  select * into product from public.shop_photos where id = p_product_id;
  if not found then raise exception using errcode = 'P0001', message = 'SHOP_PHOTO_NOT_FOUND'; end if;
  if not public.shop_has_admin_access() then
    if product.kind = 'photo' then
      if not exists(select 1 from public.shop_purchases where user_id = current_id and photo_id = product.id) then
        raise exception using errcode = '42501', message = 'SHOP_PURCHASE_REQUIRED';
      end if;
    else
      select status into order_status from public.shop_file_orders where user_id = current_id and photo_id = product.id
        order by purchased_at desc, id desc limit 1;
      if order_status = 'pending' then raise exception using errcode = '42501', message = 'SHOP_ORDER_PENDING'; end if;
      if order_status is distinct from 'approved' then raise exception using errcode = '42501', message = 'SHOP_PURCHASE_REQUIRED'; end if;
    end if;
  end if;
  clean_title := left(regexp_replace(product.title, '[\\/:*?"<>|[:cntrl:]]', '_', 'g'), 80);
  return jsonb_build_object('bucket', case when product.kind = 'file' then 'shop-files' else 'photo-originals' end,
    'originalPath', product.original_path,
    'fileName', coalesce(nullif(btrim(clean_title), ''), 'MANGO-FX') || '.' || split_part(product.original_path, '.', 2));
end;
$$;

create or replace function public.review_shop_order(p_order_id uuid, p_decision text, p_expected_user_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare current_id uuid := auth.uid(); product_id uuid; current_order public.shop_file_orders%rowtype; next_status text;
begin
  if current_id is null or current_id is distinct from p_expected_user_id then
    raise exception using errcode = '42501', message = 'ACCOUNT_USER_CHANGED';
  end if;
  if not public.shop_has_admin_access() then raise exception using errcode = '42501', message = 'SHOP_ADMIN_REQUIRED'; end if;
  if p_decision not in ('approve', 'reject') or p_decision is null then
    raise exception using errcode = '22023', message = 'SHOP_INVALID_DECISION';
  end if;
  select photo_id into product_id from public.shop_file_orders where id = p_order_id;
  if not found then raise exception using errcode = 'P0001', message = 'SHOP_ORDER_CONFLICT'; end if;
  -- Product first matches the product/order order used by purchasing.
  perform 1 from public.shop_photos where id = product_id for update;
  select * into current_order from public.shop_file_orders where id = p_order_id for update;
  next_status := case when p_decision = 'approve' then 'approved' else 'rejected' end;
  if current_order.status = next_status then return public.get_reward_shop(current_id); end if;
  if current_order.status <> 'pending' or (p_decision = 'approve' and current_order.user_id is null) then
    raise exception using errcode = 'P0001', message = 'SHOP_ORDER_CONFLICT';
  end if;
  update public.shop_file_orders set status = next_status, reviewer_id = current_id, reviewed_at = clock_timestamp()
    where id = p_order_id;
  return public.get_reward_shop(current_id);
end;
$$;

-- Compatibility endpoints remain photo-only. Cached older clients cannot
-- insert a file purchase into the old instant-delivery ledger to bypass review.
create or replace function public.get_photo_shop(p_expected_user_id uuid default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare result jsonb;
begin
  result := public.get_reward_shop(p_expected_user_id);
  return (result - 'orders') || jsonb_build_object('photos', coalesce((
    select jsonb_agg(p.value) from jsonb_array_elements(result->'photos') p(value) where p.value->>'kind' = 'photo'
  ), '[]'::jsonb));
end;
$$;
create or replace function public.purchase_shop_photo(p_photo_id uuid, p_expected_price integer, p_expected_user_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_expected_user_id then
    raise exception using errcode = '42501', message = 'ACCOUNT_USER_CHANGED';
  end if;
  if not exists(select 1 from public.shop_photos where id = p_photo_id and kind = 'photo') then
    raise exception using errcode = 'P0001', message = 'SHOP_PHOTO_NOT_FOUND';
  end if;
  perform public.purchase_shop_product(p_photo_id, p_expected_price, p_expected_user_id);
  return public.get_photo_shop(p_expected_user_id);
end;
$$;
create or replace function public.save_shop_photo(
  p_photo_id uuid, p_title text, p_description text, p_price integer, p_published boolean,
  p_preview_path text, p_original_path text, p_expected_revision bigint, p_expected_user_id uuid
) returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  perform public.save_shop_product(p_photo_id, 'photo', p_title, p_description, p_price, p_published,
    p_preview_path, p_original_path, null, p_expected_revision, p_expected_user_id);
  return public.get_photo_shop(p_expected_user_id);
end;
$$;
create or replace function public.get_shop_photo_download(p_photo_id uuid, p_expected_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_expected_user_id then
    raise exception using errcode = '42501', message = 'ACCOUNT_USER_CHANGED';
  end if;
  if not exists(select 1 from public.shop_photos where id = p_photo_id and kind = 'photo') then
    raise exception using errcode = 'P0001', message = 'SHOP_PHOTO_NOT_FOUND';
  end if;
  return public.get_shop_product_download(p_photo_id, p_expected_user_id) - 'bucket';
end;
$$;

revoke all on function public.shop_can_read_file(text), public.shop_can_upload_file(text), public.shop_can_delete_file(text)
  from public, anon, authenticated;
grant execute on function public.shop_can_read_file(text), public.shop_can_upload_file(text), public.shop_can_delete_file(text)
  to anon, authenticated;
revoke all on function public.get_reward_shop(uuid), public.purchase_shop_product(uuid, integer, uuid),
  public.save_shop_product(uuid, text, text, text, integer, boolean, text, text, text, bigint, uuid),
  public.get_shop_product_download(uuid, uuid), public.review_shop_order(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.get_reward_shop(uuid) to anon, authenticated;
grant execute on function public.purchase_shop_product(uuid, integer, uuid),
  public.save_shop_product(uuid, text, text, text, integer, boolean, text, text, text, bigint, uuid),
  public.get_shop_product_download(uuid, uuid), public.review_shop_order(uuid, text, uuid) to authenticated;
-- CREATE OR REPLACE retains the old RPC grants, which were already restricted.

notify pgrst, 'reload schema';
commit;
