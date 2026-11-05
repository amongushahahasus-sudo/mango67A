import { supabase } from './supabase'

export type LeaderboardDirection = 'profit' | 'loss'
export interface LeaderboardEntry {
  position: number
  rank: number
  displayName: string
  realizedPnl: number
  isMe: boolean
}
export interface LeaderboardSnapshot {
  direction: LeaderboardDirection
  entries: LeaderboardEntry[]
  ownEntry: LeaderboardEntry | null
  myRealizedPnl: number
  participantCount: number
  generatedAt: string
}
export class LeaderboardError extends Error {
  constructor(public readonly code: 'setup' | 'session_changed' | 'connection', message: string) {
    super(message)
    this.name = 'LeaderboardError'
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ALIAS = /^トレーダー[A-F0-9]{10}$/
const MAX_PNL = 1_000_000_000_000
const connectionError = () => new LeaderboardError('connection', 'ランキングを読み込めませんでした。通信を確認して、もう一度お試しください。')
const sessionError = () => new LeaderboardError('session_changed', 'ログイン中のアカウントを確認できませんでした。もう一度ランキングを開いてください。')
const setupError = () => new LeaderboardError('setup', 'ランキングは準備中です。公開準備が整うまで、しばらくお待ちください。')
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const amount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_PNL
const qualifies = (value: number, direction: LeaderboardDirection) => direction === 'profit' ? value > 0 : value < 0

function parseEntry(value: unknown, direction: LeaderboardDirection, participantCount: number): LeaderboardEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw connectionError()
  const e = value as Record<string, unknown>
  if (!integer(e.position) || e.position < 1 || e.position > participantCount
    || !integer(e.rank) || e.rank < 1 || e.rank > e.position
    || typeof e.displayName !== 'string' || e.displayName.length !== 15 || !ALIAS.test(e.displayName)
    || !amount(e.realizedPnl) || !qualifies(e.realizedPnl, direction) || typeof e.isMe !== 'boolean') throw connectionError()
  return { position: e.position, rank: e.rank, displayName: e.displayName, realizedPnl: e.realizedPnl, isMe: e.isMe }
}

function sameEntry(a: LeaderboardEntry, b: LeaderboardEntry) {
  return a.position === b.position && a.rank === b.rank && a.displayName === b.displayName
    && a.realizedPnl === b.realizedPnl && a.isMe === b.isMe
}

export function parseLeaderboard(value: unknown, direction: LeaderboardDirection): LeaderboardSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw connectionError()
  const board = value as Record<string, unknown>
  if (board.direction !== direction || !integer(board.participantCount) || !amount(board.myRealizedPnl)
    || !Array.isArray(board.entries) || board.entries.length !== Math.min(board.participantCount, 100)
    || typeof board.generatedAt !== 'string' || board.generatedAt.length > 60 || !Number.isFinite(Date.parse(board.generatedAt))) throw connectionError()
  const entries = board.entries.map(entry => parseEntry(entry, direction, board.participantCount as number))
  let mine: LeaderboardEntry | null = null
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index], previous = entries[index - 1]
    if (entry.position !== index + 1) throw connectionError()
    const expectedRank = previous && previous.realizedPnl === entry.realizedPnl ? previous.rank : entry.position
    if (entry.rank !== expectedRank || (previous && (direction === 'profit'
      ? previous.realizedPnl < entry.realizedPnl : previous.realizedPnl > entry.realizedPnl))) throw connectionError()
    if (entry.isMe) {
      if (mine) throw connectionError()
      mine = entry
    }
  }
  const ownEntry = board.ownEntry === null ? null : parseEntry(board.ownEntry, direction, board.participantCount)
  if (ownEntry && (!ownEntry.isMe || ownEntry.realizedPnl !== board.myRealizedPnl)) throw connectionError()
  if (mine ? !ownEntry || !sameEntry(mine, ownEntry) : ownEntry && ownEntry.position <= entries.length) throw connectionError()
  const last = entries.at(-1)
  if (ownEntry && ownEntry.position > entries.length && last) {
    if ((direction === 'profit' ? ownEntry.realizedPnl > last.realizedPnl : ownEntry.realizedPnl < last.realizedPnl)
      || (ownEntry.realizedPnl === last.realizedPnl ? ownEntry.rank !== last.rank : ownEntry.rank <= last.rank)) throw connectionError()
  }
  if (!ownEntry && qualifies(board.myRealizedPnl, direction)) throw connectionError()
  return { direction, entries, ownEntry, myRealizedPnl: board.myRealizedPnl,
    participantCount: board.participantCount, generatedAt: board.generatedAt }
}

async function assertIdentity(expectedUserId: string) {
  if (!supabase) throw setupError()
  if (expectedUserId.length !== 36 || !UUID.test(expectedUserId)) throw sessionError()
  let session
  try { session = await supabase.auth.getSession() } catch { throw sessionError() }
  if (session.error || session.data.session?.user.id !== expectedUserId) throw sessionError()
}

export async function loadLeaderboard(direction: LeaderboardDirection, expectedUserId: string): Promise<LeaderboardSnapshot> {
  if (direction !== 'profit' && direction !== 'loss') throw connectionError()
  await assertIdentity(expectedUserId)
  let response
  try {
    response = await supabase!.rpc('get_practice_leaderboard', {
      p_direction: direction, p_expected_user_id: expectedUserId,
    }).abortSignal(AbortSignal.timeout(20_000))
  } catch { throw connectionError() }
  await assertIdentity(expectedUserId)
  if (response.error) {
    if (['PGRST202', '42883', '42P01'].includes(response.error.code || '')) throw setupError()
    if (response.error.code === '42501' || response.error.code === 'PGRST301'
      || response.error.message?.includes('ACCOUNT_USER_CHANGED')) throw sessionError()
    throw connectionError()
  }
  return parseLeaderboard(response.data, direction)
}
