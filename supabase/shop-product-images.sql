-- MANGO FX: public product images for private code/file products.
-- Run AFTER shop-files.sql and shop-lottery.sql. Existing data is preserved.
begin;

alter table public.shop_photos add column if not exists product_image_path text;
alter table public.shop_photos drop constraint if exists shop_product_image_path;
alter table public.shop_photos add constraint shop_product_image_path check (
  product_image_path is null or (kind = 'file' and product_image_path ~
    ('^' || id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]jpg$'))
);

-- Only a resized promotional JPEG belongs here. The sold file stays private.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('shop-product-images', 'shop-product-images', true, 2097152, array['image/jpeg'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.shop_can_read_product_image(p_name text) returns boolean
language sql stable security definer set search_path = ''
as $$ select public.shop_has_admin_access() or exists (
  select 1 from public.shop_photos p where p.kind = 'file' and p.product_image_path = p_name
    and public.shop_photo_visible(p.id, p.published)
) $$;

create or replace function public.shop_can_upload_product_image(p_name text) returns boolean
language sql stable security definer set search_path = ''
as $$ select public.shop_has_admin_access() and p_name ~
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]jpg$' $$;

create or replace function public.shop_can_delete_product_image(p_name text) returns boolean
language sql stable security definer set search_path = ''
as $$ select public.shop_has_admin_access() and not exists (
  select 1 from public.shop_photos p where p.product_image_path = p_name
) $$;

drop policy if exists mango_product_images_read on storage.objects;
create policy mango_product_images_read on storage.objects for select to anon, authenticated
  using (bucket_id = 'shop-product-images' and public.shop_can_read_product_image(name));
drop policy if exists mango_product_images_insert on storage.objects;
create policy mango_product_images_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'shop-product-images' and public.shop_can_upload_product_image(name));
drop policy if exists mango_product_images_delete on storage.objects;
create policy mango_product_images_delete on storage.objects for delete to authenticated
  using (bucket_id = 'shop-product-images' and public.shop_can_delete_product_image(name));

-- Restrictive guards retain protection even if another permissive policy exists.
drop policy if exists mango_product_images_read_guard on storage.objects;
create policy mango_product_images_read_guard on storage.objects as restrictive for select to anon, authenticated
  using (bucket_id <> 'shop-product-images' or public.shop_can_read_product_image(name));
drop policy if exists mango_product_images_insert_guard on storage.objects;
create policy mango_product_images_insert_guard on storage.objects as restrictive for insert to anon, authenticated
  with check (bucket_id <> 'shop-product-images' or public.shop_can_upload_product_image(name));
drop policy if exists mango_product_images_update_guard on storage.objects;
create policy mango_product_images_update_guard on storage.objects as restrictive for update to anon, authenticated
  using (bucket_id <> 'shop-product-images') with check (bucket_id <> 'shop-product-images');
drop policy if exists mango_product_images_delete_guard on storage.objects;
create policy mango_product_images_delete_guard on storage.objects as restrictive for delete to anon, authenticated
  using (bucket_id <> 'shop-product-images' or public.shop_can_delete_product_image(name));
drop policy if exists mango_product_images_bucket_update_guard on storage.buckets;
create policy mango_product_images_bucket_update_guard on storage.buckets as restrictive for update to anon, authenticated
  using (id <> 'shop-product-images') with check (id <> 'shop-product-images');
drop policy if exists mango_product_images_bucket_delete_guard on storage.buckets;
create policy mango_product_images_bucket_delete_guard on storage.buckets as restrictive for delete to anon, authenticated
  using (id <> 'shop-product-images');

-- Extend the existing catalog without changing its wallet, privacy or lottery rules.
create or replace function public.get_reward_shop(p_expected_user_id uuid default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare result jsonb; products jsonb;
begin
  result := public.shop_reward_snapshot(p_expected_user_id);
  select coalesce(jsonb_agg(item.value || jsonb_build_object(
    'productImagePath', product.product_image_path,
    'lottery', case when lottery.product_id is not null and item.value->>'saleMode' = 'lottery'
      then jsonb_build_object('entryCost', lottery.entry_cost, 'winRateBps', lottery.win_rate_bps,
        'enabled', lottery.enabled, 'revision', lottery.revision)
      else null end) order by item.position), '[]'::jsonb)
    into products from jsonb_array_elements(result->'photos') with ordinality item(value, position)
    join public.shop_photos product on product.id = (item.value->>'id')::uuid
    left join public.shop_lotteries lottery on lottery.product_id = product.id;
  return jsonb_set(result, '{photos}', products)
    || jsonb_build_object('lotteriesReady', true, 'productImagesReady', true);
end;
$$;

-- Metadata and its optional product image commit together. The original save
-- retains administrator checks, revision checks and immutable sold-file paths.
-- A null image path removes the promotional image; it never removes the sold file.
create or replace function public.save_shop_product_with_image(
  p_product_id uuid, p_kind text, p_title text, p_description text, p_price integer, p_published boolean,
  p_preview_path text, p_original_path text, p_file_ext text, p_expected_revision bigint,
  p_expected_user_id uuid, p_product_image_path text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  perform public.save_shop_product(p_product_id, p_kind, p_title, p_description, p_price, p_published,
    p_preview_path, p_original_path, p_file_ext, p_expected_revision, p_expected_user_id);
  if p_product_image_path is not null then
    if p_kind <> 'file' or p_product_image_path !~
      ('^' || p_product_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]jpg$') then
      raise exception using errcode = '22023', message = 'SHOP_INVALID_PRODUCT_IMAGE';
    end if;
    if not exists(select 1 from storage.objects where bucket_id = 'shop-product-images' and name = p_product_image_path) then
      raise exception using errcode = 'P0001', message = 'SHOP_FILES_MISSING';
    end if;
  end if;
  update public.shop_photos set product_image_path = p_product_image_path where id = p_product_id;
  return public.get_reward_shop(p_expected_user_id);
end;
$$;

revoke all on function public.shop_can_read_product_image(text), public.shop_can_upload_product_image(text),
  public.shop_can_delete_product_image(text) from public, anon, authenticated;
grant execute on function public.shop_can_read_product_image(text), public.shop_can_upload_product_image(text),
  public.shop_can_delete_product_image(text) to anon, authenticated;
revoke all on function public.get_reward_shop(uuid),
  public.save_shop_product_with_image(uuid, text, text, text, integer, boolean, text, text, text, bigint, uuid, text)
  from public, anon, authenticated;
grant execute on function public.get_reward_shop(uuid) to anon, authenticated;
grant execute on function public.save_shop_product_with_image(uuid, text, text, text, integer, boolean, text, text, text, bigint, uuid, text)
  to authenticated;

notify pgrst, 'reload schema';
select (public.get_reward_shop(auth.uid())->>'productImagesReady')::boolean as product_images_ready;
commit;
