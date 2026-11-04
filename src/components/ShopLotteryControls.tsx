import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ChevronDown, LoaderCircle, Ticket } from 'lucide-react'
import { loadPhotoShop, PhotoShopError, PHOTO_MAX_PRICE, type ShopPhoto, type ShopSnapshot } from '../lib/photoShop'
import { configureShopLottery, drawShopLottery, loadShopLotteryEntry, type LotteryEntry } from '../lib/shopLottery'
import './ShopLotteryControls.css'

interface PendingDraw { requestId: string; revision: number }
interface BuyerProps {
  product: ShopPhoto
  userId: string | null
  availableProfit?: number
  onBeforeSpend?: () => Promise<void>
  onSnapshot: (snapshot: ShopSnapshot) => void
}
interface AdminProps { product: ShopPhoto; userId: string; onSnapshot: (snapshot: ShopSnapshot) => void; ready?: boolean }

const amount = (value: number) => `${value.toLocaleString('ja-JP')} 仮想円`
const chance = (bps: number) => `${(bps / 100).toLocaleString('ja-JP', { maximumFractionDigits: 2 })}%`
const storageKey = (uid: string, productId: string) => `mango-fx-lottery-request-v1:${uid}:${productId}`
const storageMessage = '申込情報を端末に保存できません。ブラウザの保存設定を確認してから、ショップを開き直してください。安全に結果を確認できるまで、新しいくじは引けません。'
const messageOf = (reason: unknown) => reason instanceof Error ? reason.message : '通信を確認して、もう一度お試しください。'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function readPending(key: string): PendingDraw | null {
  const raw = localStorage.getItem(key)
  if (raw === null) return null
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') throw new Error(storageMessage)
  const p = parsed as Record<string, unknown>
  if (typeof p.requestId !== 'string' || !UUID.test(p.requestId) || !Number.isSafeInteger(p.revision) || Number(p.revision) < 1) throw new Error(storageMessage)
  return { requestId: p.requestId, revision: Number(p.revision) }
}

function persistPending(key: string, pending: PendingDraw) {
  localStorage.setItem(key, JSON.stringify(pending))
  if (readPending(key)?.requestId !== pending.requestId) throw new Error(storageMessage)
}

function clearPending(key: string, pending: PendingDraw) {
  if (readPending(key)?.requestId === pending.requestId) localStorage.removeItem(key)
  if (readPending(key)?.requestId === pending.requestId) throw new Error(storageMessage)
}

function isDefiniteRejection(reason: unknown) {
  return reason instanceof PhotoShopError && !['connection', 'session_changed', 'setup'].includes(reason.code)
}

export function ShopLotteryPanel({ product, userId, availableProfit, onBeforeSpend, onSnapshot }: BuyerProps) {
  const scope = `${userId ?? 'guest'}:${product.id}`
  const identity = useRef(scope)
  identity.current = scope
  const epoch = useRef(0)
  const lock = useRef(false)
  const snapshotCallback = useRef(onSnapshot)
  snapshotCallback.current = onSnapshot
  const beforeSpend = useRef(onBeforeSpend)
  beforeSpend.current = onBeforeSpend
  const [pending, setPending] = useState<PendingDraw | null>(null)
  const [result, setResult] = useState<LotteryEntry | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [storageBlocked, setStorageBlocked] = useState(false)
  const [initializing, setInitializing] = useState(true)
  const [loadedScope, setLoadedScope] = useState(scope)
  const current = (version: number, expectedScope: string) => epoch.current === version && identity.current === expectedScope

  useEffect(() => {
    const version = ++epoch.current
    lock.current = true
    setLoadedScope(scope); setPending(null); setResult(null); setBusy(false); setError(''); setStorageBlocked(false); setInitializing(true)
    if (!userId) { lock.current = false; setInitializing(false); return () => { epoch.current += 1 } }
    const key = storageKey(userId, product.id)
    void (async () => {
      let saved: PendingDraw | null
      try { saved = readPending(key) } catch {
        if (current(version, scope)) { setStorageBlocked(true); setError(storageMessage) }
        return
      }
      if (!saved || !current(version, scope)) return
      setPending(saved)
      try {
        const entry = await loadShopLotteryEntry(product.id, saved.requestId, userId)
        if (!current(version, scope) || !entry) return
        try { clearPending(key, saved); setPending(null) } catch { setStorageBlocked(true); setError(storageMessage) }
        setResult(entry)
        try {
          const next = await loadPhotoShop(userId)
          if (current(version, scope)) snapshotCallback.current(next)
        } catch {
          if (current(version, scope)) setError('前のくじの結果は確認できました。最新の残高を表示するには、ショップの「更新」を押してください。')
        }
      } catch (reason) {
        if (current(version, scope)) setError(`前の申込が残っています。${messageOf(reason)} 同じ申込の結果を確認してください。`)
      }
    })().finally(() => {
      if (current(version, scope)) { lock.current = false; setInitializing(false) }
    })
    return () => { epoch.current += 1 }
  }, [scope, userId, product.id])

  const draw = async () => {
    if (!userId || lock.current || initializing || storageBlocked || loadedScope !== scope) return
    const version = epoch.current, expectedScope = scope, key = storageKey(userId, product.id)
    let saved: PendingDraw | null
    try { saved = readPending(key) } catch { setStorageBlocked(true); setError(storageMessage); return }
    if (saved && saved.requestId !== pending?.requestId) {
      setPending(saved); setError('前の申込が残っています。「前のくじの結果を確認」から、同じ申込の結果を確認してください。'); return
    }
    // A different tab may have cleared storage after resolving this same draw.
    // The visible retry action must still resolve its original ID, never create a new draw.
    if (!saved && pending) {
      try { persistPending(key, pending); saved = pending } catch { setStorageBlocked(true); setError(storageMessage); return }
    }
    let fresh = false
    if (!saved) {
      if (!product.lottery?.enabled || !product.published || product.stockRemaining !== 1) return
      try {
        saved = { requestId: crypto.randomUUID(), revision: product.lottery.revision }
        persistPending(key, saved)
        fresh = true
      } catch { setStorageBlocked(true); setError(storageMessage); return }
    }
    const request = saved
    lock.current = true; setBusy(true); setPending(request); setResult(null); setError('')
    let sent = false
    try {
      await beforeSpend.current?.()
      if (!current(version, expectedScope)) return
      sent = true
      const response = await drawShopLottery(product.id, request.revision, request.requestId, userId)
      if (!current(version, expectedScope)) return
      try { clearPending(key, request); setPending(null) } catch { setStorageBlocked(true); setError(storageMessage) }
      setResult(response.entry)
      snapshotCallback.current(response.shop)
    } catch (reason) {
      if (!current(version, expectedScope)) return
      const definite = (fresh && !sent) || (sent && isDefiniteRejection(reason))
      if (definite) {
        try { clearPending(key, request); setPending(null) } catch { setStorageBlocked(true); setError(storageMessage); return }
        setError(messageOf(reason))
        if (sent) {
          try {
            const next = await loadPhotoShop(userId)
            if (current(version, expectedScope)) snapshotCallback.current(next)
          } catch { /* Keep the explicit failure visible; the shop also has a refresh control. */ }
        }
      } else {
        setError(`結果を確認できていません。${messageOf(reason)} 「前のくじの結果を確認」では同じ申込を使い、二重に消費しません。`)
      }
    } finally {
      if (current(version, expectedScope)) { lock.current = false; setBusy(false) }
    }
  }

  const config = product.lottery
  const visiblePending = loadedScope === scope ? pending : null
  const visibleResult = loadedScope === scope ? result : null
  const visibleError = loadedScope === scope ? error : ''
  const checking = initializing || loadedScope !== scope
  const insufficient = availableProfit !== undefined && config !== null && availableProfit < config.entryCost
  const unavailable = !config?.enabled || !product.published || product.stockRemaining !== 1
  const disabled = !userId || busy || checking || storageBlocked || (!visiblePending && (unavailable || insufficient))
  return <section className="shop-lottery-panel" aria-label="商品くじ" aria-busy={busy || checking}>
    <div className="shop-lottery-heading"><Ticket size={17} aria-hidden="true" /><h3>ごほうびくじ</h3></div>
    {config ? <dl className="shop-lottery-terms"><div><dt>1回に使う仮想利益</dt><dd>{amount(config.entryCost)}</dd></div><div><dt>当選確率</dt><dd>{chance(config.winRateBps)}</dd></div></dl>
      : <p className="shop-lottery-note">このくじは準備中です。</p>}
    <p className="shop-lottery-disclosure">はずれでも仮想利益を消費します。</p>
    <p className="shop-lottery-note">当選後は管理者確認後に受け渡します。ファイルは1点限りです。管理者が受け渡しを見送った場合は、当選した回の消費額をお返しします。</p>
    {visibleResult && <div className={`shop-lottery-result ${visibleResult.outcome === 'win' ? 'shop-lottery-result-win' : ''}`} role="status">
      <strong>{visibleResult.outcome === 'win' ? '当選しました' : '今回ははずれでした'}</strong>
      <p>{visibleResult.refunded ? `${amount(visibleResult.cost)}は返却済みです。` : `${amount(visibleResult.cost)}を消費しました。`}</p>
      {visibleResult.outcome === 'win' && !visibleResult.refunded && <p>管理者の確認後、購入済みの商品からファイルを受け取れます。</p>}
    </div>}
    {visiblePending && <p className="shop-lottery-retry-note">前の申込の結果を確認します。新しい申込にはならず、同じ申込で二重に消費しません。未処理の場合は、元の条件が有効な場合に抽選します。</p>}
    {!userId && <p className="shop-lottery-note">くじを引くにはログインしてください。</p>}
    {!visiblePending && userId && config && (unavailable ? <p className="shop-lottery-note">{product.stockRemaining === 0 ? 'このくじの受け付けは終了しています。' : 'このくじは現在お休み中です。'}</p>
      : insufficient ? <p className="shop-lottery-note">くじに使える仮想利益が足りません。</p> : null)}
    {visibleError && <p className="photo-error shop-lottery-error" role="alert">{visibleError}</p>}
    <button type="button" className="photo-primary shop-lottery-draw" disabled={disabled} onClick={() => { void draw() }}>
      {(busy || checking) && <LoaderCircle className="photo-spinner" size={16} aria-hidden="true" />}
      {checking ? '申込情報を確認中…' : busy ? 'くじの結果を確認中…' : visiblePending ? '前のくじの結果を確認' : config ? `${amount(config.entryCost)}でくじを引く` : 'くじは準備中です'}
    </button>
  </section>
}

export function AdminLotterySettings({ product, userId, onSnapshot, ready = true }: AdminProps) {
  const [open, setOpen] = useState(false)
  const [fee, setFee] = useState(String(product.lottery?.entryCost ?? product.price))
  const [probability, setProbability] = useState(String((product.lottery?.winRateBps ?? 1000) / 100))
  const [enabled, setEnabled] = useState(product.lottery?.enabled ?? false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const scope = `${userId}:${product.id}`
  const identity = useRef(scope)
  identity.current = scope
  const epoch = useRef(0)
  const lock = useRef(false)
  const callback = useRef(onSnapshot)
  callback.current = onSnapshot
  const formId = useId()
  const configRevision = product.lottery?.revision ?? null
  const expectedRevision = useRef(configRevision)
  const current = (version: number) => epoch.current === version && identity.current === scope

  useEffect(() => {
    epoch.current += 1; lock.current = false
    setOpen(false); setBusy(false); setError(''); setSuccess('')
    return () => { epoch.current += 1 }
  }, [scope])

  useEffect(() => {
    setFee(String(product.lottery?.entryCost ?? product.price))
    setProbability(String((product.lottery?.winRateBps ?? 1000) / 100))
    setEnabled(product.lottery?.enabled ?? false)
    expectedRevision.current = configRevision
  }, [scope, configRevision, product.price, product.lottery?.entryCost, product.lottery?.winRateBps, product.lottery?.enabled])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (lock.current || !ready) return
    const entryCost = Number(fee), parsedChance = Number(probability), winRateBps = Math.round(parsedChance * 100)
    if (!/^\d+$/.test(fee) || !Number.isSafeInteger(entryCost) || entryCost < 1 || entryCost > PHOTO_MAX_PRICE) { setError('1回に使う仮想利益は、1〜100,000,000の整数で入力してください。'); return }
    if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(probability) || !Number.isFinite(parsedChance) || winRateBps < 1 || winRateBps > 10000) { setError('当選確率は、0.01〜100%の範囲で小数点以下2桁まで入力してください。'); return }
    const version = epoch.current, revision = expectedRevision.current
    lock.current = true; setBusy(true); setError(''); setSuccess('')
    try {
      const next = await configureShopLottery(product.id, { entryCost, winRateBps, enabled }, revision, userId)
      if (!current(version)) return
      setSuccess('くじ設定を保存しました。')
      callback.current(next)
    } catch (reason) {
      if (!current(version)) return
      setError(messageOf(reason))
      if (reason instanceof PhotoShopError && ['lottery_conflict', 'lottery_changed', 'out_of_stock'].includes(reason.code)) {
        try { const next = await loadPhotoShop(userId); if (current(version)) callback.current(next) } catch { /* The parent shop provides refresh. */ }
      }
    } finally {
      if (current(version)) { lock.current = false; setBusy(false) }
    }
  }

  if (product.kind !== 'file') return null
  return <section className="shop-lottery-settings" aria-label={`${product.title}のくじ設定`}>
    <button type="button" className="shop-lottery-toggle" aria-expanded={open} aria-controls={formId} disabled={busy || !ready} onClick={() => { setOpen(!open); setError(''); setSuccess('') }}>
      <Ticket size={15} aria-hidden="true" />{product.lottery ? 'くじ設定を編集' : 'くじ販売を設定'}<ChevronDown size={15} aria-hidden="true" />
    </button>
    {!ready && <p className="shop-lottery-note">くじ販売は準備中です。設定の準備が整うと利用できます。</p>}
    {open && <form id={formId} className="shop-lottery-form" onSubmit={event => { void submit(event) }} aria-busy={busy}>
      <p className="shop-lottery-note">ファイル1点をくじで販売します。当選後は管理者の承認が必要です。くじに変更した商品は、チェックを外すと受け付けを休止できます。</p>
      {product.stockRemaining === 0 && <p className="shop-lottery-retry-note">このファイルは申請中、または受け渡し済みです。設定を保存しても在庫は増えません。</p>}
      <label>1回に使う仮想利益<input type="number" inputMode="numeric" min="1" max={PHOTO_MAX_PRICE} step="1" value={fee} onChange={event => setFee(event.target.value)} disabled={busy} required /></label>
      <label>当選確率（%）<input type="number" inputMode="decimal" min="0.01" max="100" step="0.01" value={probability} onChange={event => setProbability(event.target.value)} disabled={busy} required /></label>
      <label className="shop-lottery-enabled"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={busy} />くじを有効にする</label>
      <p className="shop-lottery-note">はずれでも設定した仮想利益を消費します。当選確率と消費額は、くじを引く前に表示されます。</p>
      {error && <p className="photo-error shop-lottery-error" role="alert">{error}</p>}
      {success && <p className="shop-lottery-saved" role="status">{success}</p>}
      <button className="photo-primary" type="submit" disabled={busy || !ready}>{busy && <LoaderCircle className="photo-spinner" size={15} aria-hidden="true" />}{busy ? '保存中…' : 'くじ設定を保存'}</button>
    </form>}
  </section>
}
