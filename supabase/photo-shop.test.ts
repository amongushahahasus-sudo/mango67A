import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'

const DEVELOPER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const PHOTO = '33333333-3333-4333-8333-333333333333'
const OTHER_PHOTO = '44444444-4444-4444-8444-444444444444'
const PAIRS = ['USDJPY', 'EURJPY', 'GBPJPY', 'EURUSD']

interface ShopPhoto { id: string; title: string; price: number; published: boolean; purchased: boolean; paidPrice: number | null; revision: number; previewPath: string }
interface Shop { role: 'developer' | 'admin' | null; realizedProfit: number; spentProfit: number; availableProfit: number; photos: ShopPhoto[] }
let db: PGlite
let migration: string
let activation: string

function state(balance = 1_001_000) {
  return { version: 1, account: { balance, positions: [], orders: [], history: [] },
    markets: Object.fromEntries(PAIRS.map(pair => [pair, [{ time: 1700000000000, open: 150, high: 150, low: 150, close: 150 }]])),
    baseline: Object.fromEntries(PAIRS.map(pair => [pair, 150])), pair: 'USDJPY', scenario: 'balanced', timeframe: '1m', speed: 1, paused: true }
}
async function asUser(id: string | null, role: 'authenticated' | 'anon' = 'authenticated') {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id || ''])
  await db.exec(`set role ${role}`)
}
async function shop(id: string | null): Promise<Shop> {
  return (await db.query<{ result: Shop }>('select public.get_photo_shop($1::uuid) as result', [id])).rows[0].result
}
async function purchase(id = PHOTO, price = 600, user = ALICE): Promise<Shop> {
  return (await db.query<{ result: Shop }>('select public.purchase_shop_photo($1::uuid,$2::integer,$3::uuid) as result', [id, price, user])).rows[0].result
}
async function files(id = PHOTO) {
  await db.exec('reset role')
  await db.query("insert into storage.objects(bucket_id,name) values ('photo-previews',$1),('photo-originals',$2)", [`${id}/preview.jpg`, `${id}/original.jpg`])
}
async function savePhoto({ id = PHOTO, title = '海辺の写真', price = 600, published = true, revision = null as number | null, preview = `${id}/preview.jpg` as string | null, original = `${id}/original.jpg` as string | null, user = DEVELOPER } = {}): Promise<Shop> {
  return (await db.query<{ result: Shop }>('select public.save_shop_photo($1::uuid,$2,$3,$4::integer,$5::boolean,$6,$7,$8::bigint,$9::uuid) as result', [id, title, '撮影した風景', price, published, preview, original, revision, user])).rows[0].result
}
async function catalogPhoto(id = PHOTO, price = 600) {
  await files(id)
  await asUser(DEVELOPER)
  await savePhoto({ id, price })
}
async function saveBalance(balance: number, revision: number | null = null, user = ALICE) {
  await asUser(user)
  await db.query('select public.save_practice_account($1::jsonb,$2::bigint,$3::uuid)', [JSON.stringify(state(balance)), revision, user])
}
async function visibleObjects() {
  return (await db.query<{ bucket_id: string; name: string }>('select bucket_id,name from storage.objects order by bucket_id,name')).rows
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb not null default '{}');
    create function auth.uid() returns uuid language sql stable as
      $$select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid$$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    insert into auth.users(id) values ('${DEVELOPER}'),('${ALICE}'),('${BOB}');
    create schema storage;
    create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,metadata jsonb not null default '{}',unique(bucket_id,name));
    alter table storage.objects enable row level security;
    alter table storage.objects force row level security;
    alter table storage.buckets enable row level security;
    alter table storage.buckets force row level security;
    grant usage on schema storage to anon, authenticated;
    grant select,insert,update,delete on storage.objects to anon, authenticated;
    grant select,update,delete on storage.buckets to anon, authenticated;
  `)
  await db.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'))
  migration = await readFile(new URL('./photo-shop.sql', import.meta.url), 'utf8')
  await db.exec(migration)
  const documentation = await readFile(new URL('./PHOTO_SHOP.md', import.meta.url), 'utf8')
  const activationBlock = documentation.match(/```sql\n([\s\S]+?)\n```/)
  if (!activationBlock) throw new Error('Photo shop activation instructions must include executable SQL')
  activation = activationBlock[1].replace('YOUR_REGISTERED_EMAIL@example.com', 'owner@example.test')
}, 60_000)

beforeEach(async () => {
  await db.exec('reset role')
  await db.exec('delete from public.shop_purchases; delete from public.shop_photos; delete from public.shop_roles; delete from public.practice_accounts; delete from storage.objects;')
  await db.exec("update auth.users set email=null,email_confirmed_at=null,raw_user_meta_data='{}'")
  await db.query('insert into public.shop_roles(user_id,role) values ($1,$2)', [DEVELOPER, 'developer'])
  await db.query("select set_config('request.jwt.claim.sub','',false)")
})
afterAll(async () => { await db?.close() })

describe('photo catalog, role and storage ownership (real PostgreSQL RLS)', () => {
  test('anonymous catalog excludes drafts and never discloses private paths or roles', async () => {
    await catalogPhoto()
    await files(OTHER_PHOTO)
    await asUser(DEVELOPER)
    await savePhoto({ id: OTHER_PHOTO, published: false })
    await asUser(null, 'anon')
    const result = await shop(null)
    expect(result.role).toBeNull()
    expect(result.availableProfit).toBe(0)
    expect(result.photos.map(p => p.id)).toEqual([PHOTO])
    expect(JSON.stringify(result)).not.toContain('original')
    expect((await db.query('select title from public.shop_photos')).rows).toHaveLength(1)
    await expect(db.query('select original_path from public.shop_photos')).rejects.toThrow(/permission denied/)
    await expect(db.query('select * from public.shop_roles')).rejects.toThrow(/permission denied/)
    await expect(purchase()).rejects.toThrow(/permission denied/)
  })

  test('authenticated identity cannot be swapped to another account or omitted', async () => {
    await catalogPhoto()
    await asUser(ALICE)
    await expect(shop(BOB)).rejects.toThrow('ACCOUNT_USER_CHANGED')
    await expect(shop(null)).rejects.toThrow('ACCOUNT_USER_CHANGED')
    await expect(purchase(PHOTO, 600, BOB)).rejects.toThrow('ACCOUNT_USER_CHANGED')
    await expect(savePhoto({ user: BOB })).rejects.toThrow('ACCOUNT_USER_CHANGED')
  })

  test('a regular user cannot grant themselves roles or directly write products/purchases', async () => {
    await catalogPhoto()
    await db.exec('reset role')
    await db.query('update auth.users set raw_user_meta_data=$1::jsonb where id=$2', [JSON.stringify({ role: 'developer', is_admin: true }), ALICE])
    await asUser(ALICE)
    expect((await shop(ALICE)).role).toBeNull()
    expect((await db.query('select * from public.shop_roles')).rows).toEqual([])
    await expect(db.query("insert into public.shop_roles(user_id,role) values ($1,'developer')", [ALICE])).rejects.toThrow(/permission denied/)
    await expect(db.query("update public.shop_photos set price=1")).rejects.toThrow(/permission denied/)
    await expect(db.query('insert into public.shop_purchases(user_id,photo_id,paid_price) values ($1,$2,1)', [ALICE, PHOTO])).rejects.toThrow(/permission denied/)
    await expect(savePhoto({ user: ALICE })).rejects.toThrow('SHOP_ADMIN_REQUIRED')
  })

  test('developer and administrator roles are read from protected database rows', async () => {
    await asUser(DEVELOPER)
    expect((await shop(DEVELOPER)).role).toBe('developer')
    await db.exec('reset role')
    await db.query("insert into public.shop_roles(user_id,role) values ($1,'admin')", [BOB])
    await asUser(BOB)
    expect((await shop(BOB)).role).toBe('admin')
    expect((await db.query('select user_id,role from public.shop_roles')).rows).toEqual([{ user_id: BOB, role: 'admin' }])
  })

  test('only administrators upload valid immutable paths; originals are unreadable before purchase', async () => {
    await asUser(ALICE)
    await expect(db.query("insert into storage.objects(bucket_id,name) values ('photo-originals',$1)", [`${PHOTO}/original.jpg`])).rejects.toThrow(/row-level security/)
    await asUser(DEVELOPER)
    await expect(db.query("insert into storage.objects(bucket_id,name) values ('photo-originals','bad/path.svg')")).rejects.toThrow(/row-level security/)
    await db.query("insert into storage.objects(bucket_id,name) values ('photo-originals',$1)", [`${PHOTO}/original.jpg`])
    await db.query("insert into storage.objects(bucket_id,name) values ('photo-previews',$1)", [`${PHOTO}/preview.jpg`])
    await savePhoto()
    await asUser(ALICE)
    expect((await visibleObjects()).map(o => o.bucket_id)).toEqual(['photo-previews'])
    await asUser(DEVELOPER)
    expect(await visibleObjects()).toHaveLength(2)
    expect((await db.query("update storage.objects set metadata='{}' where bucket_id='photo-originals' returning name")).rows).toEqual([])
    expect((await db.query('delete from storage.objects returning name')).rows).toEqual([])
    await db.query("insert into storage.objects(bucket_id,name) values ('photo-originals',$1)", [`${OTHER_PHOTO}/original.png`])
    expect((await db.query('delete from storage.objects returning name')).rows).toEqual([{ name: `${OTHER_PHOTO}/original.png` }])
  })

  test('restrictive storage guards survive an unrelated permissive policy', async () => {
    await catalogPhoto()
    await db.exec('reset role')
    await db.exec('create policy test_accidental_storage_access on storage.objects for all to anon,authenticated using(true) with check(true)')
    try {
      await asUser(ALICE)
      expect((await visibleObjects()).map(o => o.bucket_id)).toEqual(['photo-previews'])
      await expect(db.query("insert into storage.objects(bucket_id,name) values ('photo-originals',$1)", [`${OTHER_PHOTO}/original.jpg`])).rejects.toThrow(/row-level security/)
      expect((await db.query('delete from storage.objects returning name')).rows).toEqual([])
      await asUser(DEVELOPER)
      expect((await db.query("update storage.objects set name=$1 where bucket_id='photo-originals' returning name", [`${OTHER_PHOTO}/original.jpg`])).rows).toEqual([])
    } finally {
      await db.exec('reset role')
      await db.exec('drop policy test_accidental_storage_access on storage.objects')
    }
  })

  test('a permissive bucket policy cannot expose or remove the private originals bucket', async () => {
    await db.exec('create policy test_accidental_bucket_access on storage.buckets for all to anon,authenticated using(true) with check(true)')
    try {
      await asUser(ALICE)
      expect((await db.query("update storage.buckets set public=true where id='photo-originals' returning id")).rows).toEqual([])
      await asUser(DEVELOPER)
      expect((await db.query('delete from storage.buckets returning id')).rows).toEqual([])
      expect((await db.query("select public from storage.buckets where id='photo-originals'")).rows).toEqual([{ public: false }])
    } finally {
      await db.exec('reset role')
      await db.exec('drop policy test_accidental_bucket_access on storage.buckets')
    }
  })
})

describe('virtual-profit purchases and durable entitlements', () => {
  test('purchase consumes only the separate rewards wallet and returns the fresh entitlement', async () => {
    await catalogPhoto()
    await saveBalance(1_001_000.9)
    const before = (await db.query('select state,revision from public.practice_accounts')).rows
    const result = await purchase()
    expect(result.realizedProfit).toBe(1000)
    expect(result.spentProfit).toBe(600)
    expect(result.availableProfit).toBe(400)
    expect(result.photos[0]).toMatchObject({ id: PHOTO, purchased: true, paidPrice: 600 })
    expect((await db.query('select state,revision from public.practice_accounts')).rows).toEqual(before)
    const download = (await db.query<{ value: { originalPath: string; fileName: string } }>('select public.get_shop_photo_download($1,$2) as value', [PHOTO, ALICE])).rows[0].value
    expect(download).toEqual({ originalPath: `${PHOTO}/original.jpg`, fileName: '海辺の写真.jpg' })
    expect(await visibleObjects()).toHaveLength(2)
  })

  test('base capital, losses and unsaved local state cannot fund a purchase', async () => {
    await catalogPhoto()
    await asUser(ALICE)
    await expect(purchase()).rejects.toThrow('SHOP_ACCOUNT_REQUIRED')
    await saveBalance(999_000)
    expect((await shop(ALICE)).availableProfit).toBe(0)
    await expect(purchase()).rejects.toThrow('SHOP_INSUFFICIENT_PROFIT')
    await saveBalance(1_000_599.99, 1)
    await expect(purchase()).rejects.toThrow('SHOP_INSUFFICIENT_PROFIT')
    expect((await db.query('select * from public.shop_purchases')).rows).toEqual([])
  })

  test('server price, publication and expected identity are checked before spending', async () => {
    await catalogPhoto()
    await saveBalance(1_001_000)
    await expect(purchase(PHOTO, 1)).rejects.toThrow('SHOP_PRICE_CHANGED')
    await asUser(DEVELOPER)
    await savePhoto({ published: false, revision: 1, preview: null, original: null })
    await asUser(ALICE)
    await expect(purchase()).rejects.toThrow('SHOP_PHOTO_UNAVAILABLE')
    expect((await shop(ALICE)).spentProfit).toBe(0)
  })

  test('retries do not spend twice, including after an administrator changes price or archives it', async () => {
    await catalogPhoto()
    await saveBalance(1_001_000)
    await purchase()
    await asUser(DEVELOPER)
    await savePhoto({ price: 1000, published: false, revision: 1, preview: null, original: null })
    await asUser(ALICE)
    const result = await purchase(PHOTO, 1)
    expect(result.spentProfit).toBe(600)
    expect(result.photos[0]).toMatchObject({ published: false, price: 1000, paidPrice: 600, purchased: true })
    expect((await db.query('select * from public.shop_purchases')).rows).toHaveLength(1)
    expect((await db.query('select public.get_shop_photo_download($1,$2) as file', [PHOTO, ALICE])).rows[0].file).toHaveProperty('originalPath')
    expect(await visibleObjects()).toHaveLength(2)
    await asUser(BOB)
    expect((await shop(BOB)).photos).toEqual([])
    await expect(db.query('select public.get_shop_photo_download($1,$2)', [PHOTO, BOB])).rejects.toThrow('SHOP_PURCHASE_REQUIRED')
    expect(await visibleObjects()).toEqual([])
  })

  test('a second product cannot spend the first purchase money again; reset never refunds spent profit', async () => {
    await catalogPhoto()
    await catalogPhoto(OTHER_PHOTO)
    await saveBalance(1_001_000)
    await purchase()
    await expect(purchase(OTHER_PHOTO)).rejects.toThrow('SHOP_INSUFFICIENT_PROFIT')
    await saveBalance(1_000_000, 1)
    expect(await shop(ALICE)).toMatchObject({ realizedProfit: 0, spentProfit: 600, availableProfit: 0 })
    await saveBalance(1_000_900, 2)
    expect((await shop(ALICE)).availableProfit).toBe(300)
    expect((await shop(ALICE)).photos.find(p => p.id === PHOTO)?.purchased).toBe(true)
  })

  test('purchase rows remain private to their owner and cannot be cleared to refund rewards', async () => {
    await catalogPhoto()
    await saveBalance(1_001_000)
    await purchase()
    await asUser(BOB)
    expect((await db.query('select * from public.shop_purchases')).rows).toEqual([])
    await asUser(ALICE)
    await expect(db.query('delete from public.shop_purchases')).rejects.toThrow(/permission denied/)
    await expect(db.query('update public.shop_purchases set paid_price=1')).rejects.toThrow(/permission denied/)
    expect((await shop(ALICE)).spentProfit).toBe(600)
  })
})

describe('administrator publishing and repeatable setup', () => {
  test('documented activation grants only the exact confirmed email, case-insensitively and repeatably', async () => {
    await db.query('update auth.users set email=$1,email_confirmed_at=now() where id=$2', ['OWNER@example.test', ALICE])
    await db.query('update auth.users set email=$1,email_confirmed_at=now() where id=$2', ['owner+other@example.test', BOB])
    await db.query("insert into public.shop_roles(user_id,role) values ($1,'admin')", [ALICE])
    await db.exec(activation)
    await db.exec(activation)
    await asUser(ALICE)
    expect((await shop(ALICE)).role).toBe('developer')
    await asUser(BOB)
    expect((await shop(BOB)).role).toBeNull()
    await db.exec('reset role')
    expect((await db.query('select user_id from public.shop_roles order by user_id')).rows.map(row => row.user_id)).toEqual([ALICE, DEVELOPER])
  })

  test('activation rejects missing, unconfirmed or ambiguous email without granting anyone a role', async () => {
    await expect(db.exec(activation)).rejects.toThrow('指定した確認済みアカウントが見つかりません')
    await db.query('update auth.users set email=$1 where id=$2', ['owner@example.test', ALICE])
    await expect(db.exec(activation)).rejects.toThrow('指定した確認済みアカウントが見つかりません')
    await db.query('update auth.users set email=$1,email_confirmed_at=now() where id in ($2,$3)', ['owner@example.test', ALICE, BOB])
    await expect(db.exec(activation)).rejects.toThrow('アカウントを一意に確認できません')
    expect((await db.query('select user_id from public.shop_roles')).rows).toEqual([{ user_id: DEVELOPER }])
  })

  test('validates uploads, positive bounded prices, revision conflicts and immutable originals', async () => {
    await asUser(DEVELOPER)
    await expect(savePhoto()).rejects.toThrow('SHOP_FILES_MISSING')
    await files()
    await asUser(DEVELOPER)
    await expect(savePhoto({ price: 0 })).rejects.toThrow('SHOP_INVALID_PHOTO')
    await expect(savePhoto({ price: 100000001 })).rejects.toThrow('SHOP_INVALID_PHOTO')
    await expect(savePhoto({ title: ' ' })).rejects.toThrow('SHOP_INVALID_PHOTO')
    await expect(savePhoto({ id: OTHER_PHOTO, preview: `${PHOTO}/preview.jpg`, original: `${PHOTO}/original.jpg` })).rejects.toThrow('SHOP_INVALID_PHOTO')
    const created = await savePhoto({ published: false })
    expect(created.photos[0]).toMatchObject({ revision: 1, published: false })
    expect((await savePhoto({ price: 800, revision: 1, preview: null, original: null })).photos[0]).toMatchObject({ price: 800, revision: 2 })
    await expect(savePhoto({ revision: 1 })).rejects.toThrow('SHOP_PHOTO_CONFLICT')
    await expect(savePhoto({ revision: 2, original: `${PHOTO}/original.png` })).rejects.toThrow('SHOP_FILES_IMMUTABLE')
  })

  test('reapplying the migration preserves roles, account revision, purchases, files and archived access', async () => {
    await catalogPhoto()
    await saveBalance(1_001_000)
    await purchase()
    await db.exec('reset role')
    await db.exec(migration)
    await asUser(ALICE)
    expect((await shop(ALICE)).spentProfit).toBe(600)
    expect(await visibleObjects()).toHaveLength(2)
    expect((await db.query('select revision from public.practice_accounts')).rows[0].revision).toBe(1)
    await asUser(DEVELOPER)
    expect((await shop(DEVELOPER)).role).toBe('developer')
    await db.exec('reset role')
    expect((await db.query('select public,allowed_mime_types,file_size_limit from storage.buckets order by id')).rows).toEqual([
      { public: false, allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'], file_size_limit: 15728640 },
      { public: true, allowed_mime_types: ['image/jpeg'], file_size_limit: 2097152 },
    ])
  })
})
