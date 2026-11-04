import { useCallback, useEffect, useRef, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { Cloud, CloudOff, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react'
import App from '../App'
import AccountMenu from '../components/AccountMenu'
import AccountWorkspaceLock from './AccountWorkspaceLock'
import { useAuth } from './AuthProvider'
import { ConflictError, loadCloudAccount, saveCloudAccount } from '../lib/cloudAccount'
import type { CloudRecord } from '../lib/cloudAccount'
import { createSavedState, GUEST_STORAGE_KEY, hasPracticeProgress, readSavedState, userStorageKey } from '../lib/practiceState'
import type { SavedState } from '../lib/practiceState'
import './AccountWorkspace.css'

type SyncStatus = 'loading' | 'saved' | 'saving' | 'offline' | 'error' | 'conflict'
type Metadata = { revision: number | null; known: boolean; dirty: boolean; updatedAt: string | null }
type Runtime = Metadata & { latest: SavedState | null; writable: boolean; blocked: boolean; disposed: boolean; generation: number; importantGeneration: number; savedImportantGeneration: number; inFlight: Promise<void> | null; fetchId: number; timer: ReturnType<typeof setTimeout> | null }
const blankMeta: Metadata = { revision: null, known: false, dirty: false, updatedAt: null }
function readMetadata(key: string): Metadata {
  try {
    const value = JSON.parse(localStorage.getItem(key + ':sync') || 'null') as Metadata | null
    if (value && typeof value.known === 'boolean' && typeof value.dirty === 'boolean' && (value.revision === null || Number.isSafeInteger(value.revision) && value.revision > 0) && (value.updatedAt === null || typeof value.updatedAt === 'string')) return value
  } catch { /* Treat incomplete local metadata conservatively. */ }
  return { ...blankMeta }
}
function nameOf(user: User): string {
  const value = user.user_metadata?.display_name || user.user_metadata?.full_name
  return typeof value === 'string' && value.trim() ? value.trim().slice(0,40) : user.email?.split('@')[0] || 'マイアカウント'
}
function importantChange(a: SavedState | null, b: SavedState): boolean {
  return !a || a.account !== b.account || a.pair !== b.pair || a.scenario !== b.scenario || a.timeframe !== b.timeframe || a.speed !== b.speed || a.paused !== b.paused
}
function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'クラウドに接続できませんでした。通信を確認して、もう一度お試しください。'
}

export default function AccountWorkspace() {
  const { user, loading, configured } = useAuth()
  const [signInRequest, setSignInRequest] = useState(0)
  if (loading) return <WorkspaceScreen title="ログイン状態を確認しています" />
  if (!user) return <App key="guest" accountControl={configured ? <AccountMenu signInRequest={signInRequest} /> : undefined} onRequestLogin={configured ? () => setSignInRequest(value => value + 1) : undefined} />
  return <AccountWorkspaceLock key={user.id} userId={user.id}><PersonalWorkspace user={user} /></AccountWorkspaceLock>
}

function PersonalWorkspace({ user }: { user: User }) {
  const key = userStorageKey(user.id)
  const [initialState, setInitialState] = useState<SavedState | null>(null)
  const [epoch, setEpoch] = useState(0)
  const [status, setStatus] = useState<SyncStatus>('loading')
  const [message, setMessage] = useState('')
  const [lastSaved, setLastSaved] = useState<string | null>(null)
  const [chooseGuest, setChooseGuest] = useState(false)
  const [conflict, setConflict] = useState<CloudRecord | null | undefined>(undefined)
  const [working, setWorking] = useState(false)
  const [storageIssue, setStorageIssue] = useState(false)
  const runtime = useRef<Runtime | null>(null)
  if (!runtime.current) {
    const cached = readSavedState(key), metadata = readMetadata(key)
    runtime.current = { ...metadata, dirty: Boolean(cached && (metadata.dirty || !metadata.known)), latest: cached, writable: false, blocked: false, disposed: false, generation: 0, importantGeneration: cached && (metadata.dirty || !metadata.known) ? 1 : 0, savedImportantGeneration: 0, inFlight: null, fetchId: 0, timer: null }
  }
  const operations = useRef<{ flush: () => Promise<void>; refresh: () => Promise<void> }>({ flush: async () => {}, refresh: async () => {} })
  const persist = useCallback(() => {
    const r = runtime.current!
    if (r.disposed) return
    try {
      // Metadata is namespaced to this verified auth identity, never to a guest.
      const metadata: Metadata = { revision:r.revision,known:r.known,dirty:r.dirty,updatedAt:r.updatedAt }
      localStorage.setItem(key + ':sync', JSON.stringify(metadata))
      setStorageIssue(false)
    } catch { setStorageIssue(true) }
  }, [key])
  const accept = useCallback((state: SavedState, record: CloudRecord | null, dirty: boolean) => {
    const r = runtime.current!
    if (r.disposed) return
    r.latest = state; r.revision = record?.revision ?? null; r.known = true; r.writable = true; r.blocked = false; r.dirty = dirty; r.updatedAt = record?.updatedAt ?? null; r.generation += 1; r.importantGeneration += 1
    if (!dirty) r.savedImportantGeneration = r.importantGeneration
    try { localStorage.setItem(key, JSON.stringify(state)) } catch { setStorageIssue(true) }
    persist()
    setInitialState(state); setEpoch(value => value+1); setChooseGuest(false); setConflict(undefined); setMessage(''); setLastSaved(r.updatedAt); setStatus(record ? 'saved' : 'saving')
    if (dirty) {
      if (r.timer) clearTimeout(r.timer)
      r.timer = setTimeout(() => { r.timer = null; void operations.current.flush().catch(() => {}) }, 500)
    }
  }, [key,persist])

  const refresh = useCallback(async () => {
    const r = runtime.current!
    if (r.disposed || r.inFlight) return
    const fetchId = ++r.fetchId
    r.writable = false
    if (!navigator.onLine) {
      setStatus('offline'); setMessage('通信が戻るまで、この端末に保存した練習を利用します。')
      if (r.latest && !initialState) { setInitialState(r.latest); setEpoch(v=>v+1) }
      return
    }
    try {
      const record = await loadCloudAccount(user.id)
      if (r.disposed || fetchId !== r.fetchId) return
      const local = r.latest
      if (record) {
        if (local && r.dirty) {
          if (r.known && r.revision === record.revision) {
            r.writable = true; r.blocked = false; setConflict(undefined); setStatus('saved'); setMessage(''); setLastSaved(record.updatedAt)
            if (!initialState) { setInitialState(local); setEpoch(v=>v+1) }
            void operations.current.flush().catch(() => {})
          } else {
            r.blocked = true; setConflict(record); setStatus('conflict'); setMessage('別の端末にも新しい練習データがあります。どちらを使うか選んでください。')
            if (!initialState) { setInitialState(local); setEpoch(v=>v+1) }
          }
        } else accept(record.state, record, false)
      } else if (local) {
        if (r.known && r.revision !== null) {
          r.blocked = true; setConflict(null); setStatus('conflict'); setMessage('クラウドの口座が見つかりません。この端末の練習を復元するか、新しい口座を作るか選んでください。')
          if (!initialState) { setInitialState(local); setEpoch(v=>v+1) }
        } else accept(local, null, true)
      } else if (hasPracticeProgress(readSavedState(GUEST_STORAGE_KEY))) {
        r.revision = null; r.known = true; r.writable = false; r.blocked = true
        setChooseGuest(true); setStatus('loading'); setMessage('')
      } else accept(createSavedState(), null, true)
    } catch (error) {
      if (r.disposed || fetchId !== r.fetchId) return
      r.writable = false
      setStatus(navigator.onLine ? 'error' : 'offline'); setMessage(errorText(error))
      if (r.latest && !initialState) { setInitialState(r.latest); setEpoch(v=>v+1) }
    }
  }, [user.id,accept,initialState])
  const flush = useCallback(async () => {
    const r = runtime.current!
    if (r.disposed) throw new Error('アカウントが切り替わりました。')
    if (r.inFlight) {
      const requiredImportant = r.importantGeneration
      await r.inFlight
      if (!r.disposed && r.savedImportantGeneration < requiredImportant) await operations.current.flush()
      return
    }
    if (!r.dirty || !r.latest) return
    if (r.blocked || !r.writable || !r.known) throw new Error('クラウドとの確認が必要です。未同期の練習データは、この端末に残っています。')
    if (!navigator.onLine) { setStatus('offline'); throw new Error('オフラインです。未同期の練習データは、この端末に残っています。') }
    const snapshot = r.latest, generation = r.generation, importantGeneration = r.importantGeneration, revision = r.revision, fetchId = r.fetchId
    if (r.timer) { clearTimeout(r.timer); r.timer = null }
    setStatus('saving')
    const operation = (async () => {
      try {
        const record = await saveCloudAccount(snapshot, revision, user.id)
        if (r.disposed || fetchId !== r.fetchId) return
        r.revision = record.revision; r.updatedAt = record.updatedAt; r.known = true; r.dirty = r.generation !== generation; r.savedImportantGeneration = Math.max(r.savedImportantGeneration, importantGeneration)
        persist(); setStatus('saved'); setMessage(''); setLastSaved(record.updatedAt)
      } catch (error) {
        if (r.disposed) return
        r.dirty = true; persist()
        if (error instanceof ConflictError) {
          r.writable = false; r.blocked = true; setStatus('conflict'); setMessage('別の端末で口座が更新されました。自動では上書きせず、この端末の練習を保持しています。')
          // Retrieve a candidate only; explicit user choice is required before writing.
          try { const record = await loadCloudAccount(user.id); if (!r.disposed) setConflict(record) }
          catch { if (!r.disposed) setConflict(undefined) }
        } else { r.writable = false; setStatus(navigator.onLine ? 'error' : 'offline'); setMessage(errorText(error)) }
        throw error
      }
    })()
    r.inFlight = operation
    try { await operation } finally {
      if (r.inFlight === operation) r.inFlight = null
      // A business change queued during a slow save needs a follow-up; price
      // ticks alone never create a rapid continuous save loop.
      if (!r.disposed && r.writable && !r.blocked && r.importantGeneration > r.savedImportantGeneration) {
        if (r.timer) clearTimeout(r.timer)
        r.timer = setTimeout(() => { r.timer = null; void operations.current.flush().catch(() => {}) }, 1000)
      }
    }
  }, [user.id,persist])
  operations.current = { flush, refresh }

  const changed = useCallback((state: SavedState) => {
    const r = runtime.current!
    if (r.disposed || state === r.latest) return
    const important = importantChange(r.latest,state)
    r.latest = state; r.dirty = true; r.generation += 1
    if (important) r.importantGeneration += 1
    persist()
    if (important && r.writable && !r.blocked) {
      if (r.timer) clearTimeout(r.timer)
      r.timer = setTimeout(() => { r.timer = null; void operations.current.flush().catch(() => {}) },1000)
    }
  }, [persist])

  useEffect(() => {
    const r = runtime.current!
    r.disposed = false
    void operations.current.refresh()
    const minute = setInterval(() => { void operations.current.flush().catch(() => {}) },60_000)
    const online = () => { void operations.current.refresh() }
    const offline = () => { if (!r.disposed) setStatus('offline') }
    const visibility = () => { if (document.visibilityState === 'hidden') void operations.current.flush().catch(() => {}) }
    window.addEventListener('online',online); window.addEventListener('offline',offline); document.addEventListener('visibilitychange',visibility)
    return () => {
      // Never flush an old identity after auth has changed; RPC also checks owner ID.
      r.disposed = true; r.fetchId += 1; r.writable = false
      if (r.timer) clearTimeout(r.timer)
      clearInterval(minute); window.removeEventListener('online',online); window.removeEventListener('offline',offline); document.removeEventListener('visibilitychange',visibility)
    }
  }, [user.id])

  const beforeSignOut = useCallback(async () => {
    const r = runtime.current!
    if (r.timer) clearTimeout(r.timer)
    const requiredImportant = r.importantGeneration
    await operations.current.flush()
    if (!r.disposed && r.savedImportantGeneration < requiredImportant) await operations.current.flush()
    // Preserve all unsaved updates locally even if prices advanced during the request.
    persist()
  },[persist])
  const beforePhotoPurchase = useCallback(async () => {
    const r = runtime.current!
    if (r.disposed || r.blocked || !r.known || !r.writable) throw new Error('購入の前にクラウドとの同期を完了してください。')
    if (!navigator.onLine) throw new Error('写真の購入にはオンライン接続が必要です。')
    await beforeSignOut()
    if (r.disposed || r.blocked || !r.writable) throw new Error('口座の状態が変わりました。再接続してから購入してください。')
    if (r.savedImportantGeneration < r.importantGeneration) await operations.current.flush()
  }, [beforeSignOut])
  const choose = async (which: 'cloud' | 'local') => {
    const r = runtime.current!
    if (r.disposed || working) return
    setWorking(true)
    try {
      // Refresh before a replacement so acceptance never bypasses compare-and-swap.
      const remote = await loadCloudAccount(user.id)
      if (r.disposed) return
      if (which === 'cloud') { accept(remote?.state ?? createSavedState(),remote,!remote); return }
      const local = r.latest
      if (!local) throw new Error('この端末に保存された練習がありません。')
      r.revision = remote?.revision ?? null; r.known = true; r.writable = true; r.blocked = false; r.dirty = true; r.importantGeneration += 1
      setConflict(undefined); setMessage(''); persist()
      await operations.current.flush()
    } catch (error) { if (!r.disposed) setMessage(errorText(error)) }
    finally { if (!r.disposed) setWorking(false) }
  }
  const migrate = (importGuest: boolean) => {
    const guest = importGuest ? readSavedState(GUEST_STORAGE_KEY) : null
    accept(guest ?? createSavedState(),null,true)
  }
  const label = status === 'saving' ? 'クラウドに保存中' : status === 'offline' ? 'オフライン · この端末に保存' : status === 'conflict' ? '同期の確認が必要です' : status === 'error' ? '未同期 · この端末に保存' : lastSaved ? `最終同期 ${new Date(lastSaved).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tokyo'})}` : 'クラウドと接続しています'
  const control = <AccountMenu syncLabel={label} onBeforeSignOut={beforeSignOut} />
  const notice = <>
    {(status === 'error' || status === 'offline' || status === 'conflict' || storageIssue) && <div className={`workspace-sync-note ${status==='conflict'?'workspace-sync-conflict':''}`} role="status"><CloudOff size={17}/><div><strong>{status==='conflict'?'ほかの端末のデータを確認してください':status==='offline'?'オフラインで練習中です':storageIssue?'端末への保存ができません':'クラウドへの同期を再開できませんでした'}</strong><p>{message || (storageIssue?'ブラウザの保存容量を確認してください。':'この端末のデータを保持しています。通信が戻ったら同期を再開します。')}</p></div><button onClick={()=>void operations.current.refresh()} disabled={working}><RefreshCw size={14}/>再接続</button></div>}
    {status === 'conflict' && conflict !== undefined && <div className="workspace-choice-inline"><button onClick={()=>void choose('cloud')} disabled={working}>クラウドのデータを使う</button><button onClick={()=>void choose('local')} disabled={working}>この端末の練習を保存する</button><span>選んだデータで口座を引き継ぎます。上書き前に最新の版を確認します。</span></div>}
  </>
  if (!initialState) return <WorkspaceScreen title={chooseGuest?'最初の口座を選んでください':status==='loading'?'あなたの口座を読み込んでいます':'口座を読み込めませんでした'} message={message} controls={control}>
    {chooseGuest ? <div className="workspace-start-choice"><p>このブラウザにはゲストの練習データがあります。自分の練習であれば、個人口座へ引き継げます。ゲストのデータはそのまま残ります。</p><button onClick={()=>migrate(true)}><Cloud size={17}/>この端末の練習を引き継ぐ</button><button className="workspace-secondary" onClick={()=>migrate(false)}>仮想資金100万円から始める</button></div> : status!=='loading' ? <button className="workspace-retry" onClick={()=>void operations.current.refresh()}><RefreshCw size={16}/>もう一度読み込む</button> : null}
  </WorkspaceScreen>
  return <App key={epoch} initialState={initialState} storageKey={key} onStateChange={changed} accountControl={control} accountStatus={label} accountNotice={notice} userLabel={nameOf(user)} onBeforePhotoPurchase={beforePhotoPurchase} />
}

function WorkspaceScreen({title,message,controls,children}:{title:string;message?:string;controls?:React.ReactNode;children?:React.ReactNode}) {
  return <main className="workspace-loading"><header><a href="#" aria-label="MANGO FX">MANGO <span>FX</span></a>{controls}</header><section><div className="workspace-loading-mark">{children ? <ShieldCheck size={30}/> : <LoaderCircle size={30}/>}</div><h1>{title}</h1>{message ? <p role="alert">{message}</p> : !children ? <p>保存された口座を確認しています。</p> : null}{children}</section></main>
}
