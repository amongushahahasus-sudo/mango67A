import { supabase } from './supabase'
import { parseSavedState, type SavedState } from './practiceState'

export interface CloudRecord { state: SavedState; revision: number; updatedAt: string }
export class ConflictError extends Error {
  constructor() { super('別の端末で口座が更新されました。保存するデータを選んでください。'); this.name = 'ConflictError' }
}
export class SessionChangedError extends Error {
  constructor() { super('ログイン中のアカウントが変わりました。もう一度開き直してください。'); this.name = 'SessionChangedError' }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function client() {
  if (!supabase) throw new Error('アカウントへの接続を利用できません。')
  return supabase
}
async function assertSession(expectedUserId: string) {
  if (!UUID.test(expectedUserId)) throw new SessionChangedError()
  const { data, error } = await client().auth.getSession()
  if (error || !data.session || data.session.user.id !== expectedUserId) throw new SessionChangedError()
}
function fail(error: { code?: string; message?: string }): never {
  if (error.message?.includes('ACCOUNT_CONFLICT')) throw new ConflictError()
  if (error.message?.includes('ACCOUNT_USER_CHANGED') || error.code === '42501' || error.code === 'PGRST301') throw new SessionChangedError()
  if (error.message?.includes('ACCOUNT_STATE_TOO_LARGE')) throw new Error('保存するデータ量が上限を超えています。取引履歴をCSVに保存してから、練習のリセットをご検討ください。')
  throw new Error('クラウド保存に接続できませんでした。通信を確認して再試行してください。')
}
function parseRecord(value: unknown): CloudRecord {
  if (!value || typeof value !== 'object') throw new Error('保存済みの口座データを読み込めませんでした。')
  const row = value as Record<string, unknown>
  const state = parseSavedState(row.state)
  const revision = Number(row.revision)
  if (!state || !Number.isSafeInteger(revision) || revision < 1 || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) throw new Error('保存済みの口座データを読み込めませんでした。')
  return { state, revision, updatedAt: row.updated_at }
}

/** Both the local session check and the RLS query are pinned to the expected user. */
export async function loadCloudAccount(expectedUserId: string): Promise<CloudRecord | null> {
  await assertSession(expectedUserId)
  const { data, error } = await client().from('practice_accounts').select('state,revision,updated_at').eq('user_id', expectedUserId).abortSignal(AbortSignal.timeout(15_000)).maybeSingle()
  if (error) fail(error)
  await assertSession(expectedUserId)
  return data ? parseRecord(data) : null
}

/** The RPC independently checks expectedUserId against its verified auth.uid(). */
export async function saveCloudAccount(state: SavedState, expectedRevision: number | null, expectedUserId: string): Promise<CloudRecord> {
  await assertSession(expectedUserId)
  if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw new ConflictError()
  if (!parseSavedState(state)) throw new Error('口座データの形式を確認できないため、保存を中断しました。')
  if (new TextEncoder().encode(JSON.stringify(state)).byteLength > 3 * 1024 * 1024) throw new Error('保存するデータ量が上限を超えています。取引履歴をCSVに保存してから、練習のリセットをご検討ください。')
  const { data, error } = await client().rpc('save_practice_account', { p_state: state, p_expected_revision: expectedRevision, p_expected_user_id: expectedUserId }).abortSignal(AbortSignal.timeout(20_000))
  if (error) fail(error)
  await assertSession(expectedUserId)
  const row: unknown = Array.isArray(data) ? data[0] : data
  return parseRecord(row)
}
