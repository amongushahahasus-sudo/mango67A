import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDownToLine, Check, CheckCircle2, Clock3, Coins, FileText, ImagePlus, Images, LoaderCircle, LockKeyhole, Package, Pencil, RefreshCw, ShieldCheck, ShoppingBag, Upload, X } from 'lucide-react'
import { downloadPhoto, loadPhotoShop, PhotoShopError, previewUrl, purchasePhoto, reviewShopOrder, SetupRequiredError, updatePhoto, uploadPhoto, type ShopPhoto, type ShopRole, type ShopSnapshot } from '../lib/photoShop'
import './PhotoShop.css'
import ProtectedPhotoPreview from './ProtectedPhotoPreview'
import { AdminLotterySettings, ShopLotteryPanel } from './ShopLotteryControls'

interface PhotoShopProps {
  mode: 'shop' | 'admin'
  userId: string | null
  onBeforePurchase?: () => Promise<void>
  onRequestLogin?: () => void
  onRoleChange?: (role: ShopRole) => void
}
interface PhotoDraft { kind: 'photo' | 'file'; title: string; description: string; price: string; published: boolean }
const emptyDraft = (): PhotoDraft => ({ kind: 'photo', title: '', description: '', price: '1000', published: true })
const amount = (value: number) => `${Math.floor(value).toLocaleString('ja-JP')} 仮想円`
const messageOf = (reason: unknown) => reason instanceof Error ? reason.message : '操作を完了できませんでした。通信を確認して、もう一度お試しください。'
const isAdmin = (role: ShopRole | undefined) => role === 'developer' || role === 'admin'

export default function PhotoShop({ mode, userId, onBeforePurchase, onRequestLogin, onRoleChange }: PhotoShopProps) {
  const [snapshot, setSnapshot] = useState<ShopSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [preparing, setPreparing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [syncWarning, setSyncWarning] = useState('')
  const [success, setSuccess] = useState('')
  const [filter, setFilter] = useState<'all' | 'owned'>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<PhotoDraft>(emptyDraft)
  const [file, setFile] = useState<File | null>(null)
  const [orderFilter, setOrderFilter] = useState<'pending' | 'all'>('pending')
  const [reviewingOrder, setReviewingOrder] = useState<{ id: string; decision: 'approve' | 'reject' } | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const identity = useRef(userId)
  identity.current = userId
  const active = useRef(true)
  const epoch = useRef(0)
  const request = useRef(0)
  const actionLock = useRef(false)
  const beforePurchase = useRef(onBeforePurchase)
  beforePurchase.current = onBeforePurchase
  const roleChanged = useRef(onRoleChange)
  roleChanged.current = onRoleChange
  const formSection = useRef<HTMLElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const dialogTitle = useId()
  const selected = snapshot?.photos.find(photo => photo.id === selectedId) ?? null
  const editing = snapshot?.photos.find(photo => photo.id === editingId) ?? null
  const authorized = Boolean(userId && isAdmin(snapshot?.role))
  const busy = busyAction !== null

  const current = (operationEpoch: number, expectedUser: string | null) => active.current && epoch.current === operationEpoch && identity.current === expectedUser
  const accept = (next: ShopSnapshot) => {
    // A completed purchase or settings change is newer than any catalog reload
    // already in flight, even when the mutation came from the lottery controls.
    request.current += 1
    setLoading(false); setLoadError(''); setPreparing(false)
    setSnapshot(next); roleChanged.current?.(next.role)
  }

  const reload = useCallback(async (syncProfit = true) => {
    const requestId = ++request.current
    const operationEpoch = epoch.current
    const expectedUser = userId
    setLoading(true); setLoadError(''); setPreparing(false)
    if (syncProfit && expectedUser && mode === 'shop' && beforePurchase.current) {
      try {
        await beforePurchase.current()
        if (!current(operationEpoch, expectedUser) || requestId !== request.current) return
        setSyncWarning('')
      } catch {
        if (!current(operationEpoch, expectedUser) || requestId !== request.current) return
        setSyncWarning('最新の利益を同期できませんでした。保存済みの利益を表示しています。購入時にもう一度同期します。')
      }
    }
    try {
      const next = await loadPhotoShop(expectedUser)
      if (!current(operationEpoch, expectedUser) || requestId !== request.current) return
      setSnapshot(next); roleChanged.current?.(next.role)
    } catch (reason) {
      if (!current(operationEpoch, expectedUser) || requestId !== request.current) return
      setSnapshot(null); roleChanged.current?.(null)
      setPreparing(reason instanceof SetupRequiredError)
      setLoadError(messageOf(reason))
    } finally {
      if (current(operationEpoch, expectedUser) && requestId === request.current) setLoading(false)
    }
  }, [userId, mode])

  useEffect(() => {
    active.current = true
    epoch.current += 1
    actionLock.current = false
    setSnapshot(null); setSelectedId(null); setEditingId(null); setDraft(emptyDraft()); setFile(null)
    setActionError(''); setSuccess(''); setSyncWarning(''); setBusyAction(null); setFilter('all'); setReviewingOrder(null); setOrderFilter('pending')
    void reload()
    return () => { active.current = false; epoch.current += 1; request.current += 1 }
  }, [reload])

  useEffect(() => {
    if (!selected) return
    const previous = document.activeElement as HTMLElement | null
    const oldOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setSelectedId(null); return }
      if (event.key !== 'Tab') return
      const nodes = dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]')
      if (!nodes?.length) return
      const first = nodes[0], last = nodes[nodes.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => { document.body.style.overflow = oldOverflow; window.removeEventListener('keydown', onKey); if (previous?.isConnected) previous.focus() }
  }, [Boolean(selected)])

  const run = async (name: string, operation: (operationEpoch: number, expectedUser: string) => Promise<void>) => {
    if (!userId || actionLock.current) return
    const operationEpoch = epoch.current, expectedUser = userId
    actionLock.current = true
    setBusyAction(name); setActionError(''); setSuccess('')
    try { await operation(operationEpoch, expectedUser) }
    catch (reason) {
      if (!current(operationEpoch, expectedUser)) return
      setActionError(messageOf(reason))
      if (reason instanceof PhotoShopError && reason.code === 'price_changed') setSelectedId(null)
      await reload(false)
    } finally {
      if (current(operationEpoch, expectedUser)) { actionLock.current = false; setBusyAction(null) }
    }
  }

  const buy = (photo: ShopPhoto) => {
    if (photo.saleMode === 'lottery') return
    void run(`purchase:${photo.id}`, async (operationEpoch, expectedUser) => {
      await beforePurchase.current?.()
      if (!current(operationEpoch, expectedUser)) return
      const next = await purchasePhoto(photo.id, photo.price, expectedUser)
      if (!current(operationEpoch, expectedUser)) return
      accept(next)
      setSuccess(photo.kind === 'file' ? `「${photo.title}」の購入申請を受け付けました。管理者の確認後にダウンロードできます。` : `「${photo.title}」を購入しました。写真をダウンロードできます。`)
    })
  }

  const download = (photo: ShopPhoto) => void run(`download:${photo.id}`, async (operationEpoch, expectedUser) => {
    await downloadPhoto(photo.id, photo.title, expectedUser)
    if (current(operationEpoch, expectedUser)) setSuccess(`「${photo.title}」のダウンロードを開始しました。`)
  })

  const resetDraft = () => {
    setEditingId(null); setDraft(emptyDraft()); setFile(null)
    if (fileInput.current) fileInput.current.value = ''
  }
  const edit = (photo: ShopPhoto) => {
    setEditingId(photo.id); setDraft({ kind: photo.kind, title: photo.title, description: photo.description, price: String(photo.price), published: photo.published })
    setFile(null); setActionError(''); setSuccess('')
    formSection.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!authorized || busy) return
    const price = editing?.saleMode === 'lottery' ? editing.price : Number(draft.price)
    if (!draft.title.trim() || !Number.isSafeInteger(price) || price < 1 || price > 100_000_000) { setActionError('タイトルと、1〜100,000,000の整数の価格を入力してください。'); return }
    if (!editing && !file) { setActionError(draft.kind === 'file' ? '販売するファイルを選んでください。' : '投稿する写真を選んでください。'); return }
    const fields = { title: draft.title.trim(), description: draft.description.trim(), price, published: draft.published }
    void run(editing ? `save:${editing.id}` : 'upload', async (operationEpoch, expectedUser) => {
      const next = editing ? await updatePhoto(editing, fields, expectedUser) : await uploadPhoto({ ...fields, kind: draft.kind, file: file! }, expectedUser)
      if (!current(operationEpoch, expectedUser)) return
      accept(next); resetDraft()
      setSuccess(editing ? '商品の設定を保存しました。' : fields.published ? '商品を登録して公開しました。' : '商品を下書きとして保存しました。')
    })
  }
  const review = (orderId: string, decision: 'approve' | 'reject') => void run(`review:${orderId}`, async (operationEpoch, expectedUser) => {
    const next = await reviewShopOrder(orderId, decision, expectedUser)
    if (!current(operationEpoch, expectedUser)) return
    accept(next); setReviewingOrder(null)
    setSuccess(decision === 'approve' ? '申請を承認しました。受け取り対象者がファイルをダウンロードできます。' : '申請を却下し、対象の仮想利益と商品の在庫を戻しました。')
  })
  const hasOrder = (photo: ShopPhoto) => photo.purchased || photo.orderId !== null
  const canDownload = (photo: ShopPhoto) => (mode === 'admin' && authorized) || (photo.purchased && photo.deliveryStatus === 'approved')
  const openDetails = (photo: ShopPhoto) => { setSelectedId(photo.id); setActionError(''); setSuccess('') }
  const photos = (snapshot?.photos ?? []).filter(photo => mode === 'admin' || ((photo.published || hasOrder(photo)) && (filter === 'all' || hasOrder(photo))))
  const ownedCount = snapshot?.photos.filter(hasOrder).length ?? 0
  const pendingCount = snapshot?.orders.filter(order => order.status === 'pending').length ?? 0
  const orders = snapshot?.orders.filter(order => orderFilter === 'all' || order.status === 'pending') ?? []
  const date = (value: string) => new Date(value).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' })
  const deliveryLabel = (photo: ShopPhoto) => photo.kind === 'photo' ? '購入済み' : photo.deliveryStatus === 'pending' ? '確認待ち' : photo.deliveryStatus === 'approved' ? '受け取り可能' : photo.deliveryStatus === 'rejected' ? '申請見送り' : photo.stockRemaining === 0 ? '受付終了' : '1点限り'
  const fileVisual = (photo: ShopPhoto, detail = false) => <div className={`shop-file-preview ${detail ? 'shop-file-dialog' : ''}`}><FileText size={detail ? 56 : 43} aria-hidden="true" /><span className="shop-file-type">{photo.fileType?.toUpperCase() ?? 'FILE'}</span><strong>コード・ファイル</strong><small>{photo.saleMode === 'lottery' ? 'くじに当選後、管理者が確認' : '管理者の承認後に受け取り'}</small></div>
  const productPrice = (photo: ShopPhoto) => photo.saleMode === 'lottery' ? photo.lottery?.entryCost ?? photo.price : photo.price
  const lotteryEpoch = epoch.current
  const acceptLotterySnapshot = (next: ShopSnapshot) => { if (current(lotteryEpoch, userId)) accept(next) }

  return <section className="photo-shop" aria-label={mode === 'admin' ? 'ショップ管理' : 'ショップ'}>
    {mode === 'admin' && <div className="shop-admin-toolbar"><h2>ショップ管理</h2><button type="button" className="photo-refresh" disabled={loading || busy} onClick={() => void reload()}><RefreshCw size={14} className={loading ? 'photo-spinner' : ''} />更新</button></div>}

    {loading && !snapshot ? <div className="photo-state"><LoaderCircle size={25} className="photo-spinner" /><h3>商品を読み込んでいます</h3><p>商品と利用できる利益を確認しています。</p></div> : loadError && !snapshot ? <div className="photo-state"><span className="photo-state-mark">{preparing ? <Package size={29} /> : <RefreshCw size={27} />}</span><h3>{preparing ? 'ショップは準備中です' : '商品を読み込めませんでした'}</h3><p role={preparing ? 'status' : 'alert'}>{preparing ? '商品の公開準備ができるまで、しばらくお待ちください。' : loadError}</p><button type="button" className="photo-secondary" onClick={() => void reload()}>もう一度確認する</button></div> : mode === 'admin' && !authorized ? <div className="photo-state"><span className="photo-state-mark"><LockKeyhole size={29} /></span><h3>管理者専用のページです</h3><p>商品の登録と設定には、管理者アカウントでのログインが必要です。</p>{!userId && onRequestLogin && <button type="button" className="photo-secondary" onClick={onRequestLogin}>ログインする</button>}</div> : snapshot ? <>
      {syncWarning && <p className="photo-inline-note" role="status">{syncWarning}</p>}
      {actionError && !selected && <p className="photo-error" role="alert">{actionError}</p>}
      {success && !selected && <p className="photo-success" role="status"><CheckCircle2 size={17} />{success}</p>}
      {mode === 'shop' ? <>
        {userId ? <div className="photo-wallet" aria-label="ショップ購入用の仮想利益"><div className="photo-wallet-main"><span><Coins size={16} />ショップに使える仮想利益</span><strong>{amount(snapshot.availableProfit)}</strong><p>確定利益から利用・確保済み分を差し引いています。</p></div><div className="photo-wallet-detail"><div><span>確定利益</span><strong>{amount(snapshot.realizedProfit)}</strong></div><div><span>商品に利用・確保済み</span><strong>{amount(snapshot.spentProfit)}</strong></div><p>初期資金100万円と含み益は対象外です。確認待ちの商品分も確保しています。</p></div></div> : <div className="photo-login-note"><LockKeyhole size={20} /><div><strong>お気に入りを見つけたら、ログイン。</strong><p>商品の購入と受け取りにはログインが必要です。</p></div>{onRequestLogin && <button type="button" className="photo-secondary" onClick={onRequestLogin}>ログインして購入</button>}</div>}
        <div className="photo-catalog-heading"><div className="photo-filter" role="group" aria-label="商品を絞り込む"><button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>すべての商品</button>{userId && <button type="button" aria-pressed={filter === 'owned'} onClick={() => setFilter('owned')}>購入・申請済み<span>{ownedCount}</span></button>}</div><div className="shop-catalog-tools"><span>{photos.length}件</span><button type="button" className="photo-refresh" disabled={loading || busy} onClick={() => void reload()}><RefreshCw size={14} className={loading ? 'photo-spinner' : ''} />更新</button></div></div>
      </> : <>
        <div className="photo-admin-heading"><span className="photo-role-badge"><ShieldCheck size={14} />{snapshot.role === 'developer' ? '開発者・管理者' : '管理者'}</span><span>購入済みの商品は、公開終了後も受け取れます。</span></div>
        {snapshot.fileProductsReady && <section className="shop-order-section" aria-label="ファイル商品の購入申請">
          <div className="photo-catalog-heading"><h3>ファイル商品の購入申請</h3><div className="photo-filter" role="group" aria-label="申請を絞り込む"><button type="button" aria-pressed={orderFilter === 'pending'} onClick={() => setOrderFilter('pending')}>確認待ち<span>{pendingCount}</span></button><button type="button" aria-pressed={orderFilter === 'all'} onClick={() => setOrderFilter('all')}>すべて</button></div></div>
          {orders.length ? <ul className="shop-order-list">{orders.map(order => <li key={order.id}>
            <div className="shop-order-info"><strong>{order.productTitle}</strong><p>{order.buyerLabel}</p><div className="shop-order-meta"><span>{order.source === 'lottery' ? 'くじ当選' : amount(order.paidPrice)}</span><span>申請 {date(order.purchasedAt)}</span>{order.reviewedAt && <span>確認 {date(order.reviewedAt)}</span>}</div><span className={`shop-delivery-status state-${order.status}`}>{order.status === 'pending' ? '確認待ち' : order.status === 'approved' ? '受け渡し済み' : '却下・利益返却済み'}</span></div>
            {order.status === 'pending' && <div className="shop-order-actions"><button type="button" className="photo-primary" disabled={busy} onClick={() => setReviewingOrder({ id: order.id, decision: 'approve' })}>承認して渡す</button><button type="button" className="photo-secondary" disabled={busy} onClick={() => setReviewingOrder({ id: order.id, decision: 'reject' })}>却下して戻す</button></div>}
            {order.status === 'pending' && reviewingOrder?.id === order.id && <div className="shop-review-confirm"><p>{reviewingOrder.decision === 'approve' ? '承認すると、この対象者がファイルをダウンロードできるようになります。承認は取り消せません。' : order.source === 'lottery' ? '当選商品の受け渡しを見送り、在庫と当選した回の消費額を返却します。' : '申請を却下し、確保した仮想利益と在庫を戻します。'}</p><div><button type="button" className="photo-primary" disabled={busy} onClick={() => review(order.id, reviewingOrder.decision)}>{busyAction === `review:${order.id}` ? <LoaderCircle size={14} className="photo-spinner" /> : <Check size={14} />}{reviewingOrder.decision === 'approve' ? '承認を確定' : '却下を確定'}</button><button type="button" className="photo-secondary" disabled={busy} onClick={() => setReviewingOrder(null)}>キャンセル</button></div></div>}
          </li>)}</ul> : <p className="shop-orders-empty">{orderFilter === 'pending' ? '確認待ちの申請はありません。' : '購入申請はまだありません。'}</p>}
        </section>}
        <section ref={formSection} className="photo-editor" aria-label={editing ? '商品の設定を編集' : '新しい商品を登録'}>
          <div className="photo-editor-heading"><span className="photo-editor-icon">{editing ? <Pencil size={21} /> : <ImagePlus size={23} />}</span><div><h3>{editing ? '商品の設定を編集' : '新しい商品を登録'}</h3><p>{editing ? 'タイトル・価格・公開状態を変更できます。' : '写真や、コードを記載したファイルを商品にできます。'}</p></div>{editing && <button type="button" className="photo-text-button" onClick={resetDraft} disabled={busy}>編集をやめる</button>}</div>
          {!snapshot.fileProductsReady && <p className="photo-inline-note" role="status">ファイル商品の設定待ちです。設定が完了するまで、写真商品を管理できます。</p>}
          <form onSubmit={submit} className={`photo-editor-form ${editing ? 'photo-editor-form-edit' : ''}`}>
            {!editing && <label className="photo-file-field"><Upload size={23} /><strong>{file ? file.name : draft.kind === 'file' ? '販売するファイルを選択' : '投稿する写真を選択'}</strong><span>{draft.kind === 'file' ? 'TXT・PDF・ZIP / 15MBまで' : 'JPEG・PNG・WebP / 15MBまで'}</span><input ref={fileInput} type="file" accept={draft.kind === 'file' ? '.txt,.pdf,.zip,text/plain,application/pdf,application/zip' : 'image/jpeg,image/png,image/webp'} required disabled={busy} onChange={event => setFile(event.target.files?.[0] ?? null)} aria-label={draft.kind === 'file' ? '販売するファイル' : '投稿する写真'} /></label>}
            <div className="photo-editor-fields">
              {!editing ? <label className="shop-kind-field">商品の種類<select value={draft.kind} disabled={busy} onChange={event => { setDraft(value => ({ ...value, kind: event.target.value as 'photo' | 'file', published: event.target.value === 'file' ? false : value.published })); setFile(null); if (fileInput.current) fileInput.current.value = '' }}><option value="photo">写真</option><option value="file" disabled={!snapshot.fileProductsReady}>コード・ファイル（承認後に受け渡し）</option></select></label> : <p className="shop-kind-summary">商品の種類：{editing.kind === 'file' ? 'コード・ファイル' : '写真'}</p>}
              <label>タイトル<input type="text" value={draft.title} onChange={event => setDraft(value => ({ ...value, title: event.target.value }))} maxLength={120} required disabled={busy} placeholder="商品のタイトル" /></label><label>商品の説明<textarea value={draft.description} onChange={event => setDraft(value => ({ ...value, description: event.target.value }))} maxLength={2000} rows={3} disabled={busy} placeholder={draft.kind === 'file' ? '内容や受け取り方法など（コードそのものは書かないでください）' : '撮影した場所や、写真のストーリーなど'} /></label>
              {draft.kind === 'file' && <p className="photo-inline-note">ファイル商品は1点限りです。購入申請が入ると在庫を確保し、承認後に渡します。コードはタイトルや説明に記載せず、販売ファイルの中に入れてください。</p>}
              <div className="photo-editor-options"><label>価格（仮想円）<input type="number" min="1" max="100000000" step="1" value={draft.price} onChange={event => setDraft(value => ({ ...value, price: event.target.value }))} required disabled={busy || editing?.saleMode === 'lottery'} /></label><label className="photo-publish-check"><input type="checkbox" checked={draft.published} onChange={event => setDraft(value => ({ ...value, published: event.target.checked }))} disabled={busy} /><span>ショップに公開する</span></label></div>
            </div>
            {editing?.saleMode === 'lottery' && <p className="photo-inline-note">くじの参加費は、商品の「くじの設定」から変更してください。</p>}
            <div className="photo-editor-bottom"><p>{editing ? '変更後の価格は、これからの購入に適用されます。' : draft.kind === 'file' ? 'ファイルの内容はショップに公開されません。1ファイルの内容すべてが購入者へ渡ります。' : 'ショップには、小さなプレビュー画像を表示します。'}</p><button type="submit" className="photo-primary" disabled={busy || (draft.kind === 'file' && !snapshot.fileProductsReady)}>{busy ? <LoaderCircle size={16} className="photo-spinner" /> : <Check size={16} />}{busy ? '保存しています…' : editing ? '変更を保存する' : '商品を登録する'}</button></div>
          </form>
        </section>
        <div className="photo-catalog-heading"><h3>登録した商品</h3><span>{photos.length}件</span></div>
      </>}

      {photos.length ? <div className="photo-grid">{photos.map(photo => <article className="photo-card" key={photo.id}>
        <button type="button" className="photo-preview-button" onContextMenu={event => event.preventDefault()} onClick={() => openDetails(photo)} aria-label={`「${photo.title}」の詳細を見る`}>{photo.kind === 'file' ? fileVisual(photo) : <ProtectedPhotoPreview src={previewUrl(photo)} title={photo.title} />}<span className="photo-preview-label">{photo.kind === 'file' ? 'ファイル商品' : 'プレビュー'}</span>{(photo.purchased || photo.deliveryStatus === 'rejected' || photo.kind === 'file') && <span className={`photo-owned-badge shop-delivery-status state-${photo.deliveryStatus}`}>{photo.deliveryStatus === 'pending' ? <Clock3 size={13} /> : photo.purchased ? <CheckCircle2 size={13} /> : <FileText size={13} />}{deliveryLabel(photo)}</span>}</button>
        <div className="photo-card-body"><div className="photo-card-title"><h3>{photo.title}</h3>{!photo.published && <span className="photo-unpublished">公開終了</span>}</div><p>{photo.description || (photo.kind === 'photo' ? '開発者が撮影した、とっておきの一枚。' : '管理者の確認後に受け取れるファイル商品です。')}</p><div className="photo-card-price"><strong>{photo.saleMode === 'lottery' ? '1回 ' : ''}{amount(productPrice(photo))}</strong>{photo.saleMode === 'lottery' && photo.lottery && <span>当選確率 {(photo.lottery.winRateBps / 100).toLocaleString('ja-JP', { maximumFractionDigits: 2 })}%</span>}{photo.paidPrice !== null && <span>{photo.orderSource === 'lottery' ? 'くじの当選商品' : <>{photo.deliveryStatus === 'approved' ? '購入時' : '申請時'} {amount(photo.paidPrice)}</>}</span>}</div>
          {mode === 'admin' ? <div className="photo-card-actions"><button type="button" className="photo-secondary" disabled={busy} onClick={() => edit(photo)}><Pencil size={14} />編集する</button><button type="button" className="photo-icon-action" disabled={busy} onClick={() => download(photo)} aria-label={`「${photo.title}」の販売ファイルをダウンロード`}><ArrowDownToLine size={16} /></button></div> : canDownload(photo) ? <button type="button" className="photo-secondary photo-card-full" disabled={busy} onClick={() => download(photo)}>{busyAction === `download:${photo.id}` ? <LoaderCircle size={15} className="photo-spinner" /> : <ArrowDownToLine size={15} />}ダウンロード</button> : photo.deliveryStatus === 'pending' ? <button type="button" className="photo-secondary photo-card-full" disabled><Clock3 size={15} />管理者の確認待ち</button> : photo.kind === 'file' && photo.stockRemaining === 0 ? <button type="button" className="photo-secondary photo-card-full" disabled>受付終了</button> : <button type="button" className="photo-primary photo-card-full" disabled={busy} onClick={() => openDetails(photo)}><ShoppingBag size={15} />{photo.saleMode === 'lottery' ? 'くじを見る' : photo.kind === 'file' ? '商品を見る' : '写真を見る'}</button>}
          {mode === 'admin' && photo.kind === 'file' && userId && <AdminLotterySettings product={photo} userId={userId} ready={snapshot.lotteriesReady} onSnapshot={acceptLotterySnapshot} />}
        </div>
      </article>)}</div> : <div className="photo-state photo-state-empty"><span className="photo-state-mark"><Images size={31} /></span><h3>{mode === 'admin' ? '最初の商品を登録しましょう' : filter === 'owned' ? '購入・申請した商品はまだありません' : '次のごほうびを、お楽しみに。'}</h3><p>{mode === 'admin' ? '上のフォームから、写真やファイルを登録できます。' : filter === 'owned' ? '商品を購入・申請すると、ここで受け取り状況を確認できます。' : '商品が公開されると、このページに並びます。'}</p></div>}
      {mode === 'shop' && <p className="photo-shop-footnote"><ShieldCheck size={14} />アプリ内の仮想利益を使う機能です。実際のお金の支払いはありません。</p>}
    </> : null}

    {selected && createPortal(<div className="photo-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSelectedId(null) }}><div ref={dialog} className="photo-dialog" role="dialog" aria-modal="true" aria-labelledby={dialogTitle} tabIndex={-1}>
      <button type="button" className="photo-dialog-close" onClick={() => setSelectedId(null)} aria-label="商品の詳細を閉じる"><X size={21} /></button>
      {selected.kind === 'file' ? fileVisual(selected, true) : <ProtectedPhotoPreview className="photo-dialog-image" src={previewUrl(selected)} title={selected.title} eager />}
      <div className="photo-dialog-content"><p className="photo-preview-notice">{selected.kind === 'file' ? selected.saleMode === 'lottery' ? 'ファイルの内容は公開していません。くじに当選後、管理者が確認してからお渡しします。' : 'ファイルの内容は公開していません。購入申請後、管理者が確認してからお渡しします。' : canDownload(selected) ? '表示画像はプレビューです。原本はダウンロードボタンから取得できます。' : '表示画像はプレビューです。原本は購入後にダウンロードできます。'}</p><span className="photo-eyebrow">{canDownload(selected) ? 'YOUR COLLECTION' : selected.deliveryStatus === 'pending' ? 'WAITING FOR REVIEW' : 'A REWARD FOR YOU'}</span><h2 id={dialogTitle}>{selected.title}</h2>{selected.description && <p className="photo-dialog-description">{selected.description}</p>}<div className="photo-dialog-price"><span>{selected.purchased && selected.orderSource === 'lottery' ? 'くじの当選商品' : selected.deliveryStatus === 'pending' ? '確保した仮想利益' : selected.purchased && selected.paidPrice !== null ? '購入時の価格' : selected.saleMode === 'lottery' ? '参加に使う仮想利益（1回）' : '購入に使う仮想利益'}</span><strong>{selected.purchased && selected.orderSource === 'lottery' ? '当選' : amount(selected.purchased && selected.paidPrice !== null ? selected.paidPrice : productPrice(selected))}</strong></div>
        {actionError && <p className="photo-error" role="alert">{actionError}</p>}{success && <p className="photo-success" role="status"><CheckCircle2 size={17} />{success}</p>}
        {canDownload(selected) ? <><p className="photo-dialog-note">{mode === 'admin' ? '管理者として販売ファイルをダウンロードできます。' : selected.orderSource === 'lottery' ? '当選した商品です。販売ファイルをダウンロードできます。' : '購入済みの商品です。販売ファイルをダウンロードできます。'}</p><button type="button" className="photo-primary photo-card-full" disabled={busy} onClick={() => download(selected)}>{busy ? <LoaderCircle size={16} className="photo-spinner" /> : <ArrowDownToLine size={16} />}{selected.kind === 'photo' ? '原本をダウンロード' : 'ファイルをダウンロード'}</button></> : selected.deliveryStatus === 'pending' ? <div className="photo-inline-note" role="status"><Clock3 size={15} /> {selected.orderSource === 'lottery' && '当選しました。'}管理者の確認待ちです。承認されるとダウンロードできます。{selected.orderSource === 'lottery' ? '当選の受け渡しが見送られた場合は、当選した回の消費額が戻ります。' : '却下された場合は、確保した仮想利益が戻ります。'}</div> : selected.saleMode === 'lottery' ? <ShopLotteryPanel product={selected} userId={userId} availableProfit={snapshot?.availableProfit} onBeforeSpend={onBeforePurchase} onSnapshot={acceptLotterySnapshot} /> : !userId ? <p className="photo-dialog-note"><LockKeyhole size={15} />購入するには、画面上部からログインしてください。</p> : !selected.published ? <p className="photo-dialog-note">この商品は現在、公開を終了しています。</p> : selected.kind === 'file' && selected.stockRemaining === 0 ? <p className="photo-dialog-note">この商品の受付は終了しました。</p> : <>
          {selected.deliveryStatus === 'rejected' && <p className="photo-inline-note" role="status">前回の申請は見送られ、確保した仮想利益は戻りました。在庫があれば、もう一度申請できます。</p>}
          <p className="photo-dialog-note">利用できる仮想利益：<strong>{amount(snapshot?.availableProfit ?? 0)}</strong></p>{(snapshot?.availableProfit ?? 0) < selected.price && <p className="photo-insufficient">購入に使える仮想利益が不足しています。トレードで利益を確定してから、もう一度ご確認ください。</p>}
          {selected.kind === 'file' && <p className="photo-dialog-note">申請時に仮想利益と在庫を確保します。管理者の承認後にファイルをダウンロードできます。</p>}
          <button type="button" className="photo-primary photo-card-full" disabled={busy || (snapshot?.availableProfit ?? 0) < selected.price} onClick={() => buy(selected)}>{busyAction === `purchase:${selected.id}` ? <LoaderCircle size={16} className="photo-spinner" /> : <ShoppingBag size={16} />}{busyAction === `purchase:${selected.id}` ? '受け付けています…' : `${amount(selected.price)}で${selected.kind === 'file' ? '購入を申請する' : '購入する'}`}</button><p className="photo-dialog-small">{selected.kind === 'file' ? '受け取り状況は「購入・申請済み」から確認できます。' : '購入後は、購入・申請済みの商品から原本をダウンロードできます。'}</p>
        </>}
      </div>
    </div></div>, document.body)}
  </section>
}
