import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const CAROL = '33333333-3333-4333-8333-333333333333'
const DANA = '44444444-4444-4444-8444-444444444444'
const ELLIS = '55555555-5555-4555-8555-555555555555'
type Entry = { position: number; rank: number; displayName: string; realizedPnl: number; isMe: boolean }
type Board = { direction: 'profit' | 'loss'; entries: Entry[]; ownEntry: Entry | null; myRealizedPnl: number; participantCount: number; generatedAt: string }
let db: PGlite
let migration: string

function state() {
  return { version: 1, account: { balance: 1000000, positions: [], orders: [], history: [] },
    markets: {}, baseline: {}, pair: 'USDJPY', scenario: 'balanced', timeframe: '1m', speed: 1, paused: true }
}
async function asUser(id: string | null, role: 'authenticated' | 'anon' = 'authenticated') {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? ''])
  await db.exec(`set role ${role}`)
}
async function seed(id: string, balance: number | string | null, confirmed = true) {
  await db.exec('reset role')
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
    values($1,$2,$3,'{"full_name":"Private Full Name","display_name":"PRIVATE-NICKNAME"}')`,
  [id, `${id.slice(0, 8)}@private.example.test`, confirmed ? '2026-11-05T00:00:00Z' : null])
  if (balance !== null) await db.query(`insert into public.practice_accounts(user_id,state)
    values($1,jsonb_set($2::jsonb,'{account,balance}',to_jsonb($3::numeric)))`, [id, JSON.stringify(state()), String(balance)])
}
async function board(direction: string | null = 'profit', expected: string | null = ALICE) {
  return (await db.query<{ result: Board }>('select public.get_practice_leaderboard($1,$2::uuid) as result', [direction, expected])).rows[0].result
}
async function rawAccounts() {
  await db.exec('reset role')
  return (await db.query('select user_id,state,revision,updated_at from public.practice_accounts order by user_id')).rows
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb not null default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;
  `)
  await db.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'))
  migration = await readFile(new URL('./leaderboards.sql', import.meta.url), 'utf8')
  await db.exec(migration)
}, 60_000)
beforeEach(async () => {
  await db.exec('reset role')
  await db.exec('delete from public.practice_accounts; delete from auth.users')
  await db.query("select set_config('request.jwt.claim.sub','',false)")
})
afterAll(async () => { await db?.close() })

describe('member-only practice result rankings', () => {
  test('anonymous and mismatched identities cannot obtain a ranking', async () => {
    await seed(ALICE, 1001000)
    await asUser(null, 'anon')
    await expect(board()).rejects.toThrow(/permission denied/)
    await asUser(null)
    await expect(board()).rejects.toThrow('ACCOUNT_USER_CHANGED')
    await asUser(ALICE)
    await expect(board('profit', BOB)).rejects.toThrow('ACCOUNT_USER_CHANGED')
    await expect(board('profit', null)).rejects.toThrow('ACCOUNT_USER_CHANGED')
  })

  test('only the two supported directions are accepted', async () => {
    await seed(ALICE, 1001000)
    await asUser(ALICE)
    for (const direction of [null, '', 'all', 'PROFIT', 'profit; select * from auth.users']) {
      await expect(board(direction)).rejects.toThrow('LEADERBOARD_INVALID_DIRECTION')
    }
  })

  test('profits are descending with shared ranks and pseudonyms only', async () => {
    await seed(ALICE, 1003000)
    await seed(BOB, 1005000)
    await seed(CAROL, 1005000)
    await seed(DANA, 999000)
    await seed(ELLIS, 1000000)
    await asUser(ALICE)
    const result = await board()
    expect(result).toMatchObject({ direction: 'profit', participantCount: 3, myRealizedPnl: 3000 })
    expect(result.entries.map(entry => [entry.position, entry.rank, entry.realizedPnl, entry.isMe])).toEqual([
      [1, 1, 5000, false], [2, 1, 5000, false], [3, 3, 3000, true],
    ])
    expect(result.ownEntry).toEqual(result.entries[2])
    expect(Number.isFinite(Date.parse(result.generatedAt))).toBe(true)
    for (const entry of result.entries) {
      expect(entry.displayName).toMatch(/^トレーダー[A-F0-9]{10}$/)
      expect(Object.keys(entry).sort()).toEqual(['displayName', 'isMe', 'position', 'rank', 'realizedPnl'])
    }
    const serialized = JSON.stringify(result)
    for (const secret of [ALICE, BOB, CAROL, '@private', 'Private Full Name', 'PRIVATE-NICKNAME', 'markets', 'history', 'user_id', 'email']) {
      expect(serialized).not.toContain(secret)
    }
    const again = await board()
    expect(again.entries).toEqual(result.entries)
  })

  test('losses put the largest loss first and preserve signed amounts and rounding', async () => {
    await seed(ALICE, '999999.995')
    await seed(BOB, '990000.126')
    await seed(CAROL, '999999.996')
    await seed(DANA, 1000400)
    await asUser(ALICE)
    const result = await board('loss')
    expect(result.entries.map(entry => entry.realizedPnl)).toEqual([-9999.87, -0.01])
    expect(result).toMatchObject({ direction: 'loss', participantCount: 2, myRealizedPnl: -0.01 })
    expect(result.ownEntry).toMatchObject({ position: 2, rank: 2, isMe: true, realizedPnl: -0.01 })
    const profits = await board('profit')
    expect(profits.ownEntry).toBeNull()
    expect(profits.myRealizedPnl).toBe(-0.01)
    expect(profits.entries.map(entry => entry.realizedPnl)).toEqual([400])
  })

  test('unconfirmed users and accounts without a cloud snapshot are excluded', async () => {
    await seed(ALICE, 1000200)
    await seed(BOB, 9000000, false)
    await seed(CAROL, null)
    await asUser(ALICE)
    const result = await board()
    expect(result.participantCount).toBe(1)
    expect(result.entries[0]).toMatchObject({ isMe: true, realizedPnl: 200 })
    await asUser(CAROL)
    const withoutAccount = await board('profit', CAROL)
    expect(withoutAccount).toMatchObject({ myRealizedPnl: 0, ownEntry: null, participantCount: 1 })
  })

  test('an empty direction has no artificial zero-value participants', async () => {
    await seed(ALICE, 1000000)
    await asUser(ALICE)
    for (const direction of ['profit', 'loss']) {
      expect(await board(direction)).toMatchObject({ entries: [], ownEntry: null, myRealizedPnl: 0, participantCount: 0 })
    }
  })

  test('the top 100 is bounded but an outside member still receives their own rank', async () => {
    await seed(ALICE, 1000001)
    await db.exec(`insert into auth.users(id,email_confirmed_at)
      select ('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad(n::text,12,'0'))::uuid,now() from generate_series(1,105) n`)
    await db.query(`insert into public.practice_accounts(user_id,state)
      select id,jsonb_set($1::jsonb,'{account,balance}',to_jsonb(1000100::numeric))
      from auth.users where id <> $2::uuid`, [JSON.stringify(state()), ALICE])
    await asUser(ALICE)
    const result = await board()
    expect(result.participantCount).toBe(106)
    expect(result.entries).toHaveLength(100)
    expect(result.entries[99]).toMatchObject({ position: 100, rank: 1, isMe: false, realizedPnl: 100 })
    expect(result.ownEntry).toMatchObject({ position: 106, rank: 106, isMe: true, realizedPnl: 1 })
    expect(new Set(result.entries.map(entry => entry.position)).size).toBe(100)
  })

  test('the ranking does not open direct account access or modify any account data', async () => {
    await seed(ALICE, 1000400)
    await seed(BOB, 1000900)
    const original = await rawAccounts()
    await asUser(ALICE)
    expect((await board()).entries).toHaveLength(2)
    expect((await db.query('select user_id from public.practice_accounts')).rows).toEqual([{ user_id: ALICE }])
    await expect(db.query('select email from auth.users')).rejects.toThrow(/permission denied/)
    await expect(db.query('update public.practice_accounts set revision=100')).rejects.toThrow(/permission denied/)
    expect(await rawAccounts()).toEqual(original)
  })

  test('fresh saves, reset and deletion are reflected without a separate write or trigger', async () => {
    await seed(ALICE, 1000600)
    await seed(BOB, 1001000)
    await asUser(ALICE)
    expect((await board()).ownEntry?.rank).toBe(2)
    await db.exec('reset role')
    await db.query(`update public.practice_accounts set state=jsonb_set(state,'{account,balance}','1002000'::jsonb) where user_id=$1`, [ALICE])
    await asUser(ALICE)
    expect((await board()).ownEntry?.rank).toBe(1)
    await db.exec('reset role')
    await db.query(`update public.practice_accounts set state=jsonb_set(state,'{account,balance}','1000000'::jsonb) where user_id=$1`, [ALICE])
    await db.query('delete from auth.users where id=$1', [BOB])
    await asUser(ALICE)
    expect(await board()).toMatchObject({ entries: [], ownEntry: null, myRealizedPnl: 0, participantCount: 0 })
  })

  test('extreme saved JSON numbers cannot overflow or enter a misleading numeric rank', async () => {
    await seed(ALICE, 1000100)
    await seed(BOB, '1e120000')
    await seed(CAROL, '-1e120000')
    await seed(DANA, '1000001000000')
    await seed(ELLIS, '-999999000000')
    await asUser(ALICE)
    expect((await board()).entries.map(entry => entry.realizedPnl)).toEqual([1000000000000, 100])
    expect((await board('loss')).entries.map(entry => entry.realizedPnl)).toEqual([-1000000000000])
    await asUser(BOB)
    expect(await board('profit', BOB)).toMatchObject({ myRealizedPnl: 0, ownEntry: null, participantCount: 2 })
  })

  test('reapplying the migration retains existing rows and grants no anonymous execution', async () => {
    await seed(ALICE, 1001000)
    const original = await rawAccounts()
    await asUser(ALICE)
    const originalEntry = (await board()).ownEntry
    await db.exec('reset role')
    await db.exec(migration)
    await db.exec(migration)
    expect(await rawAccounts()).toEqual(original)
    await asUser(ALICE)
    expect((await board()).ownEntry).toEqual(originalEntry)
    await asUser(null, 'anon')
    await expect(board()).rejects.toThrow(/permission denied/)
  })
})
