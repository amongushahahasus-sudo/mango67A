import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'

const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ALICE = '11111111-1111-4111-8111-111111111111'
const FILE = '44444444-4444-4444-8444-444444444444'
const PHOTO = '55555555-5555-4555-8555-555555555555'
const IMAGE = '66666666-6666-4666-8666-666666666666'
const NEXT_IMAGE = '77777777-7777-4777-8777-777777777777'
const imagePath = (image = IMAGE, product = FILE) => `${product}/${image}.jpg`
interface Product { id: string; title: string; revision: number; productImagePath: string | null; kind: string; previewPath: string | null; saleMode: string; deliveryStatus: string; orderId: string | null; lottery: { entryCost: number; revision: number } | null }
interface Shop { role: string | null; productImagesReady: boolean; lotteriesReady: boolean; photos: Product[]; orders: unknown[]; availableProfit: number; spentProfit: number }
let db: PGlite
let migration: string
const product = (shop: Shop, id = FILE) => shop.photos.find(item => item.id === id)!

async function asUser(id: string | null, role: 'authenticated' | 'anon' = 'authenticated') {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? ''])
  await db.exec(`set role ${role}`)
}
async function snapshot(user: string | null = ADMIN) {
  return (await db.query<{ result: Shop }>('select public.get_reward_shop($1::uuid) as result', [user])).rows[0].result
}
async function seedObjects({ photo = false, image = IMAGE, file = true } = {}) {
  await db.exec('reset role')
  if (file) await db.query("insert into storage.objects(bucket_id,name) values ('shop-files',$1) on conflict do nothing", [`${FILE}/original.txt`])
  if (photo) await db.query("insert into storage.objects(bucket_id,name) values ('photo-previews',$1),('photo-originals',$2) on conflict do nothing", [`${PHOTO}/preview.jpg`, `${PHOTO}/original.jpg`])
  if (image) await db.query("insert into storage.objects(bucket_id,name) values ('shop-product-images',$1) on conflict do nothing", [imagePath(image)])
  await asUser(ADMIN)
}
async function save({ image = null as string | null, revision = null as number | null, user = ADMIN,
  id = FILE, kind = 'file', title = 'ギフト用の商品', published = true, price = 600 } = {}) {
  return (await db.query<{ result: Shop }>(`select public.save_shop_product_with_image(
    $1::uuid,$2,$3,'商品説明',$11::integer,$4::boolean,$5,$6,$7,$8::bigint,$9::uuid,$10) as result`, [
    id, kind, title, published, revision === null && kind === 'photo' ? `${id}/preview.jpg` : null,
    revision === null ? `${id}/original.${kind === 'photo' ? 'jpg' : 'txt'}` : null,
    kind === 'photo' ? null : 'txt', revision, user, image, price,
  ])).rows[0].result
}
async function oldSave(revision: number, title = '従来APIによる編集') {
  return (await db.query<{ result: Shop }>(`select public.save_shop_product(
    $1::uuid,'file',$2,'商品説明',600,true,null,null,null,$3::bigint,$4::uuid) as result`, [FILE, title, revision, ADMIN])).rows[0].result
}
async function stored() {
  await db.exec('reset role')
  return (await db.query<{ title: string; revision: number; product_image_path: string | null; original_path: string }>('select title,revision,product_image_path,original_path from public.shop_photos where id=$1', [FILE])).rows[0]
}
async function saveBalance() {
  const pairs = ['USDJPY','EURJPY','GBPJPY','EURUSD']
  const state = { version: 1, account: { balance: 1002000, positions: [], orders: [], history: [] },
    markets: Object.fromEntries(pairs.map(pair => [pair,[{ time: 1700000000000, open: 150, high: 150, low: 150, close: 150 }]])),
    baseline: Object.fromEntries(pairs.map(pair => [pair,150])), pair: 'USDJPY', scenario: 'balanced', timeframe: '1m', speed: 1, paused: true }
  await asUser(ALICE)
  await db.query('select public.save_practice_account($1::jsonb,null,$2::uuid)', [JSON.stringify(state),ALICE])
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb not null default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;
    create schema storage;
    create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,metadata jsonb not null default '{}',unique(bucket_id,name));
    alter table storage.objects enable row level security; alter table storage.objects force row level security;
    alter table storage.buckets enable row level security; alter table storage.buckets force row level security;
    grant usage on schema storage to anon,authenticated;
    grant select,insert,update,delete on storage.objects to anon,authenticated;
    grant select,update,delete on storage.buckets to anon,authenticated;
  `)
  for (const name of ['schema.sql','photo-shop.sql','shop-files.sql','shop-lottery.sql']) await db.exec(await readFile(new URL(`./${name}`, import.meta.url),'utf8'))
  migration = await readFile(new URL('./shop-product-images.sql', import.meta.url),'utf8')
  await db.exec(migration)
}, 60_000)
beforeEach(async () => {
  await db.exec('reset role')
  await db.exec('delete from public.shop_lottery_entries; delete from public.shop_lotteries; delete from public.shop_file_orders; delete from public.shop_purchases; delete from public.shop_photos; delete from public.shop_roles; delete from public.practice_accounts; delete from storage.objects;')
  await db.query("insert into auth.users(id,email,email_confirmed_at) values ($1,'owner@example.test',now()),($2,'alice@example.test',now()) on conflict(id) do update set raw_user_meta_data='{}'", [ADMIN,ALICE])
  await db.query("insert into public.shop_roles(user_id,role) values ($1,'developer')", [ADMIN])
  await asUser(null,'anon')
})
afterAll(async () => { await db?.close() })

describe('public product images and private sold files', () => {
  test('new file products may have an image, while the public catalog still omits code file paths', async () => {
    await seedObjects()
    const saved = await save({ image: imagePath() })
    expect(saved).toMatchObject({ productImagesReady: true, lotteriesReady: true })
    expect(product(saved)).toMatchObject({ revision: 1, productImagePath: imagePath(), previewPath: null })
    await asUser(null,'anon')
    const catalog = await snapshot(null)
    expect(product(catalog).productImagePath).toBe(imagePath())
    expect(catalog.orders).toEqual([])
    expect(JSON.stringify(catalog)).not.toMatch(/original[.]txt|owner@example|alice@example|originalPath/)
    expect((await db.query("select name from storage.objects where bucket_id='shop-product-images'")).rows).toEqual([{ name:imagePath() }])
    expect((await db.query("select name from storage.objects where bucket_id='shop-files'")).rows).toEqual([])
  })

  test('existing file products can add, replace and remove an image without changing their sold file', async () => {
    await seedObjects(); await save()
    expect(product(await save({ image:imagePath(),revision:1 })).revision).toBe(2)
    await seedObjects({ image:NEXT_IMAGE })
    expect(product(await save({ image:imagePath(NEXT_IMAGE),revision:2 })).productImagePath).toBe(imagePath(NEXT_IMAGE))
    const removed = await save({ revision:3 })
    expect(product(removed)).toMatchObject({ revision:4,productImagePath:null })
    expect(await stored()).toMatchObject({ revision:4,original_path:`${FILE}/original.txt`,product_image_path:null })
  })

  test('legacy file metadata edits retain the optional image and existing image-less products stay valid', async () => {
    await seedObjects(); await save({ image:imagePath() })
    expect(product(await oldSave(1))).toMatchObject({ productImagePath:imagePath(),revision:2 })
    await save({ revision:2 })
    expect(product(await oldSave(3))).toMatchObject({ productImagePath:null,revision:4 })
  })

  test('only the configured administrator can attach images, even with a made-up profile role', async () => {
    await seedObjects(); await save()
    await asUser(ALICE)
    await expect(save({ image:imagePath(),revision:1,user:ALICE })).rejects.toThrow('SHOP_ADMIN_REQUIRED')
    await expect(save({ image:imagePath(),revision:1,user:ADMIN })).rejects.toThrow('ACCOUNT_USER_CHANGED')
    await db.exec('reset role')
    await db.query('update auth.users set raw_user_meta_data=$1::jsonb where id=$2', [JSON.stringify({ role:'developer',is_admin:true }),ALICE])
    await asUser(ALICE)
    await expect(save({ image:imagePath(),revision:1,user:ALICE })).rejects.toThrow('SHOP_ADMIN_REQUIRED')
    await expect(db.query("update public.shop_photos set product_image_path=$1 where id=$2", [imagePath(),FILE])).rejects.toThrow(/permission denied/)
    await asUser(null,'anon')
    await expect(save({ image:imagePath() })).rejects.toThrow(/permission denied/)
    expect(await stored()).toMatchObject({ revision:1,product_image_path:null })
  })

  test('invalid or missing image paths roll back both new and edited product metadata', async () => {
    await seedObjects(); await save()
    for (const image of [imagePath(IMAGE,PHOTO), `${FILE}/../secret.jpg`, `${FILE}/original.txt`, `https://example.test/${imagePath()}`, imagePath(NEXT_IMAGE)]) {
      await expect(save({ image,revision:1,title:'反映してはいけない変更' })).rejects.toThrow(/SHOP_(INVALID_PRODUCT_IMAGE|FILES_MISSING)/)
      expect(await stored()).toMatchObject({ revision:1,title:'ギフト用の商品',product_image_path:null })
      await asUser(ADMIN)
    }
    await db.exec('reset role'); await db.query('delete from public.shop_photos where id=$1',[FILE]); await asUser(ADMIN)
    await expect(save({ image:imagePath(NEXT_IMAGE) })).rejects.toThrow('SHOP_FILES_MISSING')
    expect(await stored()).toBeUndefined()
  })

  test('stale edits cannot replace the image and image changes increment the product revision only once', async () => {
    await seedObjects(); await save({ image:imagePath() })
    await seedObjects({ image:NEXT_IMAGE })
    const updated = await save({ image:imagePath(NEXT_IMAGE),revision:1 })
    expect(product(updated).revision).toBe(2)
    await expect(save({ image:null,revision:1 })).rejects.toThrow('SHOP_PHOTO_CONFLICT')
    expect(await stored()).toMatchObject({ revision:2,product_image_path:imagePath(NEXT_IMAGE) })
  })

  test('photo products keep their original preview and cannot receive a file-product image', async () => {
    await seedObjects({ photo:true })
    await expect(save({ id:PHOTO,kind:'photo',image:imagePath() })).rejects.toThrow('SHOP_INVALID_PRODUCT_IMAGE')
    const photos = await save({ id:PHOTO,kind:'photo' })
    expect(product(photos,PHOTO)).toMatchObject({ kind:'photo',productImagePath:null,previewPath:`${PHOTO}/preview.jpg`,revision:1 })
  })

  test('pending buyers can see promotional images but cannot download the private code file before approval', async () => {
    await seedObjects(); await save({ image:imagePath() }); await saveBalance()
    const bought = (await db.query<{ result:Shop }>('select public.purchase_shop_product($1,600,$2) as result',[FILE,ALICE])).rows[0].result
    expect(product(bought)).toMatchObject({ productImagePath:imagePath(),deliveryStatus:'pending' })
    await expect(db.query('select public.get_shop_product_download($1,$2)',[FILE,ALICE])).rejects.toThrow('SHOP_ORDER_PENDING')
    expect((await db.query("select name from storage.objects where bucket_id='shop-files'")).rows).toEqual([])
    await asUser(ADMIN)
    await db.query("select public.review_shop_order($1,'approve',$2)",[product(bought).orderId,ADMIN])
    await asUser(ALICE)
    expect((await db.query("select name from storage.objects where bucket_id='shop-files'")).rows).toEqual([{ name:`${FILE}/original.txt` }])
  })

  test('lottery settings, wallet accounting and image updates coexist without altering the entry fee', async () => {
    await seedObjects(); await save({ image:imagePath() })
    await db.query('select public.configure_shop_lottery($1,100,10000,true,null,$2)',[FILE,ADMIN])
    const withImage = await save({ image:imagePath(),revision:2,price:100 })
    expect(product(withImage)).toMatchObject({ saleMode:'lottery',productImagePath:imagePath(),lottery:{ entryCost:100,revision:1 } })
    await saveBalance()
    const draw = (await db.query<{ result:{ shop:Shop } }>('select public.draw_shop_lottery($1,1,$2,$3) as result',[FILE,IMAGE,ALICE])).rows[0].result
    expect(draw.shop).toMatchObject({ spentProfit:100,availableProfit:1900,productImagesReady:true,lotteriesReady:true })
    expect(product(draw.shop)).toMatchObject({ productImagePath:imagePath(),deliveryStatus:'pending' })
  })

  test('restrictive storage guards allow only administrator inserts and orphan deletion, with no overwrite', async () => {
    await db.exec('reset role')
    await db.exec('create policy image_test_permissive_objects on storage.objects for all to anon,authenticated using(true) with check(true); create policy image_test_permissive_buckets on storage.buckets for all to anon,authenticated using(true) with check(true);')
    try {
      await seedObjects(); await save({ image:imagePath() })
      await db.query("insert into storage.objects(bucket_id,name) values('shop-product-images',$1)",[imagePath(NEXT_IMAGE)])
      await expect(db.query("insert into storage.objects(bucket_id,name) values('shop-product-images',$1)",[`${FILE}/invalid.txt`])).rejects.toThrow(/row-level security/)
      expect((await db.query("update storage.objects set metadata='{}' where bucket_id='shop-product-images' returning name")).rows).toEqual([])
      expect((await db.query("delete from storage.objects where bucket_id='shop-product-images' and name=$1 returning name",[imagePath()])).rows).toEqual([])
      expect((await db.query("delete from storage.objects where bucket_id='shop-product-images' and name=$1 returning name",[imagePath(NEXT_IMAGE)])).rows).toEqual([{ name:imagePath(NEXT_IMAGE) }])
      expect((await db.query("update storage.buckets set public=false where id='shop-product-images' returning id")).rows).toEqual([])
      expect((await db.query("delete from storage.buckets where id='shop-product-images' returning id")).rows).toEqual([])
      await asUser(ALICE)
      await expect(db.query("insert into storage.objects(bucket_id,name) values('shop-product-images',$1)",[imagePath(NEXT_IMAGE)])).rejects.toThrow(/row-level security/)
      expect((await db.query("delete from storage.objects where bucket_id='shop-product-images' returning name")).rows).toEqual([])
      await asUser(null,'anon')
      await expect(db.query("insert into storage.objects(bucket_id,name) values('shop-product-images',$1)",[imagePath(NEXT_IMAGE)])).rejects.toThrow(/row-level security/)
    } finally {
      await db.exec('reset role')
      await db.exec('drop policy image_test_permissive_objects on storage.objects; drop policy image_test_permissive_buckets on storage.buckets;')
    }
  })

  test('reapplying the migration retains images, purchases and roles and restores the public JPEG bucket settings', async () => {
    await seedObjects(); await save({ image:imagePath() }); await saveBalance()
    await db.query('select public.purchase_shop_product($1,600,$2)',[FILE,ALICE])
    await db.exec('reset role')
    await db.exec("update storage.buckets set public=false,allowed_mime_types=array['text/plain'],file_size_limit=20 where id='shop-product-images'")
    await db.exec(migration); await db.exec(migration)
    expect((await db.query("select public,allowed_mime_types,file_size_limit from storage.buckets where id='shop-product-images'")).rows[0]).toMatchObject({ public:true,allowed_mime_types:['image/jpeg'],file_size_limit:2097152 })
    await asUser(ADMIN)
    expect((await snapshot()).role).toBe('developer')
    await asUser(ALICE)
    expect(product(await snapshot(ALICE))).toMatchObject({ productImagePath:imagePath(),deliveryStatus:'pending' })
    expect((await db.query('select * from public.shop_file_orders')).rows).toHaveLength(1)
  })
})
