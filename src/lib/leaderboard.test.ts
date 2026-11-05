import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), rpc: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { auth: { getSession: mocks.getSession }, rpc: mocks.rpc } }))
import { loadLeaderboard, parseLeaderboard } from './leaderboard'
import type { LeaderboardEntry, LeaderboardSnapshot } from './leaderboard'

const alice = '11111111-1111-4111-8111-111111111111'
const bob = '22222222-2222-4222-8222-222222222222'
const first: LeaderboardEntry = { position: 1, rank: 1, displayName: 'トレーダーAAAAAAAAAA', realizedPnl: 1000.25, isMe: false }
const mine: LeaderboardEntry = { position: 2, rank: 2, displayName: 'トレーダーBBBBBBBBBB', realizedPnl: 800.5, isMe: true }
const board: LeaderboardSnapshot = { direction: 'profit', entries: [first, mine], ownEntry: mine,
  myRealizedPnl: 800.5, participantCount: 2, generatedAt: '2026-11-05T02:00:00.000Z' }
const session = (userId: string | null) => ({ data: { session: userId ? { user: { id: userId } } : null }, error: null })
const response = (data: unknown = board, error: unknown = null) => ({ abortSignal: vi.fn().mockResolvedValue({ data, error }) })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.getSession.mockResolvedValue(session(alice))
  mocks.rpc.mockImplementation(() => response())
})

describe('leaderboard response boundaries', () => {
  it('preserves signed fractional results, own highlight and server rank', () => {
    expect(parseLeaderboard(board, 'profit')).toEqual(board)
    const loss = { ...board, direction: 'loss', entries: [{ ...first, realizedPnl: -1000.25 }, { ...mine, realizedPnl: -800.5 }],
      ownEntry: { ...mine, realizedPnl: -800.5 }, myRealizedPnl: -800.5 }
    expect(parseLeaderboard(loss, 'loss')).toEqual(loss)
  })

  it('allows tied ranks, keeps position unique, and validates rank gaps', () => {
    const tied = { ...board, entries: [first, { ...mine, realizedPnl: first.realizedPnl, rank: 1 }],
      ownEntry: { ...mine, realizedPnl: first.realizedPnl, rank: 1 }, myRealizedPnl: first.realizedPnl }
    expect(parseLeaderboard(tied, 'profit').entries[1].rank).toBe(1)
    expect(() => parseLeaderboard({ ...tied, entries: [first, { ...tied.entries[1], rank: 2 }] }, 'profit')).toThrow()
    expect(() => parseLeaderboard({ ...board, entries: [{ ...first, rank: 2 }, mine] }, 'profit')).toThrow()
  })

  it('accepts an empty board and a viewer with a result in the other direction', () => {
    const empty = { ...board, direction: 'loss', entries: [], ownEntry: null, participantCount: 0 }
    expect(parseLeaderboard(empty, 'loss')).toEqual(empty)
    expect(parseLeaderboard({ ...empty, myRealizedPnl: 0 }, 'loss').ownEntry).toBeNull()
  })

  it('retains the viewer rank outside the first100 without injecting it into the top list', () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({ ...first, position: index + 1, rank: index + 1,
      displayName: `トレーダー${index.toString(16).toUpperCase().padStart(10, '0')}`, realizedPnl: 1000 - index }))
    const outside = { ...mine, position: 120, rank: 120, realizedPnl: 700 }
    const result = parseLeaderboard({ ...board, entries, ownEntry: outside, participantCount: 150, myRealizedPnl: 700 }, 'profit')
    expect(result.entries).toHaveLength(100)
    expect(result.ownEntry?.rank).toBe(120)
    expect(result.entries.some(entry => entry.isMe)).toBe(false)
    expect(() => parseLeaderboard({ ...result, ownEntry: { ...outside, realizedPnl: 2000 }, myRealizedPnl: 2000 }, 'profit')).toThrow()
    expect(() => parseLeaderboard({ ...result, ownEntry: { ...outside, rank: 10 } }, 'profit')).toThrow()
  })

  it('rejects wrong direction/sign, unsafe amounts and broken top-list order', () => {
    for (const changes of [{ direction: 'loss' }, { participantCount: -1 }, { participantCount: 1 },
      { myRealizedPnl: Number.POSITIVE_INFINITY }, { generatedAt: 'invalid-date' }, { generatedAt: null }, { entries: null }]) {
      expect(() => parseLeaderboard({ ...board, ...changes }, 'profit')).toThrow()
    }
    for (const changes of [{ realizedPnl: 0 }, { realizedPnl: -1 }, { realizedPnl: 1_000_000_000_001 },
      { realizedPnl: Number.NaN }, { position: 2 }, { position: 1.5 }, { isMe: 'true' }]) {
      expect(() => parseLeaderboard({ ...board, entries: [{ ...first, ...changes }, mine] }, 'profit')).toThrow()
    }
    expect(() => parseLeaderboard({ ...board, entries: [{ ...first, realizedPnl: 100 }, mine] }, 'profit')).toThrow()
  })

  it('accepts only public pseudonyms and ignores undisplayed private properties', () => {
    for (const displayName of ['owner@example.test', '山田太郎', 'トレーダーAAAAAAAAAA\n', 'トレーダーaaaaaaaaaa', '<script>']) {
      expect(() => parseLeaderboard({ ...board, entries: [{ ...first, displayName }, mine] }, 'profit')).toThrow()
    }
    const result = parseLeaderboard({ ...board, email: 'private@example.test', entries: [{ ...first, email: 'private@example.test' }, mine] }, 'profit')
    expect(result).not.toHaveProperty('email')
    expect(result.entries[0]).not.toHaveProperty('email')
  })

  it('rejects forged own-row labels, multiple me markers and mismatched own PNL', () => {
    for (const ownEntry of [null, { ...mine, isMe: false }, { ...mine, rank: 1 }, { ...mine, realizedPnl: 800 }, { ...mine, displayName: first.displayName }]) {
      expect(() => parseLeaderboard({ ...board, ownEntry }, 'profit')).toThrow()
    }
    expect(() => parseLeaderboard({ ...board, entries: [{ ...first, isMe: true }, mine] }, 'profit')).toThrow()
    expect(() => parseLeaderboard({ ...board, myRealizedPnl: 100 }, 'profit')).toThrow()
  })
})

describe('account-pinned readonly requests', () => {
  it('requests a single direction using the verified account and timeout', async () => {
    const result = await loadLeaderboard('profit', alice)
    expect(result).toEqual(board)
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('get_practice_leaderboard', { p_direction: 'profit', p_expected_user_id: alice })
    expect(mocks.getSession).toHaveBeenCalledTimes(2)
  })

  it('refuses guests, invalid IDs and another active account before the RPC', async () => {
    for (const id of ['', `${alice}\n`, bob]) {
      await expect(loadLeaderboard('profit', id)).rejects.toMatchObject({ code: 'session_changed' })
    }
    mocks.getSession.mockResolvedValue(session(null))
    await expect(loadLeaderboard('profit', alice)).rejects.toMatchObject({ code: 'session_changed' })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('discards a previous account response after account switching', async () => {
    mocks.getSession.mockResolvedValueOnce(session(alice)).mockResolvedValueOnce(session(bob))
    await expect(loadLeaderboard('profit', alice)).rejects.toMatchObject({ code: 'session_changed' })
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })

  it('maps missing configuration, authorization and server errors without exposing raw details', async () => {
    for (const [error, code] of [[{ code: 'PGRST202', message: 'private schema details' }, 'setup'],
      [{ code: '42501', message: 'private auth details' }, 'session_changed'],
      [{ code: 'P0001', message: 'ACCOUNT_USER_CHANGED: private details' }, 'session_changed'],
      [{ code: 'XX000', message: 'private database exception' }, 'connection']] as const) {
      mocks.rpc.mockImplementationOnce(() => response(null, error))
      await expect(loadLeaderboard('profit', alice)).rejects.toMatchObject({ code })
      mocks.rpc.mockImplementationOnce(() => response(null, error))
      await expect(loadLeaderboard('profit', alice)).rejects.not.toThrow(/private/)
    }
  })

  it('does not retry after a network failure and hides unusable response details', async () => {
    mocks.rpc.mockImplementationOnce(() => ({ abortSignal: vi.fn().mockRejectedValue(new DOMException('Private network endpoint', 'TimeoutError')) }))
    await expect(loadLeaderboard('profit', alice)).rejects.toMatchObject({ code: 'connection' })
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    mocks.rpc.mockImplementationOnce(() => response({ email: 'private@example.test' }))
    await expect(loadLeaderboard('profit', alice)).rejects.not.toThrow(/private/)
  })
})
