import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, Check, ChevronDown, Cloud, Eye, EyeOff, KeyRound, LoaderCircle, LogIn, LogOut, Mail, ShieldCheck, Upload, UserRound, X } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import './AccountMenu.css'

interface AccountMenuProps {
  syncLabel?: string
  onBeforeSignOut?: () => Promise<void>
  onImportGuest?: () => void
  canImportGuest?: boolean
}
type Mode = 'signin' | 'signup' | 'reset' | 'recovery' | 'confirm' | 'reset-sent' | 'logout' | null
const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

function GoogleMark() {
  return <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285f4" d="M21.8 12.2c0-.7-.1-1.5-.2-2.2H12v4.2h5.5a4.8 4.8 0 0 1-2.1 3.1v2.8h3.5c2-1.8 2.9-4.5 2.9-7.9Z"/><path fill="#34a853" d="M12 22c2.7 0 5-.9 6.9-2.5l-3.5-2.8c-.9.6-2 1-3.4 1-2.6 0-4.8-1.7-5.6-4.1H2.8v2.9A10 10 0 0 0 12 22Z"/><path fill="#fbbc05" d="M6.4 13.6a6 6 0 0 1 0-3.2V7.5H2.8a10 10 0 0 0 0 9l3.6-2.9Z"/><path fill="#ea4335" d="M12 6.3c1.5 0 2.8.5 3.8 1.5L19 4.6A9.8 9.8 0 0 0 12 2a10 10 0 0 0-9.2 5.5l3.6 2.9A6 6 0 0 1 12 6.3Z"/></svg>
}

export default function AccountMenu({ syncLabel, onBeforeSignOut, onImportGuest, canImportGuest = false }: AccountMenuProps) {
  const auth = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const [mode, setMode] = useState<Mode>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const lastUserId = useRef(auth.user?.id || null)
  const titleId = useId()
  const emailId = useId()
  const passwordId = useId()
  const confirmId = useId()
  const nameId = useId()
  const rawName = auth.user?.user_metadata?.display_name || auth.user?.user_metadata?.full_name
  const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim().slice(0, 40) : auth.user?.email?.split('@')[0] || 'マイアカウント'
  const initial = Array.from(name)[0]?.toUpperCase() || 'M'

  const closeModal = () => { setMode(null); setPassword(''); setConfirmPassword(''); setShowPassword(false); setError('') }
  const openMode = (next: Mode) => { setMenuOpen(false); setMode(next); setPassword(''); setConfirmPassword(''); setShowPassword(false); setError('') }
  useEffect(() => {
    const nextId = auth.user?.id || null
    if (lastUserId.current !== nextId) {
      lastUserId.current = nextId
      setMenuOpen(false)
      setPassword(''); setConfirmPassword(''); setShowPassword(false)
      setEmail(''); setDisplayName(''); setError('')
      setMode(current => current === 'recovery' && nextId ? current : null)
    }
  }, [auth.user?.id])
  useEffect(() => {
    if (auth.recovery) openMode('recovery')
  }, [auth.recovery])
  useEffect(() => {
    if (auth.authError) { setError(auth.authError); setMode('signin'); auth.clearAuthError() }
  }, [auth.authError, auth.clearAuthError])
  useEffect(() => {
    if (!menuOpen) return
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenuOpen(false); triggerRef.current?.focus() } }
    window.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key) }
  }, [menuOpen])
  useEffect(() => {
    if (!mode) return
    const previousFocused = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMode(null); setPassword(''); setConfirmPassword(''); setShowPassword(false); setError(''); return }
      if (event.key !== 'Tab') return
      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href], [tabindex="0"]')
      if (!nodes?.length) { event.preventDefault(); return }
      const first = nodes[0], last = nodes[nodes.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', keyboard)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', keyboard)
      if (previousFocused?.isConnected) previousFocused.focus()
      else triggerRef.current?.focus()
    }
  }, [Boolean(mode)])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setError('')
    if (mode !== 'recovery' && !validEmail(email)) { setError('有効なメールアドレスを入力してください。'); return }
    if ((mode === 'signin' || mode === 'signup' || mode === 'recovery') && !password) { setError('パスワードを入力してください。'); return }
    if ((mode === 'signup' || mode === 'recovery') && password.length < 8) { setError('パスワードは8文字以上で設定してください。'); return }
    if ((mode === 'signup' || mode === 'recovery') && password !== confirmPassword) { setError('確認用パスワードが一致していません。'); return }
    setBusy(true)
    try {
      if (mode === 'signin') { await auth.signIn(email, password); closeModal() }
      else if (mode === 'signup') {
        const result = await auth.signUp(email, password, displayName)
        setPassword(''); setConfirmPassword('')
        if (result.confirmationRequired) setMode('confirm')
        else closeModal()
      } else if (mode === 'reset') { await auth.sendPasswordReset(email); setMode('reset-sent') }
      else if (mode === 'recovery') { await auth.updatePassword(password); closeModal() }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作を完了できませんでした。もう一度お試しください。') }
    finally { setBusy(false) }
  }
  const google = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { await auth.signInWithGoogle() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Googleログインを完了できませんでした。') }
    finally { setBusy(false) }
  }
  const signOut = async (skipFlush = false) => {
    if (busy) return
    setBusy(true); setError(''); setMenuOpen(false)
    try {
      if (!skipFlush && onBeforeSignOut) {
        try { await onBeforeSignOut() }
        catch { setMode('logout'); return }
      }
      await auth.signOut()
      closeModal()
    } catch (reason) { setMode('logout'); setError(reason instanceof Error ? reason.message : 'ログアウトを完了できませんでした。') }
    finally { setBusy(false) }
  }

  if (!auth.configured) return <button type="button" className="account-coming-soon" disabled title="個人アカウント機能は準備中です。ゲストとして練習できます。"><UserRound size={15} /><span>アカウント準備中</span></button>
  const title = mode === 'signin' ? 'おかえりなさい。' : mode === 'signup' ? 'あなただけの練習口座を。' : mode === 'reset' ? 'パスワードを再設定' : mode === 'recovery' ? '新しいパスワードを設定' : mode === 'confirm' ? 'メールをご確認ください' : mode === 'reset-sent' ? '再設定メールをご確認ください' : 'ログアウトしますか？'
  const isForm = mode === 'signin' || mode === 'signup' || mode === 'reset' || mode === 'recovery'
  return <div className="account-menu-wrapper" ref={menuRef}>
    <button ref={triggerRef} className={`account-trigger ${auth.user ? 'account-trigger-signed-in' : ''}`} type="button" disabled={auth.loading} aria-label={auth.user ? `${name}のアカウント` : 'ログイン'} aria-expanded={auth.user ? menuOpen : undefined} aria-haspopup={auth.user ? 'menu' : 'dialog'} onClick={() => auth.user ? setMenuOpen(value => !value) : openMode('signin')}>
      {auth.loading ? <LoaderCircle className="account-spinner" size={15} /> : auth.user ? <span className="account-initial">{initial}</span> : <LogIn size={15} />}<span>{auth.user ? name : 'ログイン'}</span>{auth.user && <ChevronDown size={12} />}
    </button>
    {menuOpen && auth.user && <div className="account-dropdown" role="menu" aria-label="個人アカウント">
      <div className="account-dropdown-person"><strong>{name}</strong><span>{auth.user.email || 'Googleアカウント'}</span></div>
      <div className="account-sync-label"><Cloud size={14} />{syncLabel || '個人の練習口座'}</div>
      {canImportGuest && onImportGuest && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onImportGuest() }}><Upload size={15} />この端末のゲスト練習を取り込む</button>}
      <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setEmail(auth.user?.email || ''); openMode('reset') }}><KeyRound size={15} />パスワードを再設定</button>
      <button type="button" role="menuitem" className="account-logout-item" disabled={busy} onClick={() => { void signOut() }}><LogOut size={15} />ログアウト</button>
    </div>}
    {mode && createPortal(<div className="account-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeModal() }}><div className="account-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <button type="button" className="account-dialog-close" aria-label="アカウント画面を閉じる" onClick={closeModal}><X size={19} /></button>
      <div className="account-dialog-mark">{mode === 'confirm' || mode === 'reset-sent' ? <Mail size={24} /> : mode === 'reset' || mode === 'recovery' ? <KeyRound size={24} /> : mode === 'logout' ? <LogOut size={24} /> : <UserRound size={24} />}</div>
      <span className="account-eyebrow">MANGO FX · YOUR OWN JOURNEY</span>
      <h2 id={titleId}>{title}</h2>
      <p className="account-dialog-description">{mode === 'signin' ? 'ログインして、前回の続きから始めましょう。' : mode === 'signup' ? '取引の経験を、自分のアカウントに残せます。' : mode === 'reset' ? '登録したメールアドレスに、再設定用リンクを送ります。' : mode === 'recovery' ? '他のサービスと異なるパスワードを設定しましょう。' : mode === 'confirm' ? '確認メール内のリンクを開くと、メールアドレスの確認が完了します。' : mode === 'reset-sent' ? '登録されているメールアドレスの場合、再設定用メールが届きます。メール内のリンクから設定してください。' : '未同期の練習データは、この端末に残ります。別の端末からは、最後に同期した時点のデータを利用できます。'}</p>
      {(mode === 'signin' || mode === 'signup') && <><button type="button" className="account-google-button" onClick={() => { void google() }} disabled={busy}><GoogleMark />Googleで{mode === 'signup' ? '登録 / ログイン' : 'ログイン'}</button><div className="account-divider"><span />またはメールアドレスで<span /></div><div className="account-mode-tabs"><button type="button" className={mode === 'signin' ? 'active' : ''} onClick={() => openMode('signin')} disabled={busy}>ログイン</button><button type="button" className={mode === 'signup' ? 'active' : ''} onClick={() => openMode('signup')} disabled={busy}>新規登録</button></div></>}
      {isForm && <form className="account-form" onSubmit={event => { void submit(event) }} noValidate>
        {mode === 'signup' && <label htmlFor={nameId}>表示名 <span>任意</span><input id={nameId} type="text" autoComplete="nickname" maxLength={40} placeholder="例：マンゴー" value={displayName} onChange={event => setDisplayName(event.target.value)} disabled={busy} /></label>}
        {mode !== 'recovery' && <label htmlFor={emailId}>メールアドレス<input id={emailId} type="email" inputMode="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={event => { setEmail(event.target.value); setError('') }} disabled={busy} required /></label>}
        {(mode === 'signin' || mode === 'signup' || mode === 'recovery') && <label htmlFor={passwordId}>パスワード{mode !== 'signin' && <span>8文字以上</span>}<div className="account-password-field"><input id={passwordId} type={showPassword ? 'text' : 'password'} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={event => { setPassword(event.target.value); setError('') }} disabled={busy} required /><button type="button" aria-label={showPassword ? 'パスワードを隠す' : 'パスワードを表示'} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)} disabled={busy}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>}
        {(mode === 'signup' || mode === 'recovery') && <label htmlFor={confirmId}>パスワード（確認）<input id={confirmId} type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={confirmPassword} onChange={event => { setConfirmPassword(event.target.value); setError('') }} disabled={busy} required /></label>}
        {error && <div className="account-error" role="alert">{error}</div>}
        <button type="submit" className="account-primary" disabled={busy}>{busy ? <><LoaderCircle size={16} className="account-spinner" />処理しています…</> : <>{mode === 'signin' ? 'ログインする' : mode === 'signup' ? 'アカウントを作成' : mode === 'reset' ? '再設定メールを送る' : 'パスワードを変更'}<ArrowRight size={16} /></>}</button>
        {mode === 'signin' && <button type="button" className="account-text-link" onClick={() => openMode('reset')} disabled={busy}>パスワードを忘れた方</button>}
        {mode === 'reset' && <button type="button" className="account-text-link" onClick={() => openMode('signin')} disabled={busy}>ログインに戻る</button>}
      </form>}
      {!isForm && error && <div className="account-error" role="alert">{error}</div>}
      {(mode === 'confirm' || mode === 'reset-sent') && <><div className="account-email-destination"><Mail size={16} />{email}</div><p className="account-email-help">メールが見つからない場合は、迷惑メールフォルダもご確認ください。リンクの期限が切れた場合は、もう一度お手続きください。</p><button type="button" className="account-primary" onClick={() => openMode('signin')}>ログインに戻る<ArrowRight size={16} /></button></>}
      {mode === 'logout' && <div className="account-logout-actions"><button type="button" className="account-secondary" onClick={closeModal} disabled={busy}>このまま続ける</button><button type="button" className="account-primary" onClick={() => { void signOut(true) }} disabled={busy}>{busy ? <LoaderCircle size={15} className="account-spinner" /> : <LogOut size={15} />}ログアウトする</button></div>}
      <p className="account-privacy-note"><ShieldCheck size={13} />{mode === 'logout' ? 'このブラウザのログインだけを終了します。' : '仮想資金の練習口座です。実際の資金は使いません。'}</p>
      {(mode === 'signin' || mode === 'signup') && <button type="button" className="account-guest-link" onClick={closeModal} disabled={busy}>ゲストのまま続ける<Check size={13} /></button>}
    </div></div>, document.body)}
  </div>
}
