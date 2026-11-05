import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, CheckCircle2, Gift, ShieldCheck, SlidersHorizontal, Sprout, Target, UserRound, Wallet, X } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { completeOnboarding, hasAccountCallback, readOnboardingStatus } from '../lib/onboarding'
import './WelcomeTutorial.css'

interface Props { request?: number; onRequestRegister?: () => void; onRequestLogin?: () => void }
const pages = [
  { icon: Sprout, label: 'WELCOME TO MANGO FX', title: 'MANGO FXへようこそ。', description: '相場を知り、注文を試し、自分のペースで経験を重ねましょう。まずは使い方をご案内します。', points: [
    { title: '仮想資金で、気軽に一歩。', text: '最初の資金は100万円。実際のお金を使わずにFXを練習できます。' },
    { title: 'あとから、何度でも。', text: 'この案内はメニューの「チュートリアル」から開き直せます。' },
  ] },
  { icon: Wallet, label: 'YOUR PRACTICE ACCOUNT', title: 'まずは、口座と相場を見てみよう。', description: '4つの通貨ペアから相場を選び、チャートで値動きを確かめられます。', points: [
    { title: '確定した結果と、保有中の損益。', text: '決済した結果は残高に反映されます。保有中の値動きは「評価損益」で確認しましょう。' },
    { title: '練習のペースを選べます。', text: '相場の停止・再生や速度を切り替えて、考えながら注文を試せます。' },
  ] },
  { icon: SlidersHorizontal, label: 'YOUR FIRST ORDER', title: '注文の量と、必要な資金。', description: '「買い」は値上がり、「売り」は値下がりで利益を目指す注文です。取引する量はロットで決めます。', points: [
    { title: '1ロットは、左側の通貨で10,000通貨。', text: 'USD/JPYなら1ロット＝10,000米ドル、0.1ロット＝1,000米ドルです。' },
    { title: '必要証拠金はレバレッジで変わります。', text: '1米ドル150円・0.1ロット・25倍なら、1,000 × 150 ÷ 25 ＝ 6,000円。値動きの損益は15万円分の取引に対して生じます。' },
  ] },
  { icon: Target, label: 'PLAN AND LOOK BACK', title: '出口を決めて、結果を振り返る。', description: '利益を確定する「利確」と、損失を抑える「損切り」を注文と一緒に設定できます。', points: [
    { title: '到達したら、自動で決済。', text: '利確・損切りの設定価格に達すると決済します。値動きによっては設定した価格と差が出る場合があります。' },
    { title: '履歴を、自分の学びに。', text: '取引履歴で結果を見返せます。まずは小さなロットで、値動きと損益の関係を確かめましょう。' },
  ] },
  { icon: Gift, label: 'PRACTICE AND REWARDS', title: '経験を、ごほうびにつなげる。', description: '登録したアカウントで、練習の続きや成果を楽しめます。', points: [
    { title: '確定した仮想利益で、ショップへ。', text: '写真やファイル商品を選べます。ファイル商品は管理者の承認後に受け取ります。くじは、はずれでも仮想利益を消費します。' },
    { title: 'ひとつのページで、＋と−のランキング。', text: '同期済みの確定損益を集計します。ランキングには自動生成のトレーダー名を使い、メールアドレスや本名は表示しません。' },
  ] },
  { icon: UserRound, label: 'YOUR OWN JOURNEY', title: '自分のアカウントで、続きから。', description: '会員登録すると、練習データをアカウントに保存して、別の端末でも続きを練習できます。', points: [
    { title: 'Googleまたはメールアドレスで登録。', text: 'メールで登録したら、確認メール内のリンクを開いてください。迷惑メールフォルダもご確認ください。' },
    { title: 'ゲストでも、すぐに始められます。', text: '登録はあとからでも大丈夫です。ゲストの練習は、このブラウザに保存されます。' },
  ] },
]

export default function WelcomeTutorial({ request = 0, onRequestRegister, onRequestLogin }: Props) {
  const auth = useAuth()
  // Capture first-render eligibility so clearing an OAuth error cannot put this
  // guide over the account dialog that is already explaining that error.
  const [open, setOpen] = useState(() => !auth.user && !auth.loading && !auth.recovery && !auth.authError
    && !hasAccountCallback(window.location.href) && readOnboardingStatus() === 'unseen')
  const [step, setStep] = useState(0)
  const [online, setOnline] = useState(() => navigator.onLine)
  const previousRequest = useRef(request)
  const dialog = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const titleId = useId(), descriptionId = useId()
  const page = pages[step], Icon = page.icon
  const last = step === pages.length - 1

  const finish = () => { completeOnboarding(); setOpen(false); setStep(0) }
  const handoff = (action: (() => void) | undefined) => { finish(); action?.() }

  useEffect(() => {
    if (previousRequest.current === request) return
    previousRequest.current = request
    setStep(0); setOpen(true)
  }, [request])
  useEffect(() => {
    if (auth.recovery || auth.authError || auth.user) setOpen(false)
  }, [auth.recovery, auth.authError, auth.user?.id])
  useEffect(() => {
    const connection = () => setOnline(navigator.onLine)
    window.addEventListener('online', connection); window.addEventListener('offline', connection)
    return () => { window.removeEventListener('online', connection); window.removeEventListener('offline', connection) }
  }, [])
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.current?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); completeOnboarding(); setOpen(false); setStep(0); return }
      if (event.key !== 'Tab') return
      const nodes = dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]')
      if (!nodes?.length) { event.preventDefault(); return }
      const first = nodes[0], end = nodes[nodes.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); end.focus() }
      else if (!event.shiftKey && document.activeElement === end) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', keyboard)
    return () => {
      document.body.style.overflow = overflow
      window.removeEventListener('keydown', keyboard)
      if (!document.querySelector('[aria-modal="true"]')) {
        const candidates = [previous, document.querySelector<HTMLElement>('button[aria-label="メニューを開く"]'), document.querySelector<HTMLElement>('a.wordmark')]
        const target = candidates.find(element => {
          if (!element?.isConnected || element === document.body) return false
          const bounds = element.getBoundingClientRect()
          return bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.left < innerWidth && bounds.bottom > 0 && bounds.top < innerHeight
        })
        target?.focus()
      }
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    if (dialog.current) dialog.current.scrollTop = 0
    heading.current?.focus({ preventScroll: true })
  }, [open, step])

  if (!open) return null
  const canRegister = !auth.user && auth.configured && online && onRequestRegister
  const canLogIn = !auth.user && auth.configured && online && onRequestLogin
  return createPortal(<div className="welcome-backdrop"><div className="welcome-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
    <header className="welcome-header"><span className="welcome-brand"><Sprout size={16} aria-hidden="true" /> MANGO FX</span><button type="button" className="welcome-close" aria-label="チュートリアルを閉じる" onClick={finish}><X size={19} /></button></header>
    <div className="welcome-content" key={step}>
      <div className="welcome-mark"><Icon size={34} strokeWidth={1.5} aria-hidden="true" /></div>
      <span className="welcome-eyebrow">{page.label}</span>
      <h2 id={titleId} ref={heading} tabIndex={-1}>{page.title}</h2><p id={descriptionId} className="welcome-description">{page.description}</p>
      <div className="welcome-points">{page.points.map(point => <div className="welcome-point" key={point.title}><CheckCircle2 size={16} aria-hidden="true" /><div><h3>{point.title}</h3><p>{point.text}</p></div></div>)}</div>
      {last && <p className="welcome-account-note">{auth.user ? 'ログイン済みです。このまま自分の練習口座を利用できます。' : !auth.configured ? '会員登録は公開されたアプリで利用できます。この端末ではゲストとして練習できます。' : !online ? '会員登録にはインターネット接続が必要です。今はゲストとして練習できます。' : '登録者の同期済み確定損益は、自動生成のトレーダー名でランキングに表示されます。'}</p>}
    </div>
    <footer className="welcome-footer">
      <div className="welcome-pagination"><ol aria-label="案内の進み具合">{pages.map((item, index) => <li key={item.label} aria-current={index === step ? 'step' : undefined}><span className="welcome-step-dot" /><span className="welcome-sr-only">{index + 1}. {item.title}</span></li>)}</ol><p aria-live="polite">ステップ {step + 1} / {pages.length}</p></div>
      <div className="welcome-navigation"><button type="button" className="welcome-back" disabled={step === 0} onClick={() => setStep(value => Math.max(0, value - 1))}><ArrowLeft size={16} aria-hidden="true" />前に戻る</button>{last ? <button type="button" className="welcome-primary" onClick={() => canRegister ? handoff(onRequestRegister) : finish()}>{canRegister ? '会員登録へ進む' : auth.user ? '練習に戻る' : 'ゲストで始める'}<ArrowRight size={16} aria-hidden="true" /></button> : <button type="button" className="welcome-primary" onClick={() => setStep(value => Math.min(pages.length - 1, value + 1))}>次へ<ArrowRight size={16} aria-hidden="true" /></button>}</div>
      {last ? <div className="welcome-final-options">{canRegister && <button type="button" onClick={finish}>ゲストで始める</button>}{canLogIn && <button type="button" onClick={() => handoff(onRequestLogin)}>登録済みの方はログイン</button>}</div> : <button type="button" className="welcome-skip" onClick={finish}>チュートリアルをスキップ</button>}
      <p className="welcome-safety"><ShieldCheck size={12} aria-hidden="true" />仮想資金での練習です。実際のお金は使いません。</p>
    </footer>
  </div></div>, document.body)
}
