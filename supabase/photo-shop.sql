-- MANGO FX photo rewards. Run AFTER schema.sql in your Supabase SQL Editor.
-- Idempotent and non-destructive: trading state and previous purchases are preserved.
begin;

create table if not exists public.shop_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('developer', 'admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.shop_photos (
  id uuid primary key,
  title text not null check (char_length(title) between 1 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  price integer not null check (price between 1 and 100000000),
  published boolean not null default false,
  preview_path text not null unique,
  original_path text not null unique,
  revision bigint not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shop_photo_paths check (
    preview_path = id::text || '/preview.jpg'
    and original_path in (id::text || '/original.jpg', id::text || '/original.png', id::text || '/original.webp')
  )
);

create table if not exists public.shop_purchases (
  user_id uuid not null references auth.users(id) on delete cascade,
  photo_id uuid not null references public.shop_photos(id) on delete restrict,
  paid_price integer not null check (paid_price between 1 and 100000000),
  purchased_at timestamptz not null default now(),
  primary key (user_id, photo_id)
);

alter table public.shop_roles enable row level security;
alter table public.shop_roles force row level security;
alter table public.shop_photos enable row level security;
alter table public.shop_photos force row level security;
alter table public.shop_purchases enable row level security;
alter table public.shop_purchases force row level security;

revoke all on public.shop_roles, public.shop_photos, public.shop_purchases from public, anon, authenticated;
grant select on public.shop_roles, public.shop_purchases to authenticated;
-- Original paths are disclosed only by the verified download RPC.
grant select (id, title, description, price, published, preview_path, revision, created_at, updated_at)
  on public.shop_photos to anon, authenticated;

create or replace function public.shop_has_admin_access() returns boolean
language sql stable security definer set search_path = ''
as $$ select auth.uid() is not null and exists (
  select 1 from public.shop_roles where user_id = auth.uid() and role in ('developer', 'admin')
) $$;

create or replace function public.shop_photo_visible(p_photo_id uuid, p_published boolean) returns boolean
language sql stable security definer set search_path = ''
as $$ select p_published or public.shop_has_admin_access() or exists (
  select 1 from public.shop_purchases where user_id = auth.uid() and photo_id = p_photo_id
) $$;

drop policy if exists mango_shop_roles_read on public.shop_roles;
create policy mango_shop_roles_read on public.shop_roles for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists mango_shop_roles_guard on public.shop_roles;
create policy mango_shop_roles_guard on public.shop_roles as restrictive for all to authenticated
  using (user_id = (select auth.uid())) with check (false);
drop policy if exists mango_shop_photos_read on public.shop_photos;
create policy mango_shop_photos_read on public.shop_photos for select to anon, authenticated
  using (public.shop_photo_visible(id, published));
drop policy if exists mango_shop_photos_guard on public.shop_photos;
create policy mango_shop_photos_guard on public.shop_photos as restrictive for all to anon, authenticated
  using (public.shop_photo_visible(id, published)) with check (false);
drop policy if exists mango_shop_purchases_read on public.shop_purchases;
create policy mango_shop_purchases_read on public.shop_purchases for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists mango_shop_purchases_guard on public.shop_purchases;
create policy mango_shop_purchases_guard on public.shop_purchases as restrictive for all to authenticated
  using (user_id = (select auth.uid())) with check (false);

-- A limited public preview and an independently protected full-resolution file.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('photo-previews', 'photo-previews', true, 2097152, array['image/jpeg']),
  ('photo-originals', 'photo-originals', false, 15728640, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = excluded.public,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Photo administration never includes permission to make the originals bucket public.
drop policy if exists mango_shop_bucket_update_guard on storage.buckets;
create policy mango_shop_bucket_update_guard on storage.buckets as restrictive for update to anon, authenticated
  using (id not in ('photo-previews', 'photo-originals'))
  with check (id not in ('photo-previews', 'photo-originals'));
drop policy if exists mango_shop_bucket_delete_guard on storage.buckets;
create policy mango_shop_bucket_delete_guard on storage.buckets as restrictive for delete to anon, authenticated
  using (id not in ('photo-previews', 'photo-originals'));

create or replace function public.shop_can_read_preview(p_name text) returns boolean
language sql stable security definer set search_path = ''
as $$ select public.shop_has_admin_access() or exists (
  select 1 from public.shop_photos p where p.preview_path = p_name
    and public.shop_photo_visible(p.id, p.published)
) $$;

create or replace function public.shop_can_read_original(p_name text) returns boolean
language sql stable security definer set search_path = ''
as $$ select auth.uid() is not null and (public.shop_has_admin_access() or exists (
  select 1 from public.shop_photos p join public.shop_purchases b on b.photo_id = p.id
  where p.original_path = p_name and b.user_id = auth.uid()
)) $$;

create or replace function public.shop_can_upload_object(p_bucket text, p_name text) returns boolean
language sql stable security definer set search_path = ''
as $$ select public.shop_has_admin_access() and (
  (p_bucket = 'photo-previews' and p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/preview[.]jpg$')
  or (p_bucket = 'photo-originals' and p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/original[.](jpg|png|webp)$')
) $$;

create or replace function public.shop_can_delete_object(p_bucket text, p_name text) returns boolean
language sql stable security definer set search_path = ''
as $$ select public.shop_has_admin_access() and p_bucket in ('photo-previews', 'photo-originals')
  and not exists (select 1 from public.shop_photos p
    where (p_bucket = 'photo-previews' and p.preview_path = p_name)
       or (p_bucket = 'photo-originals' and p.original_path = p_name)) $$;

drop policy if exists mango_shop_storage_read on storage.objects;
create policy mango_shop_storage_read on storage.objects for select to anon, authenticated using (
  (bucket_id = 'photo-previews' and public.shop_can_read_preview(name))
  or (bucket_id = 'photo-originals' and public.shop_can_read_original(name))
);
drop policy if exists mango_shop_storage_insert on storage.objects;
create policy mango_shop_storage_insert on storage.objects for insert to authenticated
  with check (public.shop_can_upload_object(bucket_id, name));
drop policy if exists mango_shop_storage_delete on storage.objects;
create policy mango_shop_storage_delete on storage.objects for delete to authenticated
  using (public.shop_can_delete_object(bucket_id, name));

-- Narrow guards also apply if the project has an unrelated permissive storage policy.
-- They leave other application buckets untouched and forbid overwriting photo files.
drop policy if exists mango_shop_storage_read_guard on storage.objects;
create policy mango_shop_storage_read_guard on storage.objects as restrictive for select to anon, authenticated using (
  bucket_id not in ('photo-previews', 'photo-originals')
  or (bucket_id = 'photo-previews' and public.shop_can_read_preview(name))
  or (bucket_id = 'photo-originals' and public.shop_can_read_original(name))
);
drop policy if exists mango_shop_storage_insert_guard on storage.objects;
create policy mango_shop_storage_insert_guard on storage.objects as restrictive for insert to anon, authenticated
  with check (bucket_id not in ('photo-previews', 'photo-originals') or public.shop_can_upload_object(bucket_id, name));
drop policy if exists mango_shop_storage_update_guard on storage.objects;
create policy mango_shop_storage_update_guard on storage.objects as restrictive for update to anon, authenticated
  using (bucket_id not in ('photo-previews', 'photo-originals'))
  with check (bucket_id not in ('photo-previews', 'photo-originals'));
drop policy if exists mango_shop_storage_delete_guard on storage.objects;
create policy mango_shop_storage_delete_guard on storage.objects as restrictive for delete to anon, authenticated
  using (bucket_id not in ('photo-previews', 'photo-originals') or public.shop_can_delete_object(bucket_id, name));

create or replace function public.get_photo_shop(p_expected_user_id uuid default null) returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare
  current_id uuid := auth.uid();
  actor_role text;
  profit bigint := 0;
  spent bigint := 0;
  catalog jsonb;
begin
  if current_id is distinct from p_expected_user_id then
    raise exception using errcode = '42501', message = 'ACCOUNT_USER_CHANGED';
  end if;
  if current_id is not null then
    select r.role into actor_role from public.shop_roles r where r.user_id = current_id;
    -- Practice balances are client-generated simulation data, not verified real money.
    select least(9007199254740991::numeric,
      greatest(0::numeric, floor((a.state->'account'->>'balance')::numeric - 1000000)))::bigint
      into profit from public.practice_accounts a where a.user_id = current_id;
    select coalesce(sum(b.paid_price), 0)::bigint into spent from public.shop_purchases b where b.user_id = current_id;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'title', p.title, 'description', p.description, 'price', p.price,
    'published', p.published, 'previewPath', p.preview_path,
    'purchased', b.user_id is not null, 'paidPrice', b.paid_price,
    'purchasedAt', b.purchased_at, 'revision', p.revision, 'createdAt', p.created_at
  ) order by p.created_at desc, p.id), '[]'::jsonb) into catalog
  from public.shop_photos p left join public.shop_purchases b on b.photo_id = p.id and b.user_id = current_id
  where p.published or actor_role in ('developer', 'admin') or b.user_id is not null;
  return jsonb_build_object('role', actor_role, 'realizedProfit', coalesce(profit, 0),
    'spentProfit', spent, 'availableProfit', greatest(0::bigint, coalesce(profit, 0) - spent), 'photos', catalog);
end;
$function$;

create or replace function public.purchase_shop_photo(
  p_photo_id uuid, p_expected_price integer, p_expected_user_id uuid
) returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  current_id uuid := auth.uid();
  balance numeric;
  spent bigint;
  available bigint;
  photo public.shop_photos%rowtype;
begin
  if current_id is null or current_id is distinct from p_expected_user_id then
    raise exception using errcode = '42501', message = 'ACCOUNT_USER_CHANGED';
  end if;
  if exists (select 1 from public.shop_purchases where user_id = current_id and photo_id = p_photo_id) then
    return public.get_photo_shop(current_id);
  end if;
  -- Same row and lock order as the account saver: parallel purchases and saves serialize.
  select (a.state->'account'->>'balance')::numeric into balance
    from public.practice_accounts a where a.user_id = current_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'SHOP_ACCOUNT_REQUIRED'; end if;
  if exists (select 1 from public.shop_purchases where user_id = current_id and photo_id = p_photo_id) then
    return public.get_photo_shop(current_id);
  end if;
  select * into photo from public.shop_photos p where p.id = p_photo_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'SHOP_PHOTO_NOT_FOUND'; end if;
  if not photo.published then raise exception using errcode = 'P0001', message = 'SHOP_PHOTO_UNAVAILABLE'; end if;
  if p_expected_price is distinct from photo.price then raise exception using errcode = 'P0001', message = 'SHOP_PRICE_CHANGED'; end if;
  select coalesce(sum(b.paid_price), 0)::bigint into spent from public.shop_purchases b where b.user_id = current_id;
  available := greatest(0::bigint, least(9007199254740991::numeric, greatest(0::numeric, floor(balance - 1000000)))::bigint - spent);
  if available < photo.price then raise exception using errcode = 'P0001', message = 'SHOP_INSUFFICIENT_PROFIT'; end if;
  insert into public.shop_purchases(user_id, photo_id, paid_price)
    values (current_id, photo.id, photo.price) on conflict (user_id, photo_id) do nothing;
  return public.get_photo_shop(current_id);
end;
$function$;

create or replace function public.save_shop_photo(
  p_photo_id uuid, p_title text, p_description text, p_price integer, p_published boolean,
  p_preview_path text, p_original_path text, p_expected_revision bigint, p_expected_user_id uuid
) returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  current_id uuid := auth.uid();
  existing public.shop_photos%rowtype;
  preview_path text;
  original_path text;
begin
  if current_id is null or current_id is distinct from p_expected_user_id then
    raise exception using errcode = '42501', message = 'ACCOUNT_USER_CHANGED';
  end if;
  if not public.shop_has_admin_access() then raise exception using errcode = '42501', message = 'SHOP_ADMIN_REQUIRED'; end if;
  if p_photo_id is null or p_title is null or char_length(btrim(p_title)) not between 1 and 120
    or char_length(coalesce(p_description, '')) > 2000 or p_price is null or p_price not between 1 and 100000000
    or p_published is null then raise exception using errcode = '22023', message = 'SHOP_INVALID_PHOTO'; end if;
  if p_expected_revision is null then
    preview_path := p_preview_path; original_path := p_original_path;
    if exists (select 1 from public.shop_photos where id = p_photo_id) then
      raise exception using errcode = 'P0001', message = 'SHOP_PHOTO_CONFLICT';
    end if;
  else
    select * into existing from public.shop_photos where id = p_photo_id for update;
    if not found then raise exception using errcode = 'P0001', message = 'SHOP_PHOTO_NOT_FOUND'; end if;
    if p_expected_revision < 1 or existing.revision <> p_expected_revision then
      raise exception using errcode = 'P0001', message = 'SHOP_PHOTO_CONFLICT';
    end if;
    if (p_preview_path is not null and p_preview_path <> existing.preview_path)
      or (p_original_path is not null and p_original_path <> existing.original_path) then
      raise exception using errcode = '22023', message = 'SHOP_FILES_IMMUTABLE';
    end if;
    preview_path := existing.preview_path; original_path := existing.original_path;
  end if;
  if preview_path is distinct from p_photo_id::text || '/preview.jpg'
    or original_path is null or original_path not in (p_photo_id::text || '/original.jpg', p_photo_id::text || '/original.png', p_photo_id::text || '/original.webp') then
    raise exception using errcode = '22023', message = 'SHOP_INVALID_PHOTO';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'photo-previews' and o.name = preview_path)
    or not exists (select 1 from storage.objects o where o.bucket_id = 'photo-originals' and o.name = original_path) then
    raise exception using errcode = 'P0001', message = 'SHOP_FILES_MISSING';
  end if;
  if p_expected_revision is null then
    insert into public.shop_photos(id, title, description, price, published, preview_path, original_path)
      values (p_photo_id, btrim(p_title), coalesce(p_description, ''), p_price, p_published, preview_path, original_path)
      on conflict (id) do nothing;
    if not found then raise exception using errcode = 'P0001', message = 'SHOP_PHOTO_CONFLICT'; end if;
  else
    update public.shop_photos set title = btrim(p_title), description = coalesce(p_description, ''),
      price = p_price, published = p_published, revision = revision + 1, updated_at = clock_timestamp()
      where id = p_photo_id;
  end if;
  return public.get_photo_shop(current_id);
end;
$function$;

create or replace function public.get_shop_photo_download(p_photo_id uuid, p_expected_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare
  current_id uuid := auth.uid();
  photo public.shop_photos%rowtype;
  clean_title text;
begin
  if current_id is null or current_id is distinct from p_expected_user_id then
    raise exception using errcode = '42501', message = 'ACCOUNT_USER_CHANGED';
  end if;
  select * into photo from public.shop_photos where id = p_photo_id;
  if not found then raise exception using errcode = 'P0001', message = 'SHOP_PHOTO_NOT_FOUND'; end if;
  if not public.shop_has_admin_access() and not exists (
    select 1 from public.shop_purchases where user_id = current_id and photo_id = p_photo_id
  ) then raise exception using errcode = '42501', message = 'SHOP_PURCHASE_REQUIRED'; end if;
  clean_title := left(regexp_replace(photo.title, '[\\/:*?"<>|[:cntrl:]]', '_', 'g'), 80);
  return jsonb_build_object('originalPath', photo.original_path,
    'fileName', coalesce(nullif(btrim(clean_title), ''), 'photo') || '.' || split_part(photo.original_path, '.', 2));
end;
$function$;

revoke all on function public.shop_has_admin_access(), public.shop_photo_visible(uuid, boolean),
  public.shop_can_read_preview(text), public.shop_can_read_original(text),
  public.shop_can_upload_object(text, text), public.shop_can_delete_object(text, text)
  from public, anon, authenticated;
grant execute on function public.shop_has_admin_access(), public.shop_photo_visible(uuid, boolean),
  public.shop_can_read_preview(text), public.shop_can_read_original(text),
  public.shop_can_upload_object(text, text), public.shop_can_delete_object(text, text)
  to anon, authenticated;

revoke all on function public.get_photo_shop(uuid), public.purchase_shop_photo(uuid, integer, uuid),
  public.save_shop_photo(uuid, text, text, integer, boolean, text, text, bigint, uuid),
  public.get_shop_photo_download(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_photo_shop(uuid) to anon, authenticated;
grant execute on function public.purchase_shop_photo(uuid, integer, uuid),
  public.save_shop_photo(uuid, text, text, integer, boolean, text, text, bigint, uuid),
  public.get_shop_photo_download(uuid, uuid) to authenticated;

commit;
