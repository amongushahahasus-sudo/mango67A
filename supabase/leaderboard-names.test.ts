import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const CAROL = '33333333-3333-4333-8333-333333333333'
const DANA = '44444444-4444-4444-8444-444444444444'
type Entry = { position: number; rank: number; displayName: string; realizedPnl: number; isMe: boolean }
type Board = { direction: 'profit' | 'loss'; entries: Entry[]; ownEntry: Entry | null; myRealizedPnl: number; participantCount: number; generatedAt: string }
let db: PGlite
let migration: string

const state = () => ({ version: 1, account: { balance: 1000000, positions: [], orders: [], history: [] }, markets: {}, baseline: {}, pair: 'USDJPY', scenario: 'balanced', timeframe: '1m', speed: 1, paused: true })
async function asUser(id: string | null, role: 'authenticated' | 'anon' = 'authenticated') {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? ''])
  await db.exec(`set role ${role}`)
}
async function seed(id: string, balance: number | string | null, metadata: unknown = {}, confirmed = true) {
  await db.exec('reset role')
  await db.query('insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,$3,$4::jsonb)',
    [id, `${id.slice(0, 8)}@private.example.test`, confirmed ? '2026-11-05T00:00:00Z' : null, JSON.stringify(metadata)])
  if (balance !== null) await db.query(`insert into public.practice_accounts(user_id,state)
    values($1,jsonb_set($2::jsonb,'{account,balance}',to_jsonb($3::numeric)))`, [id, JSON.stringify(state()), String(balance)])
}
async function updateMetadata(id: string, metadata: unknown) {
  await db.exec('reset role')
  await db.query('update auth.users set raw_user_meta_data=$2::jsonb where id=$1', [id, JSON.stringify(metadata)])
}
async function board(direction: string | null = 'profit', expected: string | null = ALICE, legacy = false) {
  const rpc = legacy ? 'get_practice_leaderboard' : 'get_practice_leaderboard_named'
  return (await db.query<{ result: Board }>(`select public.${rpc}($1,$2::uuid) as result`, [direction, expected])).rows[0].result
}
async function originalRows() {
  await db.exec('reset role')
  return {
    users: (await db.query('select * from auth.users order by id')).rows,
    accounts: (await db.query('select * from public.practice_accounts order by user_id')).rows,
  }
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
  for (const name of ['schema.sql', 'leaderboards.sql']) await db.exec(await readFile(new URL(`./${name}`, import.meta.url), 'utf8'))
  migration = await readFile(new URL('./leaderboard-names.sql', import.meta.url), 'utf8')
  await db.exec(migration)
}, 60_000)
beforeEach(async () => {
  await db.exec('reset role')
  await db.exec('delete from public.practice_accounts; delete from auth.users')
  await db.query("select set_config('request.jwt.claim.sub','',false)")
})
afterAll(async () => { await db?.close() })

describe('account display names in member rankings', () => {
  test('uses the registered display name before the Google full name', async () => {
    await seed(ALICE, 1003000, { display_name: '  マンゴーさん  ', full_name: 'Different Google Name', private_note: 'DO-NOT-PUBLISH' })
    await seed(BOB, 1005000, { full_name: 'Google Trader' })
    await asUser(ALICE)
    const result = await board()
    expect(result.entries.map(entry => entry.displayName)).toEqual(['Google Trader', 'マンゴーさん'])
    expect(result.ownEntry).toEqual(result.entries[1])
    expect(result).toMatchObject({ participantCount: 2, myRealizedPnl: 3000 })
    for (const entry of result.entries) expect(Object.keys(entry).sort()).toEqual(['displayName', 'isMe', 'position', 'rank', 'realizedPnl'])
    const serialized = JSON.stringify(result)
    for (const hidden of ['Different Google Name', 'DO-NOT-PUBLISH', '@private', ALICE, BOB, 'raw_user_meta_data', 'markets', 'history', 'email']) expect(serialized).not.toContain(hidden)
  })

  test('normalizes whitespace and control characters while preserving ordinary names', async () => {
    await seed(ALICE, 1000300, { display_name: '\t  Aya\n\tMango \r  ' })
    await seed(BOB, 1000200, { display_name: '鈴木\u0007マンゴー' })
    await seed(CAROL, 1000100, { display_name: '<b>Plain text</b>' })
    await seed(DANA, 1000050, { display_name: '\uFEFF\u00A0\u3000Sora\u2028Green\u3000\u00A0\uFEFF' })
    await asUser(ALICE)
    expect((await board()).entries.map(entry => entry.displayName)).toEqual(['Aya Mango', '鈴木 マンゴー', '<b>Plain text</b>', 'Sora Green'])
  })

  test('blank or non-string display names fall back to a valid Google name, otherwise a pseudonym', async () => {
    await seed(ALICE, 1000100)
    for (const display_name of ['', ' \t\n ', null, 123, false, [], { text: 'wrong type' }]) {
      await updateMetadata(ALICE, { display_name, full_name: 'Google Fallback' })
      await asUser(ALICE)
      expect((await board()).ownEntry?.displayName).toBe('Google Fallback')
    }
    for (const full_name of ['', '\t\n', null, 456, false, [], {}]) {
      await updateMetadata(ALICE, { display_name: ' ', full_name })
      await asUser(ALICE)
      expect((await board()).ownEntry?.displayName).toMatch(/^トレーダー[A-F0-9]{10}$/)
    }
  })

  test('does not expose an email used as profile data or accidentally hidden beyond truncation', async () => {
    await seed(ALICE, 1000100)
    for (const display_name of ['person@example.test', 'Contact person@example.test', `${'長'.repeat(45)} person@example.test`]) {
      await updateMetadata(ALICE, { display_name, full_name: 'Public Name' })
      await asUser(ALICE)
      const result = await board()
      expect(result.ownEntry?.displayName).toBe('Public Name')
      expect(JSON.stringify(result)).not.toContain('person@example.test')
    }
    await updateMetadata(ALICE, { display_name: 'person@example.test', full_name: 'another@example.test' })
    await asUser(ALICE)
    expect((await board()).ownEntry?.displayName).toMatch(/^トレーダー[A-F0-9]{10}$/)
  })

  test('bounds names to forty Unicode characters without splitting emoji', async () => {
    await seed(ALICE, 1000200, { display_name: '🥭'.repeat(45) })
    await seed(BOB, 1000100, { display_name: '名'.repeat(45) })
    await seed(CAROL, 1000050, { display_name: `${'a'.repeat(39)} another word` })
    await asUser(ALICE)
    const names = (await board()).entries.map(entry => entry.displayName)
    expect(names).toEqual(['🥭'.repeat(40), '名'.repeat(40), 'a'.repeat(39)])
    expect(names[0].length).toBe(80)
  })

  test('keeps old cached-client rankings pseudonymous and leaves signed order and ties unchanged', async () => {
    await seed(ALICE, 1003000, { display_name: 'Alice' })
    await seed(BOB, 1005000, { display_name: 'Bob' })
    await seed(CAROL, 1005000, { display_name: 'Carol' })
    await seed(DANA, '999999.995', { display_name: 'Dana' })
    await asUser(ALICE)
    for (const direction of ['profit', 'loss']) {
      const named = await board(direction), old = await board(direction, ALICE, true)
      const scores = (result: Board) => result.entries.map(entry => [entry.position, entry.rank, entry.realizedPnl, entry.isMe])
      expect(scores(named)).toEqual(scores(old))
      expect(named.participantCount).toBe(old.participantCount)
      expect(named.myRealizedPnl).toBe(old.myRealizedPnl)
      expect(named.ownEntry?.position).toBe(old.ownEntry?.position)
      for (const entry of old.entries) expect(entry.displayName).toMatch(/^トレーダー[A-F0-9]{10}$/)
    }
    expect((await board()).entries.map(entry => entry.rank)).toEqual([1, 1, 3])
    expect((await board('loss')).entries[0]).toMatchObject({ displayName: 'Dana', realizedPnl: -0.01 })
  })

  test('requires a verified caller identity and grants no anonymous or direct private-table access', async () => {
    await seed(ALICE, 1000100, { display_name: 'Alice' })
    await seed(BOB, 1000200, { display_name: 'Bob' })
    await asUser(null, 'anon')
    await expect(board()).rejects.toThrow(/permission denied/)
    await asUser(null)
    await expect(board()).rejects.toThrow('ACCOUNT_USER_CHANGED')
    await asUser(ALICE)
    await expect(board('profit', BOB)).rejects.toThrow('ACCOUNT_USER_CHANGED')
    await expect(board('profit', null)).rejects.toThrow('ACCOUNT_USER_CHANGED')
    for (const direction of [null, '', 'all', 'PROFIT']) await expect(board(direction)).rejects.toThrow('LEADERBOARD_INVALID_DIRECTION')
    expect((await db.query('select user_id from public.practice_accounts')).rows).toEqual([{ user_id: ALICE }])
    await expect(db.query('select raw_user_meta_data from auth.users')).rejects.toThrow(/permission denied/)
  })

  test('retains confirmation and safe numeric filters and returns an outside member’s own name and rank', async () => {
    await seed(ALICE, 1000001, { display_name: 'Outside Trader' })
    await seed(BOB, '1e120000', { display_name: 'Huge Value' })
    await seed(CAROL, 1009000, { display_name: 'Unconfirmed' }, false)
    await seed(DANA, null, { display_name: 'No saved account' })
    await db.exec(`insert into auth.users(id,email_confirmed_at,raw_user_meta_data)
      select ('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad(n::text,12,'0'))::uuid,now(),jsonb_build_object('display_name','Participant ' || n) from generate_series(1,105) n`)
    await db.query(`insert into public.practice_accounts(user_id,state)
      select id,jsonb_set($1::jsonb,'{account,balance}',to_jsonb(1000100::numeric))
      from auth.users where id::text like 'aaaaaaaa-%'`, [JSON.stringify(state())])
    await asUser(ALICE)
    const result = await board()
    expect(result.participantCount).toBe(106)
    expect(result.entries).toHaveLength(100)
    expect(result.ownEntry).toMatchObject({ position: 106, rank: 106, displayName: 'Outside Trader', realizedPnl: 1, isMe: true })
    expect(JSON.stringify(result)).not.toContain('Huge Value')
    expect(JSON.stringify(result)).not.toContain('Unconfirmed')
    expect(JSON.stringify(result)).not.toContain('No saved account')
  })

  test('reapplication and reading rankings preserve account and profile data', async () => {
    await seed(ALICE, 1000100, { display_name: 'Alice', full_name: 'Original name', private: 'not returned' })
    await seed(BOB, 1000200, { display_name: 'Bob' })
    const original = await originalRows()
    await asUser(ALICE)
    const initial = (await board()).entries
    await db.exec('reset role')
    await db.exec(migration)
    await db.exec(migration)
    expect(await originalRows()).toEqual(original)
    await asUser(ALICE)
    expect((await board()).entries).toEqual(initial)
    expect(await originalRows()).toEqual(original)
    await asUser(null, 'anon')
    await expect(board()).rejects.toThrow(/permission denied/)
  })
})
