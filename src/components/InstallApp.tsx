import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDownToLine, Check, Download, Globe, Laptop, ShieldCheck, X } from 'lucide-react'
import './InstallApp.css'

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

function inAppWindow() {
  return window.matchMedia('(display-mode: standalone)').matches
    || Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
}

/** Installation is initiated only by the browser's real deferred install event. */
export default function InstallApp() {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(inAppWindow)
  const [helpOpen, setHelpOpen] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [promptFailed, setPromptFailed] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const isFile = window.location.protocol === 'file:'
  const canInstallHere = !isFile && ['http:', 'https:'].includes(window.location.protocol) && window.isSecureContext

  useEffect(() => {
    const displayMode = window.matchMedia('(display-mode: standalone)')
    const handlePrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as InstallPromptEvent)
      setPromptFailed(false)
    }
    const handleInstalled = () => {
      setInstalled(true)
      setInstallPrompt(null)
      setHelpOpen(false)
    }
    const handleDisplayMode = () => setInstalled(inAppWindow())
    window.addEventListener('beforeinstallprompt', handlePrompt)
    window.addEventListener('appinstalled', handleInstalled)
    displayMode.addEventListener('change', handleDisplayMode)
    return () => {
      window.removeEventListener('beforeinstallprompt', handlePrompt)
      window.removeEventListener('appinstalled', handleInstalled)
      displayMode.removeEventListener('change', handleDisplayMode)
    }
  }, [])

  useEffect(() => {
    if (!helpOpen) return
    const lastFocused = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setHelpOpen(false)
      }
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]')
      if (!focusable?.length) { event.preventDefault(); return }
      const first = focusable[0], last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      if (lastFocused?.isConnected) lastFocused.focus()
      else triggerRef.current?.focus()
    }
  }, [helpOpen])

  const requestInstall = async () => {
    const deferred = installPrompt
    if (!deferred || !canInstallHere) { setHelpOpen(true); return }
    setRequesting(true)
    // A deferred event can be used once, including when the user dismisses it.
    setInstallPrompt(null)
    try {
      await deferred.prompt()
      const choice = await deferred.userChoice
      if (choice.outcome === 'accepted') {
        setInstalled(true)
        setHelpOpen(false)
      }
    } catch {
      setPromptFailed(true)
      setHelpOpen(true)
    } finally {
      setRequesting(false)
    }
  }

  if (installed) return null
  const directInstall = Boolean(installPrompt) && canInstallHere
  const label = requesting ? 'インストールを確認中' : directInstall ? 'アプリをインストール' : 'アプリのインストール方法'

  return <>
    <button
      className={`install-trigger ${directInstall ? 'install-trigger-ready' : ''}`}
      ref={triggerRef}
      type="button"
      aria-label={label}
      title={label}
      disabled={requesting}
      onClick={() => { void requestInstall() }}
    >
      <Download size={15} />
      <span>{directInstall ? 'アプリをインストール' : 'インストール方法'}</span>
    </button>
    {helpOpen && createPortal(
      <div className="install-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setHelpOpen(false) }}>
        <div className="install-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
          <button className="install-close" type="button" aria-label="インストール方法を閉じる" onClick={() => setHelpOpen(false)}><X size={19} /></button>
          <div className="install-app-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M6 24V9l10 12L26 9v15" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" /></svg></div>
          <span className="install-eyebrow">MANGO FX · APP EDITION</span>
          <h2 id={titleId}>いつもの練習を、アプリから。</h2>
          <p className="install-intro" id={descriptionId}>ChromebookのランチャーやWindowsのスタートメニューから、MANGO FXをすぐに開けます。</p>
          {isFile ? <div className="install-context-note"><Globe size={19} /><p>このHTMLファイル版は、そのままブラウザで利用できます。アプリとしてインストールするには、公開されたHTTPS版にアクセスしてください。</p></div>
            : !canInstallHere ? <div className="install-context-note"><ShieldCheck size={19} /><p>アプリとしてインストールするには、公開されたHTTPS版にアクセスしてください。このページでは、そのままブラウザで練習できます。</p></div>
            : <>
              {promptFailed && <p className="install-prompt-note" role="status">インストール画面を表示できませんでした。ブラウザのメニューからお試しください。</p>}
              <div className="install-instructions">
                <article><span className="install-platform-icon"><Laptop size={19} /></span><div><h3>Chromebook / Google Chrome</h3><p>アドレスバーのインストールアイコン、または右上の <strong>⋮ メニュー</strong> の <strong>「保存して共有」</strong> から、MANGO FXのインストール項目を選びます。</p></div></article>
                <article><span className="install-platform-icon"><ArrowDownToLine size={19} /></span><div><h3>Windows / Microsoft Edge</h3><p>右上の <strong>… メニュー</strong> → <strong>「アプリ」</strong> → <strong>「このサイトをアプリとしてインストール」</strong> を選びます。</p></div></article>
              </div>
              <p className="install-menu-note">メニューの名前や表示はブラウザのバージョンによって異なります。インストール項目がない場合も、ブラウザでそのまま利用できます。</p>
              <div className="install-benefits"><span><Check size={13} />専用ウィンドウで起動</span><span><Check size={13} />初回読み込み後はオフライン対応</span></div>
              {directInstall && <button className="install-primary" type="button" onClick={() => { void requestInstall() }} disabled={requesting}><Download size={16} />アプリをインストール</button>}
            </>}
          <p className="install-storage-note"><ShieldCheck size={13} />同じブラウザ・公開URLでは、取引データを引き継いで使えます。別端末への自動同期はありません。</p>
          <button className="install-dismiss" type="button" onClick={() => setHelpOpen(false)}>わかりました<Check size={15} /></button>
        </div>
      </div>, document.body,
    )}
  </>
}
