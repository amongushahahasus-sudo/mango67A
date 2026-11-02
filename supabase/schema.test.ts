import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import type { SavedState } from '../src/lib/practiceState'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const PAIRS = ['USDJPY', 'EURJPY', 'GBPJPY', 'EURUSD'] as const
const RATES = { USDJPY: 150, EURJPY: 165, GBPJPY: 190, EURUSD: 1.1 }

/** Small valid snapshot: these tests exercise PostgreSQL, not a mocked REST service. */
function snapshot(balance = 1_000_000): SavedState {
  return {
    version: 1,
    account: { balance, positions: [], orders: [], history: [] },
    markets: Object.fromEntries(PAIRS.map(pair => [pair, [{ time: 1_700_000_000_000, open: RATES[pair], high: RATES[pair], low: RATES[pair], close: RATES[pair] }]])) as SavedState['markets'],
    baseline: { ...RATES }, pair: 'USDJPY', scenario: 'balanced', timeframe: '1m', speed: 1, paused: true,
  }
}

interface RecordRow { state: SavedState; revision: number; updated_at: string | Date }
let db: PGlite
let schema: string
async function asUser(userId: string | null, role: 'authenticated' | 'anon' = 'authenticated') {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId || ''])
  await db.exec(`set role ${role}`)
}
async function save(state: unknown, revision: number | null, expectedUserId: string | null) {
  return (await db.query<RecordRow>(
    'select * from public.save_practice_account($1::jsonb, $2::bigint, $3::uuid)',
    [JSON.stringify(state), revision, expectedUserId],
  )).rows[0]
}
async function rows() { return (await db.query<{ user_id: string; state: SavedState; revision: number }>('select user_id, state, revision from public.practice_accounts')).rows }

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    insert into auth.users(id) values ('${ALICE}'), ('${BOB}');
  `)
  schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8')
  await db.exec(schema)
}, 60_000)

beforeEach(async () => {
  await db.exec('reset role')
  await db.exec('delete from public.practice_accounts')
  await db.query("select set_config('request.jwt.claim.sub', '', false)")
})
afterAll(async () => { await db?.close() })

describe('Supabase practice account ownership (real PostgreSQL RLS)', () => {
  test('anonymous users cannot read the table or call the save RPC', async () => {
    await asUser(null, 'anon')
    await expect(rows()).rejects.toThrow(/permission denied/)
    await expect(save(snapshot(), null, ALICE)).rejects.toThrow(/permission denied/)
  })

  test('an authenticated role without a user cannot create an account', async () => {
    await asUser(null)
    await expect(save(snapshot(), null, ALICE)).rejects.toThrow('ACCOUNT_USER_CHANGED')
    expect(await rows()).toEqual([])
  })

  test('two users independently save and read only their own balances', async () => {
    await asUser(ALICE)
    const alice = await save(snapshot(1_001_000), null, ALICE)
    expect(alice.revision).toBe(1)
    expect(alice.state.account.balance).toBe(1_001_000)
    expect(alice.updated_at).toBeTruthy()
    await asUser(BOB)
    expect(await rows()).toEqual([])
    await save(snapshot(999_000), null, BOB)
    expect((await rows()).map(row => [row.user_id, row.state.account.balance])).toEqual([[BOB, 999_000]])
    await asUser(ALICE)
    expect((await rows()).map(row => [row.user_id, row.state.account.balance])).toEqual([[ALICE, 1_001_000]])
  })

  test('a user cannot forge the expected identity or create data under another user', async () => {
    await asUser(ALICE)
    await expect(save(snapshot(), null, BOB)).rejects.toThrow('ACCOUNT_USER_CHANGED')
    await expect(save(snapshot(), null, null)).rejects.toThrow('ACCOUNT_USER_CHANGED')
    await db.exec('reset role')
    expect(await rows()).toEqual([])
  })

  test('a request prepared for Alice is rejected if the session switches to Bob', async () => {
    await asUser(ALICE)
    await save(snapshot(1_010_000), null, ALICE)
    await asUser(BOB)
    await expect(save(snapshot(1_500_000), 1, ALICE)).rejects.toThrow('ACCOUNT_USER_CHANGED')
    expect(await rows()).toEqual([])
    await asUser(ALICE)
    expect((await rows())[0].state.account.balance).toBe(1_010_000)
  })

  test('direct table writes are denied, so clients cannot bypass revision checks', async () => {
    await asUser(ALICE)
    await save(snapshot(), null, ALICE)
    await expect(db.query('update public.practice_accounts set revision = 99')).rejects.toThrow(/permission denied/)
    await expect(db.query('delete from public.practice_accounts')).rejects.toThrow(/permission denied/)
    await expect(db.query('insert into public.practice_accounts(user_id,state) values ($1,$2::jsonb)', [BOB, JSON.stringify(snapshot())])).rejects.toThrow(/permission denied/)
    expect((await rows())[0].revision).toBe(1)
  })

  test('owner guard still isolates rows if an unrelated permissive policy is added', async () => {
    await asUser(ALICE)
    await save(snapshot(), null, ALICE)
    await db.exec('reset role')
    await db.exec('create policy test_accidental_open_read on public.practice_accounts for select to authenticated using (true)')
    try {
      await asUser(BOB)
      expect(await rows()).toEqual([])
    } finally {
      await db.exec('reset role')
      await db.exec('drop policy test_accidental_open_read on public.practice_accounts')
    }
  })
})

describe('compare-and-swap persistence and setup repeatability', () => {
  test('updates increment revision; a stale tab cannot overwrite the latest account', async () => {
    await asUser(ALICE)
    await save(snapshot(), null, ALICE)
    const newer = await save(snapshot(1_005_000), 1, ALICE)
    expect(newer.revision).toBe(2)
    await expect(save(snapshot(800_000), 1, ALICE)).rejects.toThrow('ACCOUNT_CONFLICT')
    expect((await rows())[0].state.account.balance).toBe(1_005_000)
    expect((await rows())[0].revision).toBe(2)
  })

  test('creation and update mismatches report conflicts without replacing stored data', async () => {
    await asUser(ALICE)
    await expect(save(snapshot(), 1, ALICE)).rejects.toThrow('ACCOUNT_CONFLICT')
    await save(snapshot(1_003_000), null, ALICE)
    await expect(save(snapshot(100), null, ALICE)).rejects.toThrow('ACCOUNT_CONFLICT')
    expect((await rows())[0].state.account.balance).toBe(1_003_000)
  })

  test('invalid revision values cannot skip or reset the revision sequence', async () => {
    await asUser(ALICE)
    await save(snapshot(), null, ALICE)
    await expect(save(snapshot(), 0, ALICE)).rejects.toThrow('INVALID_ACCOUNT_REVISION')
    await expect(save(snapshot(), -1, ALICE)).rejects.toThrow('INVALID_ACCOUNT_REVISION')
    expect((await rows())[0].revision).toBe(1)
  })

  test('running the schema again preserves existing personal account data', async () => {
    await asUser(ALICE)
    await save(snapshot(1_234_567), null, ALICE)
    await db.exec('reset role')
    await db.exec(schema)
    await asUser(ALICE)
    expect((await rows())[0].state.account.balance).toBe(1_234_567)
    expect((await rows())[0].revision).toBe(1)
  })

  test('deleting an authentication user removes only that user\'s account', async () => {
    await asUser(ALICE)
    await save(snapshot(), null, ALICE)
    await asUser(BOB)
    await save(snapshot(), null, BOB)
    await db.exec('reset role')
    await db.query('delete from auth.users where id = $1', [ALICE])
    expect((await rows()).map(row => row.user_id)).toEqual([BOB])
    await db.query('insert into auth.users(id) values ($1)', [ALICE])
  })
})

describe('stored payload validation', () => {
  test('malformed account structure is rejected without creating an unusable row', async () => {
    await asUser(ALICE)
    for (const state of [null, [], {}, { ...snapshot(), version: 2 }, { ...snapshot(), version: '1' }, { ...snapshot(), account: { balance: '1000000', positions: [], orders: [], history: [] } }]) {
      await expect(save(state, null, ALICE)).rejects.toThrow('INVALID_ACCOUNT_STATE')
    }
    expect(await rows()).toEqual([])
  })

  test('enum fields and JSON nulls cannot bypass the state shape constraint', async () => {
    await asUser(ALICE)
    for (const state of [{ ...snapshot(), pair: 'INVALID' }, { ...snapshot(), pair: null }, { ...snapshot(), scenario: null }, { ...snapshot(), speed: null }, { ...snapshot(), speed: '1' }]) {
      await expect(save(state, null, ALICE)).rejects.toThrow()
    }
    expect(await rows()).toEqual([])
  })

  test('oversized payloads are rejected instead of consuming unbounded storage', async () => {
    await asUser(ALICE)
    const oversized = { ...snapshot(), padding: 'x'.repeat(3 * 1024 * 1024) }
    await expect(save(oversized, null, ALICE)).rejects.toThrow('ACCOUNT_STATE_TOO_LARGE')
    expect(await rows()).toEqual([])
  })

  test('excessive open positions or waiting orders are rejected', async () => {
    await asUser(ALICE)
    const state = snapshot()
    for (const key of ['positions', 'orders'] as const) {
      const tooMany = { ...state, account: { ...state.account, [key]: Array.from({ length: 101 }, () => ({})) } }
      await expect(save(tooMany, null, ALICE)).rejects.toThrow('INVALID_ACCOUNT_STATE')
    }
    expect(await rows()).toEqual([])
  })
})
