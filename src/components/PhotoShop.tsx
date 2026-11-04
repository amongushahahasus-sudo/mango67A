import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDownToLine, Camera, Check, CheckCircle2, Coins, ImagePlus, Images, LoaderCircle, LockKeyhole, Pencil, RefreshCw, ShieldCheck, ShoppingBag, Upload, X } from 'lucide-react'
import { downloadPhoto, loadPhotoShop, PhotoShopError, previewUrl, purchasePhoto, SetupRequiredError, updatePhoto, uploadPhoto, type ShopPhoto, type ShopRole, type ShopSnapshot } from '../lib/photoShop'
import './PhotoShop.css'
import ProtectedPhotoPreview from './ProtectedPhotoPreview'

interface PhotoShopProps {
  mode: 'shop' | 'admin'
  userId: string | null
  onBeforePurchase?: () => Promise<void>
  onRequestLogin?: () => void
  onRoleChange?: (role: ShopRole) => void
}
interface PhotoDraft { title: string; description: string; price: string; published: boolean }
const emptyDraft = (): PhotoDraft => ({ title: '', description: '', price: '1000', published: true })
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
  const accept = (next: ShopSnapshot) => { setSnapshot(next); roleChanged.current?.(next.role) }

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
    setActionError(''); setSuccess(''); setSyncWarning(''); setBusyAction(null); setFilter('all')
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

  const buy = (photo: ShopPhoto) => void run(`purchase:${photo.id}`, async (operationEpoch, expectedUser) => {
    await beforePurchase.current?.()
    if (!current(operationEpoch, expectedUser)) return
    const next = await purchasePhoto(photo.id, photo.price, expectedUser)
    if (!current(operationEpoch, expectedUser)) return
    accept(next)
    setSuccess(`「${photo.title}」を購入しました。写真をダウンロードできます。`)
  })

  const download = (photo: ShopPhoto) => void run(`download:${photo.id}`, async (operationEpoch, expectedUser) => {
    await downloadPhoto(photo.id, photo.title, expectedUser)
    if (current(operationEpoch, expectedUser)) setSuccess(`「${photo.title}」のダウンロードを開始しました。`)
  })

  const resetDraft = () => {
    setEditingId(null); setDraft(emptyDraft()); setFile(null)
    if (fileInput.current) fileInput.current.value = ''
  }
  const edit = (photo: ShopPhoto) => {
    setEditingId(photo.id); setDraft({ title: photo.title, description: photo.description, price: String(photo.price), published: photo.published })
    setFile(null); setActionError(''); setSuccess('')
    formSection.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!authorized || busy) return
    const price = Number(draft.price)
    if (!draft.title.trim() || !Number.isSafeInteger(price) || price < 1 || price > 100_000_000) { setActionError('タイトルと、1〜100,000,000の整数の価格を入力してください。'); return }
    if (!editing && !file) { setActionError('投稿する写真を選んでください。'); return }
    const fields = { title: draft.title.trim(), description: draft.description.trim(), price, published: draft.published }
    void run(editing ? `save:${editing.id}` : 'upload', async (operationEpoch, expectedUser) => {
      const next = editing ? await updatePhoto(editing, fields, expectedUser) : await uploadPhoto({ ...fields, file: file! }, expectedUser)
      if (!current(operationEpoch, expectedUser)) return
      accept(next); resetDraft()
      setSuccess(editing ? '写真の設定を保存しました。' : fields.published ? '写真を投稿して公開しました。' : '写真を下書きとして保存しました。')
    })
  }

  const photos = (snapshot?.photos ?? []).filter(photo => mode === 'admin' || ((photo.published || photo.purchased) && (filter === 'all' || photo.purchased)))
  const ownedCount = snapshot?.photos.filter(photo => photo.purchased).length ?? 0

  return <section className="photo-shop" aria-label={mode === 'admin' ? '写真の管理' : '写真ショップ'}>
    <div className={`photo-shop-hero ${mode === 'admin' ? 'photo-shop-hero-admin' : ''}`}>
      <div className="photo-hero-mark">{mode === 'admin' ? <ShieldCheck size={27} /> : <Camera size={29} />}</div>
      <div><span className="photo-eyebrow">{mode === 'admin' ? 'YOUR PHOTO STUDIO' : 'THE MANGO COLLECTION'}</span><h2>{mode === 'admin' ? 'あなたの写真を、みんなの楽しみに。' : '練習の先に、お気に入りの一枚を。'}</h2><p>{mode === 'admin' ? '写真の投稿、価格の設定、公開状態をここで管理できます。' : 'アプリで得た仮想の利益を使って、開発者が撮影した写真を購入できます。'}</p></div>
      <button type="button" className="photo-refresh" disabled={loading || busy} onClick={() => void reload()}><RefreshCw size={14} className={loading ? 'photo-spinner' : ''} />更新</button>
    </div>

    {loading && !snapshot ? <div className="photo-state"><LoaderCircle size={25} className="photo-spinner" /><h3>写真を読み込んでいます</h3><p>写真と利用できる利益を確認しています。</p></div> : loadError && !snapshot ? <div className="photo-state"><span className="photo-state-mark">{preparing ? <Images size={29} /> : <RefreshCw size={27} />}</span><h3>{preparing ? '写真ショップは準備中です' : '写真を読み込めませんでした'}</h3><p role={preparing ? 'status' : 'alert'}>{preparing ? '写真の公開準備ができるまで、しばらくお待ちください。' : loadError}</p><button type="button" className="photo-secondary" onClick={() => void reload()}>もう一度確認する</button></div> : mode === 'admin' && !authorized ? <div className="photo-state"><span className="photo-state-mark"><LockKeyhole size={29} /></span><h3>管理者専用のページです</h3><p>写真の投稿と設定には、管理者アカウントでのログインが必要です。</p>{!userId && onRequestLogin && <button type="button" className="photo-secondary" onClick={onRequestLogin}>ログインする</button>}</div> : snapshot ? <>
      {syncWarning && <p className="photo-inline-note" role="status">{syncWarning}</p>}
      {actionError && !selected && <p className="photo-error" role="alert">{actionError}</p>}
      {success && !selected && <p className="photo-success" role="status"><CheckCircle2 size={17} />{success}</p>}
      {mode === 'shop' ? <>
        {userId ? <div className="photo-wallet" aria-label="写真購入用の仮想利益"><div className="photo-wallet-main"><span><Coins size={16} />写真に使える仮想利益</span><strong>{amount(snapshot.availableProfit)}</strong><p>確定利益から利用済み分を差し引いています。</p></div><div className="photo-wallet-detail"><div><span>確定利益</span><strong>{amount(snapshot.realizedProfit)}</strong></div><div><span>写真に利用済み</span><strong>{amount(snapshot.spentProfit)}</strong></div><p>初期資金100万円と、未決済の含み益は含まれません。</p></div></div> : <div className="photo-login-note"><LockKeyhole size={20} /><div><strong>お気に入りを見つけたら、ログイン。</strong><p>写真の購入とダウンロードにはログインが必要です。</p></div>{onRequestLogin && <button type="button" className="photo-secondary" onClick={onRequestLogin}>ログインして購入</button>}</div>}
        <div className="photo-catalog-heading"><div className="photo-filter" role="group" aria-label="写真を絞り込む"><button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>すべての写真</button>{userId && <button type="button" aria-pressed={filter === 'owned'} onClick={() => setFilter('owned')}>購入済み<span>{ownedCount}</span></button>}</div><span>{photos.length}枚</span></div>
      </> : <>
        <div className="photo-admin-heading"><span className="photo-role-badge"><ShieldCheck size={14} />{snapshot.role === 'developer' ? '開発者・管理者' : '管理者'}</span><span>購入済みの写真は、公開終了後もダウンロードできます。</span></div>
        <section ref={formSection} className="photo-editor" aria-label={editing ? '写真の設定を編集' : '新しい写真を投稿'}>
          <div className="photo-editor-heading"><span className="photo-editor-icon">{editing ? <Pencil size={21} /> : <ImagePlus size={23} />}</span><div><h3>{editing ? '写真の設定を編集' : '新しい写真を投稿'}</h3><p>{editing ? 'タイトル・価格・公開状態を変更できます。' : '原本は購入した人と管理者だけがダウンロードできます。'}</p></div>{editing && <button type="button" className="photo-text-button" onClick={resetDraft} disabled={busy}>編集をやめる</button>}</div>
          <form onSubmit={submit} className={`photo-editor-form ${editing ? 'photo-editor-form-edit' : ''}`}>
            {!editing && <label className="photo-file-field"><Upload size={23} /><strong>{file ? file.name : '投稿する写真を選択'}</strong><span>JPEG・PNG・WebP / 15MBまで</span><input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" required disabled={busy} onChange={event => setFile(event.target.files?.[0] ?? null)} aria-label="投稿する写真" /></label>}
            <div className="photo-editor-fields"><label>タイトル<input type="text" value={draft.title} onChange={event => setDraft(value => ({ ...value, title: event.target.value }))} maxLength={120} required disabled={busy} placeholder="写真のタイトル" /></label><label>写真の説明<textarea value={draft.description} onChange={event => setDraft(value => ({ ...value, description: event.target.value }))} maxLength={2000} rows={3} disabled={busy} placeholder="撮影した場所や、この一枚のストーリーなど" /></label><div className="photo-editor-options"><label>価格（仮想円）<input type="number" min="1" max="100000000" step="1" value={draft.price} onChange={event => setDraft(value => ({ ...value, price: event.target.value }))} required disabled={busy} /></label><label className="photo-publish-check"><input type="checkbox" checked={draft.published} onChange={event => setDraft(value => ({ ...value, published: event.target.checked }))} disabled={busy} /><span>ショップに公開する</span></label></div></div>
            <div className="photo-editor-bottom"><p>{editing ? '変更後の価格は、これからの購入に適用されます。' : 'ショップには、小さなプレビュー画像を表示します。'}</p><button type="submit" className="photo-primary" disabled={busy}>{busy ? <LoaderCircle size={16} className="photo-spinner" /> : <Check size={16} />}{busy ? '保存しています…' : editing ? '変更を保存する' : '写真を投稿する'}</button></div>
          </form>
        </section>
        <div className="photo-catalog-heading"><h3>投稿した写真</h3><span>{photos.length}枚</span></div>
      </>}

      {photos.length ? <div className="photo-grid">{photos.map(photo => <article className="photo-card" key={photo.id}>
        <button type="button" className="photo-preview-button" onContextMenu={event => event.preventDefault()} onClick={() => { setSelectedId(photo.id); setActionError(''); setSuccess('') }} aria-label={`「${photo.title}」の詳細を見る`}><ProtectedPhotoPreview src={previewUrl(photo)} title={photo.title} /><span className="photo-preview-label">プレビュー</span>{photo.purchased && <span className="photo-owned-badge"><CheckCircle2 size={13} />購入済み</span>}</button>
        <div className="photo-card-body"><div className="photo-card-title"><h3>{photo.title}</h3>{!photo.published && <span className="photo-unpublished">公開終了</span>}</div><p>{photo.description || '開発者が撮影した、とっておきの一枚。'}</p><div className="photo-card-price"><strong>{amount(photo.price)}</strong>{photo.purchased && photo.paidPrice !== null && <span>購入時 {amount(photo.paidPrice)}</span>}</div>
          {mode === 'admin' ? <div className="photo-card-actions"><button type="button" className="photo-secondary" disabled={busy} onClick={() => edit(photo)}><Pencil size={14} />編集する</button><button type="button" className="photo-icon-action" disabled={busy} onClick={() => download(photo)} aria-label={`「${photo.title}」の原本をダウンロード`}><ArrowDownToLine size={16} /></button></div> : photo.purchased ? <button type="button" className="photo-secondary photo-card-full" disabled={busy} onClick={() => download(photo)}>{busyAction === `download:${photo.id}` ? <LoaderCircle size={15} className="photo-spinner" /> : <ArrowDownToLine size={15} />}ダウンロード</button> : <button type="button" className="photo-primary photo-card-full" disabled={busy} onClick={() => { setSelectedId(photo.id); setActionError(''); setSuccess('') }}><ShoppingBag size={15} />写真を見る</button>}
        </div>
      </article>)}</div> : <div className="photo-state photo-state-empty"><span className="photo-state-mark"><Images size={31} /></span><h3>{mode === 'admin' ? '最初の一枚を投稿しましょう' : filter === 'owned' ? '購入した写真はまだありません' : '次の一枚を、お楽しみに。'}</h3><p>{mode === 'admin' ? '上のフォームから、あなたが撮影した写真を投稿できます。' : filter === 'owned' ? '写真を購入すると、ここからダウンロードできます。' : '写真が公開されると、このページに並びます。'}</p></div>}
      {mode === 'shop' && <p className="photo-shop-footnote"><ShieldCheck size={14} />アプリ内の仮想利益を使う機能です。実際のお金の支払いはありません。</p>}
    </> : null}

    {selected && createPortal(<div className="photo-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSelectedId(null) }}><div ref={dialog} className="photo-dialog" role="dialog" aria-modal="true" aria-labelledby={dialogTitle} tabIndex={-1}>
      <button type="button" className="photo-dialog-close" onClick={() => setSelectedId(null)} aria-label="写真の詳細を閉じる"><X size={21} /></button>
      <ProtectedPhotoPreview className="photo-dialog-image" src={previewUrl(selected)} title={selected.title} eager />
      <div className="photo-dialog-content"><p className="photo-preview-notice">{selected.purchased || (mode === 'admin' && authorized) ? '表示画像はプレビューです。原本はダウンロードボタンから取得できます。' : '表示画像はプレビューです。原本は購入後にダウンロードできます。'}</p><span className="photo-eyebrow">{selected.purchased ? 'YOUR COLLECTION' : 'A PHOTO FOR YOU'}</span><h2 id={dialogTitle}>{selected.title}</h2>{selected.description && <p className="photo-dialog-description">{selected.description}</p>}<div className="photo-dialog-price"><span>{selected.purchased ? '購入時の価格' : '購入に使う仮想利益'}</span><strong>{amount(selected.purchased ? selected.paidPrice ?? selected.price : selected.price)}</strong></div>
        {actionError && <p className="photo-error" role="alert">{actionError}</p>}{success && <p className="photo-success" role="status"><CheckCircle2 size={17} />{success}</p>}
        {selected.purchased || (mode === 'admin' && authorized) ? <><p className="photo-dialog-note">{selected.purchased ? '購入済みの写真です。原本をダウンロードできます。' : '管理者として原本をダウンロードできます。'}</p><button type="button" className="photo-primary photo-card-full" disabled={busy} onClick={() => download(selected)}>{busy ? <LoaderCircle size={16} className="photo-spinner" /> : <ArrowDownToLine size={16} />}原本をダウンロード</button></> : !userId ? <p className="photo-dialog-note"><LockKeyhole size={15} />購入するには、画面上部からログインしてください。</p> : !selected.published ? <p className="photo-dialog-note">この写真は現在、公開を終了しています。</p> : <><p className="photo-dialog-note">利用できる仮想利益：<strong>{amount(snapshot?.availableProfit ?? 0)}</strong></p>{(snapshot?.availableProfit ?? 0) < selected.price && <p className="photo-insufficient">購入に使える仮想利益が不足しています。トレードで利益を確定してから、もう一度ご確認ください。</p>}<button type="button" className="photo-primary photo-card-full" disabled={busy || (snapshot?.availableProfit ?? 0) < selected.price} onClick={() => buy(selected)}>{busyAction === `purchase:${selected.id}` ? <LoaderCircle size={16} className="photo-spinner" /> : <ShoppingBag size={16} />}{busyAction === `purchase:${selected.id}` ? '購入しています…' : `${amount(selected.price)}で購入する`}</button><p className="photo-dialog-small">購入後は、購入済みの写真から原本をダウンロードできます。</p></>}
      </div>
    </div></div>, document.body)}
  </section>
}
