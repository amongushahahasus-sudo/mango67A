import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDownLeft, ArrowRight, ArrowUpRight, BarChart3, BookOpen, Check, ChevronRight, CircleHelp, Clock3, Download, Expand, Gauge, History, Info, LayoutDashboard, Menu, Pause, Play, Plus, RotateCcw, Settings2, ShieldCheck, Sparkles, TrendingUp, Wallet, X } from 'lucide-react'
import PriceChart from './components/PriceChart'
import InstallApp from './components/InstallApp'
import PwaStatus from './components/PwaStatus'
import { createSavedState, loadSavedState, GUEST_STORAGE_KEY } from './lib/practiceState'
import type { SavedState, Timeframe } from './lib/practiceState'
import { PAIRS, nextCandle, getQuote, accountMetrics, marginRequired, unrealizedPnl, openMarketPosition, closePosition, placeOrder, cancelOrder, processMarket } from './lib/engine'
import type { Candle, CurrencyPair, Prices, Scenario, Side } from './lib/engine'

type Modal = 'guide' | 'settings' | 'reset' | null
const pairs = Object.keys(PAIRS) as CurrencyPair[]
const yen = (value: number, signed = false) => `${signed && value > 0 ? '+' : value < 0 ? '−' : ''}¥${Math.abs(Math.round(value)).toLocaleString('ja-JP')}`
const rate = (value: number, pair: CurrencyPair) => value.toFixed(PAIRS[pair].decimals)
const time = (timestamp: number) => new Date(timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tokyo' })
const datetime = (timestamp: number) => new Date(timestamp).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tokyo' })
const pricesOf = (markets: SavedState['markets']): Prices => Object.fromEntries(pairs.map(pair => [pair, markets[pair].at(-1)!.close])) as Prices
const scenarios: Record<Scenario, string> = { balanced: 'レンジ相場', bullish: '上昇トレンド', bearish: '下降トレンド', volatile: '高ボラティリティ' }
function aggregate(candles: Candle[], timeframe: Timeframe): Candle[] {
  const minutes = { '1m': 1, '5m': 5, '15m': 15, '1h': 60 }[timeframe]
  if (minutes === 1) return candles
  const result: Candle[] = []
  for (const candle of candles) {
    const bucket = Math.floor(candle.time / (minutes * 60_000)) * minutes * 60_000
    const last = result.at(-1)
    if (last?.time === bucket) { last.high = Math.max(last.high, candle.high); last.low = Math.min(last.low, candle.low); last.close = candle.close }
    else result.push({ ...candle, time: bucket })
  }
  return result
}
function Sparkline({ candles, positive }: { candles: Candle[]; positive: boolean }) {
  const values = candles.slice(-32).map(c => c.close)
  const min = Math.min(...values), span = Math.max(...values) - min || 1
  const points = values.map((v, i) => `${i * 96 / Math.max(values.length - 1, 1)},${30 - (v - min) / span * 26}`).join(' ')
  return <svg viewBox="0 0 96 34" className={`sparkline ${positive ? 'up' : 'down'}`} aria-hidden="true"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /></svg>
}
function CurrencyIcon({ pair, small = false }: { pair: CurrencyPair; small?: boolean }) {
  return <span className={`currency-icon ${small ? 'small' : ''}`} aria-hidden="true"><span>{pair.startsWith('USD') ? '🇺🇸' : pair.startsWith('EUR') ? '🇪🇺' : '🇬🇧'}</span><span>{pair.endsWith('JPY') ? '🇯🇵' : '🇺🇸'}</span></span>
}
const guideSteps = [
  { icon: Wallet, title: '仮想資金100万円からスタート', text: 'まずは通貨ペアと注文数量を選びます。このアプリの価格は生成されたシミュレーションレートです。入金や口座登録は必要ありません。' },
  { icon: ArrowUpRight, title: '上がると思えば「買い」、下がると思えば「売り」', text: '買いは価格が上がると利益に、売りは価格が下がると利益になります。買う価格（Ask）と売る価格（Bid）の差がスプレッド。約定直後の損益が少しマイナスになる理由です。' },
  { icon: Gauge, title: 'レバレッジと証拠金を知る', text: '1 lotは1万通貨、レバレッジは25倍です。たとえば1ドル150円で1 lotなら、150万円分の取引に約6万円の証拠金が必要です。値動きによる損益は150万円分に対して生じます。' },
  { icon: ShieldCheck, title: '出口を決めて、結果を振り返る', text: '利確・損切りを設定すると、到達時に自動で決済します。証拠金維持率が50%以下になると全建玉をロスカット。指値・逆指値は指定価格に達した時のレートで約定し、価格が飛ぶと指定値と差が出ます。' },
]

export interface AppProps {
  initialState?: SavedState
  storageKey?: string
  onStateChange?: (state: SavedState) => void
  accountControl?: ReactNode
  accountStatus?: string
  accountNotice?: ReactNode
  userLabel?: string
}
export default function App({ initialState, storageKey = GUEST_STORAGE_KEY, onStateChange, accountControl, accountStatus, accountNotice, userLabel }: AppProps = {}) {
  const [state, setState] = useState<SavedState>(() => initialState ?? loadSavedState(storageKey))
  const [view, setView] = useState<'trade' | 'learn'>('trade')
  const [modal, setModal] = useState<Modal>(null)
  const [side, setSide] = useState<Side>('buy')
  const [orderType, setOrderType] = useState<'market' | 'limit' | 'stop'>('market')
  const [lots, setLots] = useState('1')
  const [orderPrice, setOrderPrice] = useState('')
  const [withTargets, setWithTargets] = useState(false)
  const [takeProfit, setTakeProfit] = useState('')
  const [stopLoss, setStopLoss] = useState('')
  const [tab, setTab] = useState<'positions' | 'orders' | 'history'>('positions')
  const [error, setError] = useState('')
  const [toast, setToast] = useState<{ text: string; type: 'success' | 'info' } | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const [chartExpanded, setChartExpanded] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const marketEventRef = useRef(state.marketEvent?.id)
  const activityRef = useRef<HTMLElement>(null)
  const latest = useRef(state)
  const dialogRef = useRef<HTMLDivElement>(null)
  const lastFocused = useRef<HTMLElement | null>(null)
  latest.current = state
  const notify = (text: string, type: 'success' | 'info' = 'success') => setToast({ text, type })

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(state)); setSaveFailed(false) }
    catch { setSaveFailed(true) }
    onStateChange?.(state)
  }, [state, storageKey, onStateChange])
  useEffect(() => { if (!toast) return; const id = window.setTimeout(() => setToast(null), 5500); return () => clearTimeout(id) }, [toast])
  useEffect(() => {
    if (state.paused) return
    const id = window.setInterval(() => {
      setState(prev => {
        const markets = Object.fromEntries(pairs.map(pair => [pair, [...prev.markets[pair], nextCandle(prev.markets[pair].at(-1)!, pair, prev.scenario)].slice(-1440)])) as SavedState['markets']
        const prices = pricesOf(markets)
        const now = markets.USDJPY.at(-1)!.time
        const account = processMarket(prev.account, prices, now)
        const closed = account.history.filter(t => !prev.account.history.some(old => old.id === t.id))
        const triggered = prev.account.orders.filter(o => !account.orders.some(next => next.id === o.id))
        const opened = [...account.positions, ...closed].filter(p => !prev.account.positions.some(old => old.id === p.id) && p.openedAt === now)
        const cancelled = Math.max(0, triggered.length - opened.length)
        const messages = [closed.length ? `${closed.length}件を自動決済（${[...new Set(closed.map(t => t.reason))].join('・')}）。損益 ${yen(closed.reduce((sum,t) => sum+t.pnl,0),true)}` : '', opened.length ? `${opened.length}件の待機注文が約定しました。` : '', cancelled ? `${cancelled}件の待機注文を、証拠金不足または建玉上限のため取り消しました。` : ''].filter(Boolean)
        return { ...prev, markets, account, ...(messages.length ? { marketEvent: { id: now, text: messages.join(' ') } } : {}) }
      })
    }, 2000 / state.speed)
    return () => clearInterval(id)
  }, [state.paused, state.speed])
  useEffect(() => {
    if (state.marketEvent && state.marketEvent.id !== marketEventRef.current) {
      marketEventRef.current = state.marketEvent.id
      setToast({ text: state.marketEvent.text, type: 'info' })
    }
  }, [state.marketEvent])
  useEffect(() => {
    if (!modal) return
    lastFocused.current = document.activeElement as HTMLElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModal(null)
      if (event.key === 'Tab') {
        const nodes = dialogRef.current?.querySelectorAll<HTMLElement>('button, select, input, [tabindex="0"]')
        if (!nodes?.length) return
        const first = nodes[0], last = nodes[nodes.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', handler)
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', handler); lastFocused.current?.focus() }
  }, [modal])
  useEffect(() => { setError(''); setOrderPrice(''); setTakeProfit(''); setStopLoss('') }, [state.pair, side, orderType])

  const prices = pricesOf(state.markets)
  const pair = state.pair, metadata = PAIRS[pair], price = prices[pair], quote = getQuote(pair, price)
  const metrics = accountMetrics(state.account, prices)
  const totalPnl = metrics.equity - 1_000_000
  const change = (price - state.baseline[pair]) / state.baseline[pair] * 100
  const units = Number(lots) * 10_000
  const validUnits = Number.isFinite(units) && units >= 1000 && units <= 1_000_000 && Math.abs(units / 1000 - Math.round(units / 1000)) < 1e-8
  const requiredMargin = validUnits ? marginRequired(pair, Math.round(units), prices) : 0
  const spreadCost = validUnits ? quote.spread * units * (pair.endsWith('USD') ? prices.USDJPY : 1) : 0
  const wins = state.account.history.filter(t => t.pnl > 0).length
  const realizedPnl = state.account.balance - 1_000_000
  const simTime = state.markets[pair].at(-1)!.time
  const isLowMargin = state.account.positions.length > 0 && metrics.marginLevel < 150

  const selectPair = (next: CurrencyPair) => { setState(s => ({ ...s, pair: next })); setError('') }
  const submitOrder = () => {
    if (!validUnits) { setError('数量は0.1〜100 lotの範囲で、0.1 lot単位で入力してください。'); return }
    if (orderType !== 'market' && (!orderPrice.trim() || !Number.isFinite(Number(orderPrice)) || Number(orderPrice) <= 0)) { setError('有効な注文価格を入力してください。'); return }
    if (withTargets && ((takeProfit !== '' && (!Number.isFinite(Number(takeProfit)) || Number(takeProfit) <= 0)) || (stopLoss !== '' && (!Number.isFinite(Number(stopLoss)) || Number(stopLoss) <= 0)))) { setError('利確・損切り価格には0より大きい数値を入力してください。'); return }
    const current = latest.current, currentPrices = pricesOf(current.markets)
    const common = { pair: current.pair, side, units: Math.round(units), ...(withTargets && takeProfit ? { takeProfit: Number(takeProfit) } : {}), ...(withTargets && stopLoss ? { stopLoss: Number(stopLoss) } : {}) }
    const result = orderType === 'market'
      ? openMarketPosition(current.account, common, currentPrices, current.markets[current.pair].at(-1)!.time)
      : placeOrder(current.account, { ...common, type: orderType, price: Number(orderPrice) }, currentPrices, current.markets[current.pair].at(-1)!.time)
    if (result.error) { setError(result.error); return }
    setState(s => ({ ...s, account: result.account }))
    setError('')
    setTab(orderType === 'market' ? 'positions' : 'orders')
    notify(orderType === 'market' ? `${metadata.label}・${side === 'buy' ? '買い' : '売り'} ${lots} lot が約定しました。` : '注文を受け付けました。指定価格への到達を待っています。')
  }
  const handleClose = (id: string) => {
    const s = latest.current
    const next = closePosition(s.account, id, pricesOf(s.markets), '手動決済', s.markets[s.pair].at(-1)!.time)
    const trade = next.history.find(t => t.id === id)
    setState(prev => ({ ...prev, account: next }))
    notify(`決済しました${trade ? `。確定損益 ${yen(trade.pnl, true)}` : '。'}`)
  }
  const closeAll = () => {
    const s = latest.current, p = pricesOf(s.markets)
    const account = s.account.positions.reduce((acc, position) => closePosition(acc, position.id, p, '一括決済', simTime), s.account)
    setState(prev => ({ ...prev, account }))
    notify('すべての建玉を決済しました。')
  }
  const exportHistory = () => {
    const lines = [['通貨ペア','売買','通貨数量','約定価格','決済価格','確定損益(JPY)','注文日時','決済日時','決済理由'], ...state.account.history.map(t => [PAIRS[t.pair].label,t.side === 'buy' ? '買い' : '売り',t.units,t.entryPrice,t.exitPrice,Math.round(t.pnl),new Date(t.openedAt).toISOString(),new Date(t.closedAt).toISOString(),t.reason])]
    const csv = '\uFEFF' + lines.map(row => row.map(cell => `"${String(cell).replaceAll('"','""')}"`).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    const a = document.createElement('a'); a.href = url; a.download = 'mango-fx-trades.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    notify('取引履歴をCSVでダウンロードしました。')
  }
  const jumpHistory = () => { setView('trade'); setTab('history'); setMobileNav(false); setTimeout(() => activityRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50) }

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`} aria-label="メインナビゲーション">
      <button className="brand-icon" aria-label="MANGO FX ホーム" onClick={() => { setView('trade'); setMobileNav(false) }}><svg viewBox="0 0 32 32"><path d="M6 24V9l10 12L26 9v15" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
      <div className="nav-main">
        <button className={`nav-button ${view === 'trade' ? 'active' : ''}`} title="トレード" aria-label="トレード" onClick={() => { setView('trade'); setMobileNav(false) }}><LayoutDashboard size={21} /><span>トレード</span></button>
        <button className="nav-button" title="取引履歴" aria-label="取引履歴へ移動" onClick={jumpHistory}><History size={21} /><span>取引履歴</span></button>
        <button className={`nav-button ${view === 'learn' ? 'active' : ''}`} title="学習ガイド" aria-label="学習ガイド" onClick={() => { setView('learn'); setMobileNav(false) }}><BookOpen size={21} /><span>学ぶ</span></button>
      </div>
      <div className="nav-bottom"><button className="nav-button" title="シミュレーター設定" aria-label="シミュレーター設定" onClick={() => setModal('settings')}><Settings2 size={20} /><span>設定</span></button><div className="avatar" title={userLabel || "ゲスト練習用アカウント"}>{userLabel?.slice(0,1).toUpperCase() || "M"}</div></div>
    </aside>

    <div className="workspace">
      <header className="topbar">
        <div className="topbar-left"><button className="icon-button mobile-menu" aria-label="メニューを開く" onClick={() => setMobileNav(!mobileNav)}><Menu size={20} /></button><a className="wordmark" href="#" onClick={e => { e.preventDefault(); setView('trade') }}>MANGO<span>FX</span></a><span className="header-divider" /><span className="workspace-label">トレーディング・スタジオ</span></div>
        <div className="topbar-right"><PwaStatus /><InstallApp />{accountControl}<span className="practice-badge"><span />DEMO ACCOUNT</span><button className="help-button" onClick={() => setModal('guide')}><CircleHelp size={16} /><span>使い方</span></button></div>
      </header>
      <main>
        <section className="page-heading"><div><div className="eyebrow"><span className="tiny-dot" /> YOUR NEXT CHAPTER STARTS HERE</div><h1>{view === 'trade' ? <>リスクの前に、<span>経験を。</span></> : <>FXを知る。<span>自信に変える。</span></>}</h1><p>{view === 'trade' ? '仮想資金100万円で、相場と向き合う練習を。' : 'はじめの一歩から、取引を振り返るところまで。'}</p></div><div className="simulation-label"><ShieldCheck size={17} /><div><strong>練習だけに、集中できる。</strong><span>登録不要 · 実際の資金は使いません</span></div></div></section>
        {accountNotice}
        {saveFailed && <div className="notice-banner" role="alert"><Info size={17} />このブラウザでは進捗を保存できません。ページを閉じると現在の取引が失われます。</div>}
        {view === 'learn' ? <section className="learn-page"><div className="learn-hero"><div className="learn-icon"><BookOpen size={32} /></div><div><span className="eyebrow">THE BASICS</span><h2>しくみがわかると、取引が変わる。</h2><p>4つのポイントを押さえて、小さな数量から試してみましょう。</p></div></div><div className="lesson-grid">{guideSteps.map((step, index) => <article className="lesson-card" key={step.title}><div className="lesson-top"><step.icon size={25} /><span>0{index+1}</span></div><h3>{step.title}</h3><p>{step.text}</p></article>)}</div><div className="panel assumptions"><h3><Info size={18} />このシミュレーターの取引ルール</h3><p>価格はモデルが生成する練習用データで、実際の為替レートではありません。初期資金100万円、レバレッジ25倍、1 lot＝1万通貨。スプレッドは固定で、取引手数料・スワップ・税金は計算に含みません。EUR/USDの損益はUSD/JPYで円換算します。</p><p>相場は2秒で1分進みます（通常速度）。停止中でも注文・決済できます。指値・逆指値、利確・損切りは各更新時の売買可能なBid/Askで判定し、その時のレートで約定します。待機注文の証拠金は約定時に確認し、不足する注文はキャンセルされます。実際の市場の流動性や通信遅延は再現しません。</p><button className="primary-button" onClick={() => setView('trade')}>トレードを始める<ArrowRight size={17} /></button></div></section> : <>
          <section className="account-grid" aria-label="口座状況">
            <article className="stat-card"><div className="stat-top"><span>純資産</span><Wallet size={16} /></div><div className="stat-value">{yen(metrics.equity)}</div><div className="stat-caption"><span className={totalPnl >= 0 ? 'text-up' : 'text-down'}>{totalPnl >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownLeft size={13} />}{yen(totalPnl, true)}</span><span>開始時から</span></div></article>
            <article className="stat-card"><div className="stat-top"><span>評価損益</span><TrendingUp size={16} /></div><div className={`stat-value ${metrics.unrealizedPnl >= 0 ? 'text-up' : 'text-down'}`}>{yen(metrics.unrealizedPnl, true)}</div><div className="stat-caption">保有中の建玉 <strong>{state.account.positions.length}</strong> 件</div></article>
            <article className="stat-card"><div className="stat-top"><span>利用可能な証拠金</span><ShieldCheck size={16} /></div><div className="stat-value">{yen(metrics.freeMargin)}</div><div className="stat-caption">使用中 <span>{yen(metrics.usedMargin)}</span></div></article>
            <article className={`stat-card ${isLowMargin ? 'warning-stat' : ''}`}><div className="stat-top"><span>証拠金維持率</span><Gauge size={16} /></div><div className="stat-value">{Number.isFinite(metrics.marginLevel) ? <>{metrics.marginLevel.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}<small>%</small></> : <><span className="empty-stat">—</span><small>%</small></>}</div><div className="stat-caption"><span className={`status-dot ${isLowMargin ? 'danger' : ''}`} />{state.account.positions.length === 0 ? '建玉なし · 余裕のある状態' : isLowMargin ? '維持率に注意 · 50%でロスカット' : '良好 · 50%でロスカット'}</div></article>
          </section>

          <section className="market-section" aria-label="マーケット">
            <div className="section-heading"><h2>マーケット <span className="section-tag">SIMULATED</span></h2><span className="market-note"><span className={`status-dot ${state.paused ? 'paused' : ''}`} />{state.paused ? '一時停止中' : 'シミュレーション稼働中'}</span></div>
            <div className="pair-grid">{pairs.map(p => { const up = prices[p] >= state.baseline[p]; const percent = (prices[p] / state.baseline[p] - 1) * 100; return <button key={p} className={`pair-card ${p === pair ? 'selected' : ''}`} aria-pressed={p === pair} onClick={() => selectPair(p)}><div className="pair-top"><CurrencyIcon pair={p} small /><strong>{PAIRS[p].label}</strong><span className="pair-name">{p.startsWith('USD') ? '米ドル' : p.startsWith('EUR') ? 'ユーロ' : '英ポンド'} / {p.endsWith('JPY') ? '円' : '米ドル'}</span>{p === pair && <span className="selected-indicator" />}</div><div className="pair-bottom"><div><div className="pair-price">{rate(prices[p], p)}</div><span className={up ? 'text-up' : 'text-down'}>{up ? '+' : ''}{percent.toFixed(2)}% <span className="since-label">開始比</span></span></div><Sparkline candles={state.markets[p]} positive={up} /></div></button> })}</div>
          </section>

          <div className={`trading-layout ${chartExpanded ? 'chart-is-expanded' : ''}`}>
            <div className="market-column">
              <section className="panel chart-panel">
                <div className="chart-instrument"><div className="instrument-info"><CurrencyIcon pair={pair} /><div><div className="instrument-name">{metadata.label}<span>FX</span></div><span className="instrument-subtitle">{pair.startsWith('USD') ? '米ドル' : pair.startsWith('EUR') ? 'ユーロ' : '英ポンド'} / {pair.endsWith('JPY') ? '日本円' : '米ドル'}</span></div><div className="instrument-price"><strong>{rate(price, pair)}</strong><span className={change >= 0 ? 'text-up' : 'text-down'}>{change >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownLeft size={13} />}{change >= 0 ? '+' : ''}{change.toFixed(2)}%</span></div></div><button className="icon-button" aria-label={chartExpanded ? 'チャートの拡大を終了' : 'チャートを拡大'} onClick={() => setChartExpanded(!chartExpanded)}><Expand size={17} /></button></div>
                <PriceChart pair={pair} candles={aggregate(state.markets[pair], state.timeframe)} positions={state.account.positions.filter(p => p.pair === pair)} timeframe={state.timeframe} onTimeframeChange={timeframe => setState(s => ({ ...s, timeframe }))} />
                <div className="playback-bar"><div className="playback-left"><button className={`play-button ${state.paused ? 'paused' : ''}`} aria-label={state.paused ? '相場を再生' : '相場を一時停止'} onClick={() => setState(s => ({ ...s, paused: !s.paused }))}>{state.paused ? <Play size={14} fill="currentColor" /> : <Pause size={14} fill="currentColor" />}</button><div className="speed-control" aria-label="再生速度">{[1,2,5].map(speed => <button className={state.speed === speed ? 'active' : ''} key={speed} onClick={() => setState(s => ({ ...s, speed }))} aria-pressed={state.speed === speed}>×{speed}</button>)}</div><span className="playback-description">2秒 = {state.speed}分</span></div><div className="sim-clock"><Clock3 size={13} /><span>相場内時刻 {time(simTime)}</span><span className="utc-note">JST</span></div></div>
              </section>

              <section className="panel activity-panel" ref={activityRef} aria-label="取引管理">
                <div className="activity-heading"><div className="activity-tabs" role="tablist" aria-label="取引一覧"><button role="tab" aria-selected={tab === 'positions'} onClick={() => setTab('positions')}>建玉<span>{state.account.positions.length}</span></button><button role="tab" aria-selected={tab === 'orders'} onClick={() => setTab('orders')}>注文中<span>{state.account.orders.length}</span></button><button role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>取引履歴<span>{state.account.history.length}</span></button></div>{tab === 'positions' && state.account.positions.length > 0 ? <button className="text-button" onClick={closeAll}>すべて決済</button> : tab === 'history' && state.account.history.length > 0 ? <button className="text-button" onClick={exportHistory} aria-label="取引履歴をCSV出力"><Download size={13} />CSV</button> : null}</div>
                <div role="tabpanel">
                  {tab === 'positions' && (state.account.positions.length ? <div className="table-scroll"><table><thead><tr><th>通貨ペア / 売買</th><th>数量</th><th>約定価格</th><th>現在価格</th><th>評価損益</th><th>決済</th></tr></thead><tbody>{state.account.positions.map(position => { const pnl = unrealizedPnl(position, prices); const q = getQuote(position.pair, prices[position.pair]); return <tr key={position.id}><td><div className="table-pair">{PAIRS[position.pair].label}<span className={`side-tag ${position.side}`}>{position.side === 'buy' ? '買' : '売'}</span></div><div className="table-note">{position.stopLoss ? `SL ${rate(position.stopLoss,position.pair)}` : 'SL 未設定'} · {position.takeProfit ? `TP ${rate(position.takeProfit,position.pair)}` : 'TP 未設定'}</div></td><td>{(position.units/10000).toLocaleString()}<span className="table-note"> lot</span></td><td>{rate(position.entryPrice,position.pair)}</td><td>{rate(position.side === 'buy' ? q.bid : q.ask,position.pair)}</td><td className={pnl>=0?'text-up':'text-down'}>{yen(pnl,true)}</td><td><button className="close-position" onClick={() => handleClose(position.id)} aria-label={`${PAIRS[position.pair].label}の${position.side === 'buy' ? '買い' : '売り'}建玉を決済`}>決済</button></td></tr> })}</tbody></table></div> : <EmptyState icon="position" title="まだ、ポジションはありません" text="右の注文パネルから、最初のトレードを始めてみましょう。" />)}
                  {tab === 'orders' && (state.account.orders.length ? <div className="table-scroll"><table><thead><tr><th>通貨ペア / 売買</th><th>注文種別</th><th>数量</th><th>注文価格</th><th>操作</th></tr></thead><tbody>{state.account.orders.map(order => <tr key={order.id}><td><div className="table-pair">{PAIRS[order.pair].label}<span className={`side-tag ${order.side}`}>{order.side==='buy'?'買':'売'}</span></div></td><td>{order.type==='limit'?'指値':'逆指値'}</td><td>{order.units/10000} lot</td><td>{rate(order.price,order.pair)}</td><td><button className="close-position" onClick={() => { setState(s => ({ ...s, account: cancelOrder(s.account,order.id) })); notify('注文を取り消しました。','info') }}>取消</button></td></tr>)}</tbody></table></div> : <EmptyState icon="order" title="待機中の注文はありません" text="指値・逆指値注文なら、狙った価格で取引を始められます。" />)}
                  {tab === 'history' && (state.account.history.length ? <><div className="history-summary"><span>確定損益 <strong className={realizedPnl>=0?'text-up':'text-down'}>{yen(realizedPnl,true)}</strong></span><span>勝率 <strong>{(wins/state.account.history.length*100).toFixed(0)}%</strong></span><span>{state.account.history.length}取引</span></div><div className="table-scroll"><table><thead><tr><th>通貨ペア / 売買</th><th>約定 → 決済</th><th>確定損益</th><th>日時 / 理由</th></tr></thead><tbody>{[...state.account.history].sort((a,b)=>b.closedAt-a.closedAt).map(trade => <tr key={trade.id}><td><div className="table-pair">{PAIRS[trade.pair].label}<span className={`side-tag ${trade.side}`}>{trade.side==='buy'?'買':'売'}</span></div><div className="table-note">{trade.units/10000} lot</div></td><td>{rate(trade.entryPrice,trade.pair)} <span className="muted">→</span> {rate(trade.exitPrice,trade.pair)}</td><td className={trade.pnl>=0?'text-up':'text-down'}>{yen(trade.pnl,true)}</td><td>{datetime(trade.closedAt)}<div className="table-note">{trade.reason}</div></td></tr>)}</tbody></table></div></> : <EmptyState icon="history" title="経験は、ここに積み重なります" text="建玉を決済すると、損益と取引の記録を振り返れます。" />)}
                </div>
                <div className="activity-footer"><span><span className="status-dot" />{saveFailed ? '保存できません' : accountStatus || 'このブラウザに自動保存'}</span><span>口座残高 <strong>{yen(state.account.balance)}</strong></span></div>
              </section>
            </div>

            <aside className="order-column">
              <section className="panel order-panel" aria-label="新規注文">
                <div className="order-heading"><h2>新規注文</h2><span className="order-pair-label">{metadata.label}</span></div>
                <div className="quote-buttons"><button className={`quote-button sell ${side==='sell'?'active':''}`} aria-pressed={side==='sell'} onClick={()=>setSide('sell')}><span>売り <small>SELL / BID</small></span><strong>{rate(quote.bid,pair)}</strong></button><div className="spread-pill" title="固定スプレッド">{(quote.spread/metadata.pipSize).toFixed(1)}<small>pips</small></div><button className={`quote-button buy ${side==='buy'?'active':''}`} aria-pressed={side==='buy'} onClick={()=>setSide('buy')}><span>買い <small>BUY / ASK</small></span><strong>{rate(quote.ask,pair)}</strong></button></div>
                <div className="order-type-tabs" aria-label="注文種別">{(['market','limit','stop'] as const).map(type=><button key={type} className={orderType===type?'active':''} onClick={()=>setOrderType(type)} aria-pressed={orderType===type}>{type==='market'?'成行':type==='limit'?'指値':'逆指値'}</button>)}</div>
                <p className="order-type-hint">{orderType==='market'?'現在のレートですぐに注文します。':orderType==='limit'?'現在より有利な価格になったら注文します。':'指定した方向に価格が動いたら注文します。'}</p>
                <form onSubmit={event=>{event.preventDefault();submitOrder()}} noValidate>
                  {orderType!=='market'&&<label className="field-label">注文価格<span>{metadata.quote}</span><div className="number-field"><input aria-label="注文価格" type="number" min="0" step={10**-metadata.decimals} placeholder={rate(price,pair)} value={orderPrice} onChange={e=>{setOrderPrice(e.target.value);setError('')}} /></div></label>}
                  <label className="field-label">取引数量<span>1 lot = 10,000通貨</span><div className="number-field"><button type="button" aria-label="数量を0.1 lot減らす" onClick={()=>setLots(v=>Math.max(0.1,(Number(v)||0)-0.1).toFixed(1))}>−</button><input aria-label="取引数量（lot）" type="number" step="0.1" min="0.1" max="100" value={lots} onChange={e=>{setLots(e.target.value);setError('')}} /><span>lot</span><button type="button" aria-label="数量を0.1 lot増やす" onClick={()=>setLots(v=>Math.min(100,(Number(v)||0)+0.1).toFixed(1))}><Plus size={15}/></button></div></label>
                  <div className="quantity-presets">{['0.1','1','5'].map(lot=><button key={lot} type="button" className={Number(lots)===Number(lot)?'active':''} onClick={()=>{setLots(lot);setError('')}}>{lot} lot</button>)}<span>{validUnits ? Math.round(units).toLocaleString() : '—'} 通貨</span></div>
                  <label className="target-toggle"><input type="checkbox" checked={withTargets} onChange={e=>setWithTargets(e.target.checked)} /><span className="custom-checkbox">{withTargets&&<Check size={11}/>}</span><span>利確・損切りを設定</span><ShieldCheck size={14}/></label>
                  {withTargets&&<div className="target-fields"><label className="field-label">利確価格 <span>TP / 任意</span><input aria-label="利確価格" type="number" min="0" step={10**-metadata.decimals} placeholder="未設定" value={takeProfit} onChange={e=>setTakeProfit(e.target.value)}/></label><label className="field-label">損切り価格 <span>SL / 任意</span><input aria-label="損切り価格" type="number" min="0" step={10**-metadata.decimals} placeholder="未設定" value={stopLoss} onChange={e=>setStopLoss(e.target.value)}/></label></div>}
                  <div className="order-estimate"><div><span>必要証拠金 {orderType!=='market'&&<small>（現在値概算）</small>}<Info size={12}/></span><strong>{yen(requiredMargin)}</strong></div><div><span>スプレッド相当額</span><span>約 {yen(spreadCost)}</span></div><div><span>レバレッジ</span><span>25倍</span></div></div>
                  {error&&<div className="order-error" role="alert"><Info size={15}/>{error}</div>}
                  <button type="submit" className={`submit-order ${side}`}><span>{side==='buy'?<ArrowUpRight size={19}/>:<ArrowDownLeft size={19}/>} {side==='buy'?'買い':'売り'}注文を出す</span><ArrowRight size={17}/></button>
                  <p className="virtual-note"><ShieldCheck size={11}/>仮想資金での取引です</p>
                </form>
              </section>
              <section className="learning-card"><div className="learning-card-top"><span className="learn-mini-icon"><BookOpen size={17}/></span><span>LEARN AS YOU TRADE</span><Sparkles size={15}/></div><h3>その一歩を、<br/>確かな学びに。</h3><p>スプレッド、証拠金、損益。<br/>取引のしくみをやさしく解説。</p><button onClick={()=>setModal('guide')}>はじめてのFXガイド<ArrowUpRight size={16}/></button><div className="learning-decoration" aria-hidden="true"><div/><div/><div/><div/><div/></div></section>
            </aside>
          </div>
          <div className="bottom-note"><Info size={13}/><span>表示レートはシミュレーションです。固定スプレッド・レバレッジ25倍。スワップ、税金、取引手数料は含みません。</span><button onClick={()=>setView('learn')}>取引ルール<ChevronRight size={12}/></button></div>
        </>}
        <footer className="page-footer"><span>MANGO FX <span>Practice makes progress.</span></span><span>少しずつ、あなたのペースで。<span className="footer-dot"/>SIMULATION ONLY</span></footer>
      </main>
    </div>
    {toast&&<div className={`toast ${toast.type}`} role="status"><span>{toast.type==='success'?<Check size={17}/>:<Info size={17}/>}</span>{toast.text}<button aria-label="通知を閉じる" onClick={()=>setToast(null)}><X size={15}/></button></div>}
    {modal&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(null)}}><div className={`modal ${modal==='guide'?'guide-modal':''}`} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="modal-title" tabIndex={-1}><button className="modal-close icon-button" aria-label="閉じる" onClick={()=>setModal(null)}><X size={20}/></button>
      {modal==='guide'?<><span className="modal-eyebrow"><BookOpen size={17}/> MANGO FX GUIDE</span><h2 id="modal-title">最初のトレードを、ここから。</h2><p className="modal-subtitle">4つのポイントでわかる、FXの基本。</p><div className="guide-steps">{guideSteps.map((step,i)=><article key={step.title}><span className="step-number">0{i+1}</span><div><h3>{step.title}</h3><p>{step.text}</p></div></article>)}</div><button className="primary-button full-width" onClick={()=>{setModal(null);setView('trade')}}>わかった、試してみる<ArrowRight size={17}/></button></>:modal==='settings'?<><span className="modal-eyebrow"><Settings2 size={17}/> SIMULATION SETTINGS</span><h2 id="modal-title">自分に合う練習環境に。</h2><p className="modal-subtitle">相場のシナリオは、いつでも変更できます。</p><label className="settings-label">相場シナリオ<select value={state.scenario} onChange={e=>setState(s=>({...s,scenario:e.target.value as Scenario}))}>{Object.entries(scenarios).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label><p className="settings-hint">{state.scenario==='balanced'?'方向感の少ない相場で、値動きの幅を観察します。':state.scenario==='bullish'?'緩やかな上昇傾向。短期的には下がることもあります。':state.scenario==='bearish'?'緩やかな下降傾向。短期的には上がることもあります。':'変動が大きい相場。数量や損切りの大切さを体験します。'}</p><div className="settings-info"><div><span>口座通貨</span><strong>日本円（JPY）</strong></div><div><span>レバレッジ</span><strong>25倍（固定）</strong></div><div><span>ロスカット水準</span><strong>証拠金維持率 50%</strong></div><div><span>保存先</span><strong>この端末のブラウザ</strong></div></div><button className="reset-button" onClick={()=>setModal('reset')}><RotateCcw size={16}/>練習をリセットする</button><p className="settings-hint">履歴・建玉・注文を消去して、仮想資金100万円から再開します。</p><button className="primary-button full-width" onClick={()=>setModal(null)}>設定を閉じる<Check size={16}/></button></>:<><span className="reset-modal-icon"><RotateCcw size={26}/></span><h2 id="modal-title">もう一度、はじめから。</h2><p className="modal-subtitle">すべての建玉・注文・取引履歴を消去します。仮想資金は100万円に戻ります。この操作は取り消せません。</p><div className="reset-modal-actions"><button className="secondary-button" onClick={()=>setModal('settings')}>キャンセル</button><button className="danger-button" onClick={()=>{setState(createSavedState());setSide('buy');setOrderType('market');setLots('1');setWithTargets(false);setTakeProfit('');setStopLoss('');setTab('positions');setError('');setModal(null);notify('練習をリセットしました。新しい一歩を始めましょう。','info')}}>リセットする</button></div></>}
    </div></div>}
  </div>
}

function EmptyState({ icon, title, text }: { icon: 'position' | 'order' | 'history'; title: string; text: string }) {
  return <div className="empty-state"><div className="empty-icon">{icon==='position'?<BarChart3 size={23}/>:icon==='order'?<Clock3 size={23}/>:<History size={23}/>}<span><Plus size={10}/></span></div><h3>{title}</h3><p>{text}</p><span className="empty-hint">YOUR TRADING JOURNEY STARTS HERE</span></div>
}
