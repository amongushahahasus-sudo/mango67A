import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'

const DEVELOPER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const PHOTO = '33333333-3333-4333-8333-333333333333'
const FILE = '44444444-4444-4444-8444-444444444444'
const OTHER = '55555555-5555-4555-8555-555555555555'
const REQUEST = '66666666-6666-4666-8666-666666666666'
const NEXT_REQUEST = '77777777-7777-4777-8777-777777777777'
type Entry = { id: string; requestId: string; productId: string; outcome: 'win' | 'lose'; cost: number; createdAt: string; refunded: boolean; orderId: string | null }
type Product = { id: string; price: number; revision: number; saleMode: 'direct' | 'lottery'; stockRemaining: number | null; purchased: boolean; paidPrice: number | null; deliveryStatus: string; orderId: string | null; orderSource: string | null; lottery: { entryCost: number; winRateBps: number; enabled: boolean; revision: number } | null }
type Shop = { role: string | null; realizedProfit: number; spentProfit: number; availableProfit: number; lotteriesReady: boolean; photos: Product[]; orders: { id: string; source: string; status: string; paidPrice: number }[] }
let db: PGlite
let migration: string
let productionRoll: string

const item = (shop: Shop, id = FILE) => shop.photos.find(product => product.id === id)!
async function asUser(id: string | null, role: 'authenticated' | 'anon' = 'authenticated') {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id || ''])
  await db.exec(`set role ${role}`)
}
async function saveBalance(balance = 1_002_000, user = ALICE) {
  await asUser(user)
  const pairs = ['USDJPY', 'EURJPY', 'GBPJPY', 'EURUSD']
  const state = { version: 1, account: { balance, positions: [], orders: [], history: [] },
    markets: Object.fromEntries(pairs.map(pair => [pair, [{ time: 1700000000000, open: 150, high: 150, low: 150, close: 150 }]])),
    baseline: Object.fromEntries(pairs.map(pair => [pair, 150])), pair: 'USDJPY', scenario: 'balanced', timeframe: '1m', speed: 1, paused: true }
  await db.query('select public.save_practice_account($1::jsonb,null,$2::uuid)', [JSON.stringify(state), user])
}
async function publish(id = FILE, kind: 'file' | 'photo' = 'file', price = 600) {
  await db.exec('reset role')
  if (kind === 'file') await db.query("insert into storage.objects(bucket_id,name) values ('shop-files',$1)", [`${id}/original.txt`])
  else await db.query("insert into storage.objects(bucket_id,name) values ('photo-previews',$1),('photo-originals',$2)", [`${id}/preview.jpg`, `${id}/original.jpg`])
  await asUser(DEVELOPER)
  return (await db.query<{ result: Shop }>('select public.save_shop_product($1::uuid,$2,$3,$4,$5::integer,true,$6,$7,$8,null,$9::uuid) as result', [id, kind, 'テスト用のごほうび', '', price, kind === 'photo' ? `${id}/preview.jpg` : null, `${id}/original.${kind === 'file' ? 'txt' : 'jpg'}`, kind === 'file' ? 'txt' : null, DEVELOPER])).rows[0].result
}
async function configure({ product = FILE, cost = 100, odds = 10000, enabled = true, revision = null as number | null, user = DEVELOPER } = {}) {
  return (await db.query<{ result: Shop }>('select public.configure_shop_lottery($1::uuid,$2::integer,$3::integer,$4::boolean,$5::bigint,$6::uuid) as result', [product, cost, odds, enabled, revision, user])).rows[0].result
}
async function snapshot(user: string | null = ALICE) {
  return (await db.query<{ result: Shop }>('select public.get_reward_shop($1::uuid) as result', [user])).rows[0].result
}
async function draw({ product = FILE, revision = 1, request = REQUEST, user = ALICE } = {}) {
  return (await db.query<{ result: { shop: Shop; entry: Entry } }>('select public.draw_shop_lottery($1::uuid,$2::bigint,$3::uuid,$4::uuid) as result', [product, revision, request, user])).rows[0].result
}
async function loadEntry(product = FILE, request = REQUEST, user = ALICE) {
  return (await db.query<{ result: Entry | null }>('select public.get_shop_lottery_entry($1::uuid,$2::uuid,$3::uuid) as result', [product, request, user])).rows[0].result
}
async function review(order: string, decision: 'approve' | 'reject') {
  return (await db.query<{ result: Shop }>('select public.review_shop_order($1::uuid,$2,$3::uuid) as result', [order, decision, DEVELOPER])).rows[0].result
}
async function download(user = ALICE) {
  return (await db.query<{ result: { bucket: string; originalPath: string } }>('select public.get_shop_product_download($1::uuid,$2::uuid) as result', [FILE, user])).rows[0].result
}
// Deterministic outcomes exist only inside this isolated test database. The
// production migration exposes no random seed, outcome or test override RPC.
async function forceRoll(value: number) {
  await db.exec('reset role')
  await db.exec(`create or replace function public.shop_lottery_roll() returns integer language sql volatile security definer set search_path='' as $$select ${value}::integer$$`)
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
  for (const file of ['schema.sql', 'photo-shop.sql', 'shop-files.sql']) await db.exec(await readFile(new URL(`./${file}`, import.meta.url), 'utf8'))
  migration = await readFile(new URL('./shop-lottery.sql', import.meta.url), 'utf8')
  productionRoll = migration.match(/create or replace function public\.shop_lottery_roll\(\)[\s\S]*?\$\$;/)![0]
  await db.exec(migration)
}, 60_000)
beforeEach(async () => {
  await db.exec('reset role')
  await db.exec('delete from public.shop_lottery_entries; delete from public.shop_lotteries; delete from public.shop_file_orders; delete from public.shop_purchases; delete from public.shop_photos; delete from public.shop_roles; delete from public.practice_accounts; delete from storage.objects;')
  await db.query("insert into auth.users(id,email,email_confirmed_at) values ($1,'owner@example.test',now()),($2,'alice@example.test',now()),($3,'bob@example.test',now()) on conflict(id) do update set email=excluded.email,email_confirmed_at=excluded.email_confirmed_at,raw_user_meta_data='{}'", [DEVELOPER, ALICE, BOB])
  await db.query("insert into public.shop_roles(user_id,role) values ($1,'developer')", [DEVELOPER])
  await forceRoll(0)
})
afterAll(async () => { await db?.close() })

describe('paid virtual-profit draws', () => {
  test('a win spends one entry fee and reserves a private file pending administrator approval', async () => {
    await publish(); await configure(); await saveBalance()
    const won = await draw()
    expect(won.entry).toMatchObject({ requestId: REQUEST, productId: FILE, outcome: 'win', cost: 100, refunded: false })
    expect(won.entry.orderId).toMatch(/^[0-9a-f-]{36}$/)
    expect(won.shop).toMatchObject({ lotteriesReady: true, realizedProfit: 2000, spentProfit: 100, availableProfit: 1900 })
    expect(item(won.shop)).toMatchObject({ purchased: true, paidPrice: 0, orderSource: 'lottery', deliveryStatus: 'pending', stockRemaining: 0 })
    expect((await db.query("select name from storage.objects where bucket_id='shop-files'")).rows).toEqual([])
    await expect(download()).rejects.toThrow('SHOP_ORDER_PENDING')
    const repeated = await draw()
    expect(repeated.entry).toEqual(won.entry)
    expect(repeated.shop.spentProfit).toBe(100)
    expect(await loadEntry()).toEqual(won.entry)
    await db.exec('reset role')
    expect((await db.query<{ revision: number }>('select revision from public.practice_accounts where user_id=$1', [ALICE])).rows[0].revision).toBe(1)
    expect((await db.query('select * from public.shop_lottery_entries')).rows).toHaveLength(1)
    expect((await db.query('select * from public.shop_file_orders')).rows).toHaveLength(1)
  })

  test('a loss spends its fee, creates no order, and retries keep the historical result after configuration changes', async () => {
    await publish(); await configure({ odds: 1 }); await forceRoll(9999); await saveBalance()
    const lost = await draw()
    expect(lost.entry).toMatchObject({ outcome: 'lose', cost: 100, orderId: null, refunded: false })
    expect(lost.shop).toMatchObject({ spentProfit: 100, availableProfit: 1900 })
    expect(item(lost.shop)).toMatchObject({ stockRemaining: 1, purchased: false })
    await asUser(DEVELOPER); await configure({ cost: 300, odds: 10000, enabled: false, revision: 1 })
    await asUser(ALICE)
    expect((await draw({ revision: 999 })).entry).toEqual(lost.entry)
    expect((await snapshot()).spentProfit).toBe(100)
    await expect(draw({ product: OTHER })).rejects.toThrow('SHOP_LOTTERY_REQUEST_CONFLICT')
    await expect(draw({ request: NEXT_REQUEST, revision: 2 })).rejects.toThrow('SHOP_LOTTERY_UNAVAILABLE')
  })

  test('insufficient funds, disabled/unpublished products and stale confirmations never charge or reserve', async () => {
    await publish(); await configure({ enabled: false }); await saveBalance(1_000_099)
    await expect(draw()).rejects.toThrow('SHOP_LOTTERY_UNAVAILABLE')
    await asUser(DEVELOPER); await configure({ revision: 1 }); await asUser(ALICE)
    await expect(draw()).rejects.toThrow('SHOP_LOTTERY_CHANGED')
    await expect(draw({ revision: 2 })).rejects.toThrow('SHOP_INSUFFICIENT_PROFIT')
    await db.exec('reset role'); await db.query('update public.shop_photos set published=false where id=$1', [FILE]); await asUser(ALICE)
    await expect(draw({ revision: 2 })).rejects.toThrow('SHOP_LOTTERY_UNAVAILABLE')
    expect((await snapshot()).spentProfit).toBe(0)
    expect((await db.query('select * from public.shop_lottery_entries')).rows).toEqual([])
  })

  test('only the winning fee is refunded after rejection; earlier losses remain spent and the prize can be drawn again', async () => {
    await publish(); await configure({ odds: 5000 }); await forceRoll(9999); await saveBalance()
    const lost = await draw()
    await forceRoll(0); await asUser(ALICE)
    const won = await draw({ request: NEXT_REQUEST })
    expect(won.shop.spentProfit).toBe(200)
    await asUser(DEVELOPER); await review(won.entry.orderId!, 'reject'); await review(won.entry.orderId!, 'reject')
    await expect(review(won.entry.orderId!, 'approve')).rejects.toThrow('SHOP_ORDER_CONFLICT')
    await asUser(ALICE)
    expect(await snapshot()).toMatchObject({ spentProfit: 100, availableProfit: 1900 })
    expect(item(await snapshot())).toMatchObject({ stockRemaining: 1, purchased: false, deliveryStatus: 'rejected' })
    expect(await loadEntry()).toEqual(lost.entry)
    expect(await loadEntry(FILE, NEXT_REQUEST)).toMatchObject({ outcome: 'win', refunded: true, cost: 100 })
    expect((await draw({ request: NEXT_REQUEST })).entry.refunded).toBe(true)
    expect((await snapshot()).spentProfit).toBe(100)
    await saveBalance(1_002_000, BOB)
    expect((await draw({ user: BOB })).entry.outcome).toBe('win')
  })

  test('a winner blocks other draws, private delivery needs approval, and an approved prize can never be refunded', async () => {
    await publish(); await configure(); await saveBalance()
    const won = await draw()
    await saveBalance(1_002_000, BOB)
    await expect(draw({ user: BOB })).rejects.toThrow('SHOP_OUT_OF_STOCK')
    expect((await snapshot(BOB)).spentProfit).toBe(0)
    await asUser(DEVELOPER)
    const approved = await review(won.entry.orderId!, 'approve')
    expect(approved.orders.find(order => order.id === won.entry.orderId)).toMatchObject({ source: 'lottery', paidPrice: 0, status: 'approved' })
    await expect(review(won.entry.orderId!, 'reject')).rejects.toThrow('SHOP_ORDER_CONFLICT')
    await asUser(ALICE)
    expect(await download()).toMatchObject({ bucket: 'shop-files', originalPath: `${FILE}/original.txt` })
    expect((await db.query("select name from storage.objects where bucket_id='shop-files'")).rows).toEqual([{ name: `${FILE}/original.txt` }])
    expect((await snapshot()).spentProfit).toBe(100)
    await asUser(BOB)
    await expect(download(BOB)).rejects.toThrow('SHOP_PURCHASE_REQUIRED')
    expect((await db.query("select name from storage.objects where bucket_id='shop-files'")).rows).toEqual([])
  })

  test('deleting a winning buyer retains the allocation and draw audit without reselling a delivered code', async () => {
    await publish(); await configure(); await saveBalance()
    const won = await draw()
    await asUser(DEVELOPER); await review(won.entry.orderId!, 'approve')
    await db.exec('reset role'); await db.query('delete from auth.users where id=$1', [ALICE])
    expect((await db.query<{ user_id: string | null }>('select user_id from public.shop_lottery_entries where id=$1', [won.entry.id])).rows[0].user_id).toBeNull()
    expect((await db.query<{ user_id: string | null }>('select user_id from public.shop_file_orders where id=$1', [won.entry.orderId])).rows[0].user_id).toBeNull()
    await saveBalance(1_002_000, BOB)
    expect(item(await snapshot(BOB)).stockRemaining).toBe(0)
    await expect(draw({ user: BOB })).rejects.toThrow('SHOP_OUT_OF_STOCK')
  })
})

describe('lottery configuration, authorization and compatibility', () => {
  test('public listings expose odds and price but never ledger owners, private paths or codes', async () => {
    await publish(); await configure({ odds: 250 }); await saveBalance(); await draw()
    await asUser(null, 'anon')
    const shop = await snapshot(null)
    expect(shop.lotteriesReady).toBe(true)
    expect(item(shop).lottery).toEqual({ entryCost: 100, winRateBps: 250, enabled: true, revision: 1 })
    expect(shop.orders).toEqual([])
    expect(JSON.stringify(shop)).not.toMatch(/original\.txt|alice@example|requestId|originalPath|refunded|bucket/)
    await expect(db.query('select * from public.shop_lottery_entries')).rejects.toThrow(/permission denied/)
    await expect(draw()).rejects.toThrow(/permission denied/)
    await asUser(BOB)
    expect((await db.query('select * from public.shop_lottery_entries')).rows).toEqual([])
    expect(await loadEntry(FILE, REQUEST, BOB)).toBeNull()
  })

  test('identity checks and database roles prevent forged configuration, direct ledger edits and random control', async () => {
    await publish(); await configure(); await saveBalance()
    await expect(draw({ user: BOB })).rejects.toThrow('ACCOUNT_USER_CHANGED')
    await expect(loadEntry(FILE, REQUEST, BOB)).rejects.toThrow('ACCOUNT_USER_CHANGED')
    await expect(configure({ revision: 1, user: ALICE })).rejects.toThrow('SHOP_ADMIN_REQUIRED')
    await db.exec('reset role')
    await db.query('update auth.users set raw_user_meta_data=$1::jsonb where id=$2', [JSON.stringify({ role: 'developer', is_admin: true }), ALICE])
    await asUser(ALICE)
    await expect(configure({ revision: 1, user: ALICE })).rejects.toThrow('SHOP_ADMIN_REQUIRED')
    await expect(db.query('select public.shop_lottery_roll()')).rejects.toThrow(/permission denied/)
    await expect(db.query('select public.shop_reward_wallet($1::uuid)', [ALICE])).rejects.toThrow(/permission denied/)
    await expect(db.query('select * from public.shop_lotteries')).rejects.toThrow(/permission denied/)
    await expect(db.query("insert into public.shop_lottery_entries(user_id,request_id,product_id,outcome,cost) values ($1,$2,$3,'lose',1)", [ALICE, REQUEST, FILE])).rejects.toThrow(/permission denied/)
    const won = await draw()
    await expect(db.query('update public.shop_lottery_entries set refunded_at=now() where id=$1', [won.entry.id])).rejects.toThrow(/permission denied/)
    await expect(db.query('delete from public.shop_lottery_entries where id=$1', [won.entry.id])).rejects.toThrow(/permission denied/)
  })

  test('admin configuration validates paid costs and odds, uses revision CAS and synchronizes displayed prices', async () => {
    await publish(); await publish(PHOTO, 'photo')
    await expect(configure({ product: PHOTO })).rejects.toThrow('SHOP_LOTTERY_NOT_FOUND')
    await expect(configure({ cost: 0 })).rejects.toThrow('SHOP_INVALID_LOTTERY')
    await expect(configure({ odds: 0 })).rejects.toThrow('SHOP_INVALID_LOTTERY')
    await expect(configure({ odds: 10001 })).rejects.toThrow('SHOP_INVALID_LOTTERY')
    await expect(configure({ revision: 1 })).rejects.toThrow('SHOP_LOTTERY_CONFLICT')
    const first = await configure({ odds: 2500 })
    expect(item(first)).toMatchObject({ price: 100, saleMode: 'lottery', lottery: { entryCost: 100, winRateBps: 2500, revision: 1 } })
    await expect(configure()).rejects.toThrow('SHOP_LOTTERY_CONFLICT')
    const second = await configure({ cost: 200, revision: 1 })
    expect(item(second).lottery?.revision).toBe(2)
    await expect(configure({ revision: 1 })).rejects.toThrow('SHOP_LOTTERY_CONFLICT')
    await db.query('select public.save_shop_product($1::uuid,$2,$3,$4,350,true,null,null,$5,$6::bigint,$7::uuid)', [FILE, 'file', '価格改定', '', 'txt', item(second).revision, DEVELOPER])
    expect(item(await snapshot(DEVELOPER))).toMatchObject({ price: 350, lottery: { entryCost: 350, revision: 3 } })
    await saveBalance()
    await expect(draw({ revision: 2 })).rejects.toThrow('SHOP_LOTTERY_CHANGED')
    expect((await draw({ revision: 3 })).entry.cost).toBe(350)
  })

  test('ordinary and legacy purchases cannot bypass lottery entry or overspend past historical draw fees', async () => {
    await publish(); await configure({ odds: 1 }); await publish(PHOTO, 'photo', 950); await publish(OTHER, 'file', 950)
    await forceRoll(9999); await saveBalance(1_001_000); await draw()
    await expect(db.query('select public.purchase_shop_product($1::uuid,100,$2::uuid)', [FILE, ALICE])).rejects.toThrow('SHOP_LOTTERY_REQUIRED')
    await expect(db.query('select public.purchase_shop_photo($1::uuid,100,$2::uuid)', [FILE, ALICE])).rejects.toThrow('SHOP_PHOTO_NOT_FOUND')
    await expect(db.query('select public.purchase_shop_photo($1::uuid,950,$2::uuid)', [PHOTO, ALICE])).rejects.toThrow('SHOP_INSUFFICIENT_PROFIT')
    await expect(db.query('select public.purchase_shop_product($1::uuid,950,$2::uuid)', [OTHER, ALICE])).rejects.toThrow('SHOP_INSUFFICIENT_PROFIT')
    const legacy = (await db.query<{ result: Shop }>('select public.get_photo_shop($1::uuid) as result', [ALICE])).rows[0].result
    expect(legacy.spentProfit).toBe(100)
    expect(legacy.availableProfit).toBe(900)
    expect(legacy.photos.map(product => product.id)).toEqual([PHOTO])
  })

  test('the production random helper returns bounded integer rolls and has no client-supplied outcome', async () => {
    await db.exec('reset role'); await db.exec(productionRoll)
    const rolls = (await db.query<{ roll: number }>('select public.shop_lottery_roll() as roll from generate_series(1,128)')).rows.map(row => row.roll)
    expect(rolls).toHaveLength(128)
    expect(rolls.every(roll => Number.isInteger(roll) && roll >= 0 && roll < 10000)).toBe(true)
    expect(migration).toContain('exit when sample < 4294960000')
    expect(migration).not.toMatch(/p_outcome|p_random|p_seed|test_mode/i)
  })

  test('reapplying the migration preserves draw results, pending orders, configuration and virtual-account state', async () => {
    await publish(); await configure(); await saveBalance()
    const won = await draw()
    await db.exec('reset role')
    const before = (await db.query('select state,revision from public.practice_accounts where user_id=$1', [ALICE])).rows
    await db.exec(migration)
    await asUser(ALICE)
    expect((await draw()).entry).toEqual(won.entry)
    expect(await snapshot()).toMatchObject({ spentProfit: 100, availableProfit: 1900 })
    expect(item(await snapshot()).lottery?.revision).toBe(1)
    await db.exec('reset role')
    expect((await db.query('select state,revision from public.practice_accounts where user_id=$1', [ALICE])).rows).toEqual(before)
    expect((await db.query('select * from public.shop_file_orders')).rows).toHaveLength(1)
    expect((await db.query("select name from storage.objects where bucket_id='shop-files'")).rows).toEqual([{ name: `${FILE}/original.txt` }])
  })
})
