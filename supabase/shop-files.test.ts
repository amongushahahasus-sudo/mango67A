import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'

const DEVELOPER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const PHOTO = '33333333-3333-4333-8333-333333333333'
const FILE = '44444444-4444-4444-8444-444444444444'
const SECOND_FILE = '55555555-5555-4555-8555-555555555555'
const PAIRS = ['USDJPY', 'EURJPY', 'GBPJPY', 'EURUSD']
type Status = 'not_purchased' | 'pending' | 'approved' | 'rejected'
interface Product {
  id: string; title: string; kind: 'photo' | 'file'; fileType: 'txt' | 'pdf' | 'zip' | null
  previewPath: string | null; price: number; purchased: boolean; paidPrice: number | null
  stockRemaining: number | null; deliveryStatus: Status; orderId: string | null; revision: number
}
interface Order {
  id: string; productId: string; productTitle: string; buyerLabel: string
  paidPrice: number; status: Exclude<Status, 'not_purchased'>; purchasedAt: string; reviewedAt: string | null
}
interface Shop { role: string | null; realizedProfit: number; spentProfit: number; availableProfit: number; photos: Product[]; orders: Order[] }
let db: PGlite
let migration: string

function state(balance = 1_002_000) {
  return { version: 1, account: { balance, positions: [], orders: [], history: [] },
    markets: Object.fromEntries(PAIRS.map(pair => [pair, [{ time: 1700000000000, open: 150, high: 150, low: 150, close: 150 }]])),
    baseline: Object.fromEntries(PAIRS.map(pair => [pair, 150])), pair: 'USDJPY', scenario: 'balanced', timeframe: '1m', speed: 1, paused: true }
}
async function asUser(id: string | null, role: 'authenticated' | 'anon' = 'authenticated') {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id || ''])
  await db.exec(`set role ${role}`)
}
async function snapshot(id: string | null): Promise<Shop> {
  return (await db.query<{ result: Shop }>('select public.get_reward_shop($1::uuid) as result', [id])).rows[0].result
}
async function purchase(productId = FILE, price = 600, user = ALICE): Promise<Shop> {
  return (await db.query<{ result: Shop }>('select public.purchase_shop_product($1::uuid,$2::integer,$3::uuid) as result', [productId, price, user])).rows[0].result
}
async function review(orderId: string, decision: 'approve' | 'reject', user = DEVELOPER): Promise<Shop> {
  return (await db.query<{ result: Shop }>('select public.review_shop_order($1::uuid,$2,$3::uuid) as result', [orderId, decision, user])).rows[0].result
}
async function download(productId = FILE, user = ALICE) {
  return (await db.query<{ result: { bucket: string; originalPath: string; fileName: string } }>('select public.get_shop_product_download($1::uuid,$2::uuid) as result', [productId, user])).rows[0].result
}
async function createProduct({ id = FILE, kind = 'file' as 'file' | 'photo', extension = 'txt' as string | null, price = 600, published = true, revision = null as number | null } = {}): Promise<Shop> {
  return (await db.query<{ result: Shop }>('select public.save_shop_product($1::uuid,$2,$3,$4,$5::integer,$6::boolean,$7,$8,$9,$10::bigint,$11::uuid) as result', [
    id, kind, kind === 'file' ? 'コード付きファイル' : '海辺の写真', 'テスト用の商品説明', price, published,
    revision === null && kind === 'photo' ? `${id}/preview.jpg` : null,
    revision === null ? `${id}/original.${kind === 'photo' ? 'jpg' : extension}` : null,
    kind === 'photo' ? null : extension, revision, DEVELOPER,
  ])).rows[0].result
}
async function publishFile(id = FILE, extension = 'txt') {
  await db.exec('reset role')
  await db.query("insert into storage.objects(bucket_id,name) values ('shop-files',$1)", [`${id}/original.${extension}`])
  await asUser(DEVELOPER)
  return createProduct({ id, extension })
}
async function publishPhoto() {
  await db.exec('reset role')
  await db.query("insert into storage.objects(bucket_id,name) values ('photo-previews',$1),('photo-originals',$2)", [`${PHOTO}/preview.jpg`, `${PHOTO}/original.jpg`])
  await asUser(DEVELOPER)
  return createProduct({ id: PHOTO, kind: 'photo', extension: null })
}
async function saveBalance(balance = 1_002_000, user = ALICE, revision: number | null = null) {
  await asUser(user)
  await db.query('select public.save_practice_account($1::jsonb,$2::bigint,$3::uuid)', [JSON.stringify(state(balance)), revision, user])
}
async function visibleFiles() {
  return (await db.query<{ name: string }>("select name from storage.objects where bucket_id='shop-files' order by name")).rows.map(row => row.name)
}
const item = (shop: Shop, id = FILE) => shop.photos.find(product => product.id === id)!

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb not null default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated;
    grant execute on function auth.uid() to anon,authenticated;
    create schema storage;
    create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,metadata jsonb not null default '{}',unique(bucket_id,name));
    alter table storage.objects enable row level security; alter table storage.objects force row level security;
    alter table storage.buckets enable row level security; alter table storage.buckets force row level security;
    grant usage on schema storage to anon,authenticated;
    grant select,insert,update,delete on storage.objects to anon,authenticated;
    grant select,update,delete on storage.buckets to anon,authenticated;
  `)
  await db.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'))
  await db.exec(await readFile(new URL('./photo-shop.sql', import.meta.url), 'utf8'))
  migration = await readFile(new URL('./shop-files.sql', import.meta.url), 'utf8')
  await db.exec(migration)
}, 60_000)

beforeEach(async () => {
  await db.exec('reset role')
  await db.exec('delete from public.shop_file_orders; delete from public.shop_purchases; delete from public.shop_photos; delete from public.shop_roles; delete from public.practice_accounts; delete from storage.objects;')
  await db.query("insert into auth.users(id,email,email_confirmed_at) values ($1,'owner@example.test',now()),($2,'alice@example.test',now()),($3,'bob@example.test',now()) on conflict(id) do update set email=excluded.email,email_confirmed_at=excluded.email_confirmed_at,raw_user_meta_data='{}'", [DEVELOPER, ALICE, BOB])
  await db.query("insert into public.shop_roles(user_id,role) values ($1,'developer')", [DEVELOPER])
  await db.query("select set_config('request.jwt.claim.sub','',false)")
})
afterAll(async () => { await db?.close() })

describe('private file catalog and manual approval', () => {
  test('public listings contain file type and stock but no file paths, code contents, or buyer identity', async () => {
    await publishFile()
    await asUser(null, 'anon')
    const result = await snapshot(null)
    expect(result.role).toBeNull()
    expect(result.orders).toEqual([])
    expect(item(result)).toMatchObject({ kind: 'file', fileType: 'txt', previewPath: null, stockRemaining: 1, purchased: false, deliveryStatus: 'not_purchased' })
    expect(JSON.stringify(result)).not.toMatch(/original\.txt|alice@example|owner@example|originalPath|bucket/)
    expect(await visibleFiles()).toEqual([])
    await expect(download()).rejects.toThrow(/permission denied/)
    await expect(purchase()).rejects.toThrow(/permission denied/)
  })

  test('a pending request reserves stock and virtual profits but reveals neither the file nor other buyers', async () => {
    await publishFile()
    await saveBalance()
    const bought = await purchase()
    expect(item(bought)).toMatchObject({ deliveryStatus: 'pending', purchased: true, paidPrice: 600, stockRemaining: 0 })
    expect(item(bought).orderId).toMatch(/^[0-9a-f-]{36}$/)
    expect(bought.spentProfit).toBe(600)
    expect(bought.availableProfit).toBe(1400)
    expect(bought.orders).toEqual([])
    expect(await visibleFiles()).toEqual([])
    await expect(download()).rejects.toThrow(/SHOP_.*(PURCHASE|APPROV|PENDING|DELIVERY)/)
    const same = await purchase()
    expect(item(same).orderId).toBe(item(bought).orderId)
    expect(same.spentProfit).toBe(600)
    await asUser(BOB)
    expect((await db.query('select * from public.shop_file_orders')).rows).toEqual([])
    expect(item(await snapshot(BOB))).toMatchObject({ purchased: false, stockRemaining: 0, deliveryStatus: 'not_purchased', orderId: null })
  })

  test('only the database-assigned administrator can approve a file, then its purchaser can download', async () => {
    await publishFile()
    await saveBalance()
    const orderId = item(await purchase()).orderId!
    await expect(review(orderId, 'approve', ALICE)).rejects.toThrow(/ADMIN_REQUIRED/)
    await db.exec('reset role')
    await db.query('update auth.users set raw_user_meta_data=$1::jsonb where id=$2', [JSON.stringify({ role: 'developer', is_admin: true }), ALICE])
    await asUser(ALICE)
    await expect(review(orderId, 'approve', ALICE)).rejects.toThrow(/ADMIN_REQUIRED/)
    await asUser(DEVELOPER)
    const approved = await review(orderId, 'approve')
    expect(approved.orders.find(order => order.id === orderId)).toMatchObject({ status: 'approved', productId: FILE, buyerLabel: 'alice@example.test' })
    await asUser(ALICE)
    expect(item(await snapshot(ALICE))).toMatchObject({ purchased: true, deliveryStatus: 'approved', stockRemaining: 0 })
    expect(await visibleFiles()).toEqual([`${FILE}/original.txt`])
    expect(await download()).toMatchObject({ bucket: 'shop-files', originalPath: `${FILE}/original.txt` })
    await asUser(BOB)
    expect(await visibleFiles()).toEqual([])
    await expect(download(FILE, BOB)).rejects.toThrow(/SHOP_.*(PURCHASE|APPROV|DELIVERY)/)
  })

  test('a rejected request refunds its reservation and permits a new buyer without erasing history', async () => {
    await publishFile()
    await saveBalance()
    const orderId = item(await purchase()).orderId!
    await asUser(DEVELOPER)
    await review(orderId, 'reject')
    await expect(review(orderId, 'approve')).rejects.toThrow(/SHOP_.*(ORDER|REVIEW|STATUS)/)
    await asUser(ALICE)
    const rejected = await snapshot(ALICE)
    expect(rejected.availableProfit).toBe(2000)
    expect(rejected.spentProfit).toBe(0)
    expect(item(rejected)).toMatchObject({ purchased: false, deliveryStatus: 'rejected', stockRemaining: 1, paidPrice: 600 })
    await expect(download()).rejects.toThrow(/SHOP_.*(PURCHASE|APPROV|DELIVERY)/)
    await saveBalance(1_002_000, BOB)
    expect(item(await purchase(FILE, 600, BOB))).toMatchObject({ purchased: true, deliveryStatus: 'pending', stockRemaining: 0 })
    await asUser(DEVELOPER)
    expect((await snapshot(DEVELOPER)).orders).toHaveLength(2)
  })

  test('one code cannot be reserved twice and approved orders cannot be refunded or reassigned', async () => {
    await publishFile()
    await saveBalance()
    const orderId = item(await purchase()).orderId!
    await saveBalance(1_002_000, BOB)
    await expect(purchase(FILE, 600, BOB)).rejects.toThrow(/SHOP_.*(STOCK|SOLD|AVAILABLE)/)
    await asUser(DEVELOPER)
    await review(orderId, 'approve')
    await review(orderId, 'approve')
    await expect(review(orderId, 'reject')).rejects.toThrow(/SHOP_.*(ORDER|REVIEW|STATUS)/)
    await asUser(ALICE)
    expect((await snapshot(ALICE)).spentProfit).toBe(600)
    await asUser(BOB)
    await expect(purchase(FILE, 600, BOB)).rejects.toThrow(/SHOP_.*(STOCK|SOLD|AVAILABLE)/)
  })

  test('deleting a buyer does not put an already delivered code back on sale', async () => {
    await publishFile()
    await saveBalance()
    const orderId = item(await purchase()).orderId!
    await asUser(DEVELOPER)
    await review(orderId, 'approve')
    await db.exec('reset role')
    await db.query('delete from auth.users where id=$1', [ALICE])
    expect((await db.query<{ user_id: string | null; status: string }>('select user_id,status from public.shop_file_orders where id=$1', [orderId])).rows[0]).toEqual({ user_id: null, status: 'approved' })
    await saveBalance(1_002_000, BOB)
    expect(item(await snapshot(BOB)).stockRemaining).toBe(0)
    await expect(purchase(FILE, 600, BOB)).rejects.toThrow(/SHOP_.*(STOCK|SOLD|AVAILABLE)/)
  })

  test('identity checks and RLS prevent direct order changes and revealing other buyers', async () => {
    await publishFile()
    await saveBalance()
    const orderId = item(await purchase()).orderId!
    await expect(snapshot(BOB)).rejects.toThrow('ACCOUNT_USER_CHANGED')
    await expect(purchase(FILE, 600, BOB)).rejects.toThrow('ACCOUNT_USER_CHANGED')
    await expect(download(FILE, BOB)).rejects.toThrow('ACCOUNT_USER_CHANGED')
    await expect(db.query("update public.shop_file_orders set status='approved' where id=$1", [orderId])).rejects.toThrow(/permission denied/)
    await expect(db.query('delete from public.shop_file_orders where id=$1', [orderId])).rejects.toThrow(/permission denied/)
    await asUser(BOB)
    expect((await snapshot(BOB)).orders).toEqual([])
    await asUser(DEVELOPER)
    await expect(review(orderId, 'approve', ALICE)).rejects.toThrow('ACCOUNT_USER_CHANGED')
  })
})

describe('legacy photo compatibility and immutable delivery', () => {
  test('direct purchase cannot reserve lottery-only goods and internal snapshots are not callable by clients', async () => {
    await publishFile()
    await db.exec('reset role')
    await db.query("update public.shop_photos set sale_mode='lottery' where id=$1", [FILE])
    await saveBalance()
    await expect(purchase()).rejects.toThrow('SHOP_LOTTERY_REQUIRED')
    await expect(db.query('select public.shop_reward_snapshot($1::uuid)', [ALICE])).rejects.toThrow(/permission denied/)
    await expect(db.query('select public.shop_reward_wallet($1::uuid)', [ALICE])).rejects.toThrow(/permission denied/)
    expect(item(await snapshot(ALICE))).toMatchObject({ purchased: false, stockRemaining: 1 })
  })

  test('zero-cost file allocation is allowed only for the explicit lottery source and still needs review', async () => {
    await publishFile()
    await db.exec('reset role')
    await expect(db.query("insert into public.shop_file_orders(user_id,photo_id,paid_price,source) values ($1,$2,0,'purchase')", [ALICE, FILE])).rejects.toThrow(/shop_file_payment_source/)
    const order = (await db.query<{ id: string }>("insert into public.shop_file_orders(user_id,photo_id,paid_price,source) values ($1,$2,0,'lottery') returning id", [ALICE, FILE])).rows[0]
    await asUser(ALICE)
    expect(item(await snapshot(ALICE))).toMatchObject({ purchased: true, paidPrice: 0, deliveryStatus: 'pending', stockRemaining: 0 })
    await expect(download()).rejects.toThrow('SHOP_ORDER_PENDING')
    await asUser(DEVELOPER)
    await review(order.id, 'approve')
    await asUser(ALICE)
    expect(await download()).toMatchObject({ bucket: 'shop-files' })
  })

  test('file types, UUID-bound paths and non-null photo previews are enforced independently of the client', async () => {
    await publishFile()
    await expect(createProduct({ kind: 'photo', extension: null, revision: 1 })).rejects.toThrow('SHOP_FILES_IMMUTABLE')
    await db.exec('reset role')
    await db.query("insert into storage.objects(bucket_id,name) values ('shop-files',$1)", [`${SECOND_FILE}/original.html`])
    await asUser(DEVELOPER)
    await expect(createProduct({ id: SECOND_FILE, extension: 'html' })).rejects.toThrow('SHOP_INVALID_PHOTO')
    await expect(db.query('select public.save_shop_product($1::uuid,$2,$3,$4,$5::integer,$6::boolean,$7,$8,$9,$10::bigint,$11::uuid)', [SECOND_FILE, 'file', '別の商品', '', 600, true, null, `${FILE}/original.txt`, 'txt', null, DEVELOPER])).rejects.toThrow('SHOP_INVALID_PHOTO')
    await db.exec('reset role')
    await expect(db.query('insert into public.shop_photos(id,title,price,published,kind,preview_path,original_path) values ($1,$2,600,true,$3,null,$4)', [PHOTO, '不正な写真', 'photo', `${PHOTO}/original.jpg`])).rejects.toThrow(/shop_product_paths/)
  })

  test('restrictive file guards prevent unrelated permissive storage policies from exposing pending codes', async () => {
    await publishFile()
    await saveBalance()
    await purchase()
    await db.exec('reset role')
    await db.exec('create policy test_other_storage_access on storage.objects for all to anon,authenticated using(true) with check(true)')
    await db.exec('create policy test_other_bucket_access on storage.buckets for all to anon,authenticated using(true) with check(true)')
    try {
      await asUser(null, 'anon')
      expect(await visibleFiles()).toEqual([])
      await asUser(BOB)
      expect(await visibleFiles()).toEqual([])
      expect((await db.query("update storage.buckets set public=true where id='shop-files' returning id")).rows).toEqual([])
      expect((await db.query("delete from storage.buckets where id='shop-files' returning id")).rows).toEqual([])
      await expect(db.query("insert into storage.objects(bucket_id,name) values ('shop-files',$1)", [`${SECOND_FILE}/original.txt`])).rejects.toThrow(/row-level security/)
      await asUser(ALICE)
      expect(await visibleFiles()).toEqual([])
    } finally {
      await db.exec('reset role')
      await db.exec('drop policy test_other_storage_access on storage.objects')
      await db.exec('drop policy test_other_bucket_access on storage.buckets')
    }
  })

  test('existing photo purchases remain instant, while legacy RPCs cannot bypass file review', async () => {
    await publishPhoto()
    await publishFile()
    await saveBalance()
    const photoShop = await purchase(PHOTO)
    expect(item(photoShop, PHOTO)).toMatchObject({ kind: 'photo', purchased: true, deliveryStatus: 'approved', stockRemaining: null })
    expect(await download(PHOTO)).toMatchObject({ bucket: 'photo-originals', originalPath: `${PHOTO}/original.jpg` })
    const legacy = (await db.query<{ result: Shop }>('select public.get_photo_shop($1::uuid) as result', [ALICE])).rows[0].result
    expect(legacy.photos.map(photo => photo.id)).toEqual([PHOTO])
    await expect(db.query('select public.purchase_shop_photo($1::uuid,$2::integer,$3::uuid)', [FILE, 600, ALICE])).rejects.toThrow(/SHOP_/)
    await expect(db.query('select public.get_shop_photo_download($1::uuid,$2::uuid)', [FILE, ALICE])).rejects.toThrow(/SHOP_/)
    const pending = await purchase(FILE)
    expect(pending.spentProfit).toBe(1200)
    const legacyAfter = (await db.query<{ result: Shop }>('select public.get_photo_shop($1::uuid) as result', [ALICE])).rows[0].result
    expect(legacyAfter.spentProfit).toBe(1200)
    expect(legacyAfter.availableProfit).toBe(800)
  })

  test('admin metadata changes and archiving never replace or revoke a delivered original', async () => {
    await publishFile()
    await saveBalance()
    const orderId = item(await purchase()).orderId!
    await asUser(DEVELOPER)
    await review(orderId, 'approve')
    await createProduct({ price: 900, published: false, revision: 1 })
    expect((await db.query("update storage.objects set name=$1 where bucket_id='shop-files' and name=$2 returning name", [`${FILE}/original.pdf`, `${FILE}/original.txt`])).rows).toEqual([])
    expect((await db.query("delete from storage.objects where bucket_id='shop-files' and name=$1 returning name", [`${FILE}/original.txt`])).rows).toEqual([])
    await asUser(ALICE)
    const archived = item(await snapshot(ALICE))
    expect(archived).toMatchObject({ deliveryStatus: 'approved', paidPrice: 600, price: 900 })
    expect(await download()).toMatchObject({ bucket: 'shop-files', originalPath: `${FILE}/original.txt` })
    await asUser(null, 'anon')
    expect((await snapshot(null)).photos).toEqual([])
  })

  test('pending reservations count against purchases in other products, and resets do not refund approved goods', async () => {
    await publishFile()
    await publishFile(SECOND_FILE, 'pdf')
    await saveBalance(1_001_000)
    const first = item(await purchase()).orderId!
    await expect(purchase(SECOND_FILE)).rejects.toThrow(/INSUFFICIENT/)
    await asUser(DEVELOPER)
    await review(first, 'approve')
    await saveBalance(1_000_000, ALICE, 1)
    let wallet = await snapshot(ALICE)
    expect(wallet.spentProfit).toBe(600)
    expect(wallet.availableProfit).toBe(0)
    await saveBalance(1_000_900, ALICE, 2)
    wallet = await snapshot(ALICE)
    expect(wallet.availableProfit).toBe(300)
    expect(item(wallet)).toMatchObject({ purchased: true, deliveryStatus: 'approved' })
  })

  test('setup can be reapplied without changing photo entitlements, file reviews, or trading revisions', async () => {
    await publishPhoto()
    await publishFile()
    await saveBalance()
    await purchase(PHOTO)
    const orderId = item(await purchase(FILE)).orderId!
    await asUser(DEVELOPER)
    await review(orderId, 'approve')
    await db.exec('reset role')
    const account = (await db.query('select state,revision from public.practice_accounts where user_id=$1', [ALICE])).rows
    await db.exec(migration)
    expect((await db.query('select state,revision from public.practice_accounts where user_id=$1', [ALICE])).rows).toEqual(account)
    await asUser(ALICE)
    expect(item(await snapshot(ALICE))).toMatchObject({ deliveryStatus: 'approved', orderId })
    expect(await download(PHOTO)).toMatchObject({ bucket: 'photo-originals' })
    expect(await download(FILE)).toMatchObject({ bucket: 'shop-files' })
  })
})
