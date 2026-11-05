import { useCallback, useEffect, useRef, useState } from 'react'
import { CloudOff, LoaderCircle, LockKeyhole, RefreshCw, TrendingDown, TrendingUp, Trophy, UserRound } from 'lucide-react'
import { LeaderboardError, loadLeaderboard, type LeaderboardDirection, type LeaderboardSnapshot } from '../lib/leaderboard'
import './Leaderboard.css'

interface Props {
  userId: string | null
  onBeforeLoad?: () => Promise<void>
  onRequestLogin?: () => void
}
interface BoardState { snapshot: LeaderboardSnapshot | null; error: string; setup: boolean }
const blankBoard = (): BoardState => ({ snapshot: null, error: '', setup: false })
const directions: LeaderboardDirection[] = ['profit', 'loss']
const money = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toLocaleString('ja-JP', { maximumFractionDigits: 2 })} 円`
const time = (value: string) => new Date(value).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' })

export default function Leaderboard({ userId, onBeforeLoad, onRequestLogin }: Props) {
  const [boards, setBoards] = useState<Record<LeaderboardDirection, BoardState>>({ profit: blankBoard(), loss: blankBoard() })
  const [owner, setOwner] = useState(userId)
  const [loading, setLoading] = useState(false)
  const [warning, setWarning] = useState('')
  const identity = useRef(userId)
  identity.current = userId
  const epoch = useRef(0)
  const request = useRef(0)
  const busy = useRef(false)
  const beforeLoad = useRef(onBeforeLoad)
  beforeLoad.current = onBeforeLoad
  const scoped = owner === userId

  const reload = useCallback(async () => {
    if (!userId || busy.current) return
    const expectedUser = userId, version = epoch.current, requestId = ++request.current
    const current = () => identity.current === expectedUser && epoch.current === version && request.current === requestId
    busy.current = true
    setLoading(true); setWarning('')
    try {
      try { await beforeLoad.current?.() } catch {
        if (!current()) return
        setWarning('最新の練習データを同期できませんでした。クラウドに保存済みの確定損益を表示します。')
      }
      if (!current()) return
      await Promise.all(directions.map(async direction => {
        try {
          const snapshot = await loadLeaderboard(direction, expectedUser)
          if (current()) setBoards(previous => ({ ...previous, [direction]: { snapshot, error: '', setup: false } }))
        } catch (reason) {
          if (!current()) return
          setBoards(previous => ({ ...previous, [direction]: {
            snapshot: null,
            error: reason instanceof Error ? reason.message : 'ランキングを読み込めませんでした。もう一度お試しください。',
            setup: reason instanceof LeaderboardError && reason.code === 'setup',
          } }))
        }
      }))
    } finally {
      if (current()) { busy.current = false; setLoading(false) }
    }
  }, [userId])

  useEffect(() => {
    epoch.current += 1
    busy.current = false
    setOwner(userId); setBoards({ profit: blankBoard(), loss: blankBoard() }); setWarning(''); setLoading(Boolean(userId))
    if (userId) void reload()
    return () => { epoch.current += 1; request.current += 1; busy.current = false }
  }, [reload, userId])

  return <section className="leaderboard-page" aria-label="登録者ランキング">
    <div className="leaderboard-intro"><div><span className="leaderboard-eyebrow">LEARN TOGETHER</span><h2>練習の歩みを、みんなと。</h2><p>同期済みの確定損益（初期資金100万円からの増減）を集計します。含み損益は含みません。</p></div>
      {userId && <button type="button" className="leaderboard-refresh" disabled={loading || !scoped} onClick={() => { void reload() }}><RefreshCw size={15} className={loading || !scoped ? 'leaderboard-spinner' : ''} aria-hidden="true" />ランキングを更新</button>}
    </div>
    <p className="leaderboard-caption">登録者はランキング用の名前で表示します。プラスは利益の大きい順、マイナスは損失の大きい順です。損益が0円の口座は表示しません。</p>
    {!userId && <div className="leaderboard-login"><LockKeyhole size={22} aria-hidden="true" /><div><strong>ランキングを見るにはログインしてください。</strong><p>{onRequestLogin ? '登録したアカウントの練習結果を、ほかの参加者と見比べられます。' : 'アカウントとランキングは、公開HTTPS版のアプリで利用できます。'}</p></div>{onRequestLogin && <button type="button" onClick={onRequestLogin}>ログインする</button>}</div>}
    {scoped && warning && <p className="leaderboard-warning" role="status"><CloudOff size={16} aria-hidden="true" />{warning}</p>}
    <div className="leaderboard-columns">{directions.map(direction => {
      const board = scoped ? boards[direction] : blankBoard(), snapshot = board.snapshot, profit = direction === 'profit'
      return <section className={`leaderboard-board leaderboard-${direction}`} key={direction} aria-label={profit ? 'プラスランキング' : 'マイナスランキング'} aria-busy={Boolean(userId && (loading || !scoped))}>
        <div className="leaderboard-board-heading"><span className="leaderboard-board-icon">{profit ? <TrendingUp size={21} aria-hidden="true" /> : <TrendingDown size={21} aria-hidden="true" />}</span><div><h2>{profit ? '＋ランキング' : '−ランキング'}</h2><p>{profit ? '確定利益の大きい順' : '確定損失の大きい順'}</p></div>{snapshot && <span className="leaderboard-count">{snapshot.participantCount.toLocaleString('ja-JP')} 人</span>}</div>
        {!userId ? <div className="leaderboard-state"><LockKeyhole size={26} aria-hidden="true" /><p>ログイン後にランキングを表示します。</p></div>
          : board.error ? <div className="leaderboard-state"><Trophy size={27} aria-hidden="true" /><h3>{board.setup ? 'ランキングは準備中です' : 'ランキングを読み込めませんでした'}</h3><p role={board.setup ? 'status' : 'alert'}>{board.error}</p></div>
            : !snapshot ? <div className="leaderboard-state"><LoaderCircle size={27} className="leaderboard-spinner" aria-hidden="true" /><p>ランキングを読み込んでいます。</p></div>
              : <>
                <div className="leaderboard-own" aria-label={profit ? 'プラスランキングの自分の順位' : 'マイナスランキングの自分の順位'}><span><UserRound size={15} aria-hidden="true" />あなたの順位</span><strong>{snapshot.ownEntry ? <>{snapshot.ownEntry.rank.toLocaleString('ja-JP')}<small>位</small></> : '対象外'}</strong><p>確定損益 <b>{money(snapshot.myRealizedPnl)}</b></p></div>
                {snapshot.entries.length ? <ol className="leaderboard-list" aria-label={profit ? 'プラスの順位一覧' : 'マイナスの順位一覧'}>{snapshot.entries.map(entry => <li key={entry.position} className={entry.isMe ? 'leaderboard-is-me' : ''}>
                  <span className={`leaderboard-rank ${entry.rank <= 3 ? 'leaderboard-top-rank' : ''}`}><span className="sr-only">順位 </span>{entry.rank.toLocaleString('ja-JP')}<small>位</small></span><div className="leaderboard-trader"><span>{entry.displayName}</span>{entry.isMe && <small>あなた</small>}</div><strong className="leaderboard-pnl">{money(entry.realizedPnl)}</strong>
                </li>)}</ol> : <div className="leaderboard-state leaderboard-empty"><Trophy size={28} aria-hidden="true" /><h3>まだ参加者がいません</h3><p>{profit ? '確定損益がプラスになると、このランキングに表示されます。' : '確定損益がマイナスの参加者がいると、このランキングに表示されます。'}</p></div>}
                <p className="leaderboard-update">{time(snapshot.generatedAt)} 時点 · 上位100人まで表示{snapshot.ownEntry && snapshot.ownEntry.position > 100 ? ' · あなたの順位は全参加者から集計しています。' : ''}</p>
              </>}
      </section>
    })}</div>
    <p className="leaderboard-footnote">練習口座をリセットすると、その口座の新しい残高で集計します。練習用のシミュレーション結果です。</p>
  </section>
}
