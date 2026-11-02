import { useEffect, useState, type ReactNode } from 'react'
import { Layers, LoaderCircle } from 'lucide-react'
import AccountMenu from '../components/AccountMenu'

/** One writer per account and browser profile; the cloud revision protects other devices. */
export default function AccountWorkspaceLock({ userId, children }: { userId: string; children: ReactNode }) {
  const [status, setStatus] = useState<'checking' | 'waiting' | 'active' | 'unsupported'>('checking')
  useEffect(() => {
    let disposed = false
    let release: (() => void) | undefined
    const abort = new AbortController()
    if (!navigator.locks) { setStatus('unsupported'); return }
    const timer = setTimeout(() => { if (!disposed) setStatus(current => current === 'checking' ? 'waiting' : current) }, 300)
    // A queued request takes over automatically when the previous tab closes.
    // Aborting the queue on cleanup also handles React StrictMode safely.
    void navigator.locks.request(`mango-fx-workspace:${userId}`, { mode: 'exclusive', signal: abort.signal }, async () => {
      if (disposed) return
      clearTimeout(timer)
      setStatus('active')
      await new Promise<void>(resolve => { release = resolve; if (disposed) resolve() })
    }).catch(error => {
      if (!disposed && !(error instanceof DOMException && error.name === 'AbortError')) setStatus('unsupported')
    })
    return () => { disposed = true; clearTimeout(timer); abort.abort(); release?.() }
  }, [userId])
  if (status === 'active') return children
  return <main className="workspace-loading"><header><a href="#">MANGO <span>FX</span></a><AccountMenu /></header><section>
    <div className="workspace-loading-mark">{status === 'checking' ? <LoaderCircle size={30} /> : <Layers size={30} />}</div>
    <h1>{status === 'checking' ? '口座を開いています' : status === 'waiting' ? 'この口座は別のタブで開いています' : 'このブラウザで個人口座を開けません'}</h1>
    <p>{status === 'waiting' ? '練習データを守るため、同じブラウザでは1つのタブで操作します。別のタブを閉じると、この画面で口座を開きます。' : status === 'unsupported' ? '最新版のChromeまたはEdgeで開き直してください。保存済みのデータはそのまま残っています。' : '保存した練習データを確認しています。'}</p>
  </section></main>
}
