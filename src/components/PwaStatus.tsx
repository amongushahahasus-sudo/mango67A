import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, RefreshCw, WifiOff, X } from 'lucide-react'
import { registerPwa } from '../lib/registerPwa'
import './PwaStatus.css'

export default function PwaStatus() {
  const [ready, setReady] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [waiting, setWaiting] = useState<ServiceWorkerRegistration | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [updating, setUpdating] = useState(false)
  const requestedUpdate = useRef(false)
  useEffect(() => {
    const onOnline = () => setOnline(true), onOffline = () => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    const cleanup = registerPwa({
      onOfflineReady: () => setReady(true),
      onNeedRefresh: registration => { setWaiting(registration); setDismissed(false) },
      onControllerChange: () => { if (requestedUpdate.current) window.location.reload() },
      onError: error => console.warn('オフライン保存を準備できませんでした。オンライン版は引き続き使えます。', error instanceof Error ? error.message : ''),
    })
    return () => { cleanup(); window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline) }
  }, [])
  const update = () => {
    if (!waiting?.waiting) { setWaiting(null); return }
    requestedUpdate.current = true
    setUpdating(true)
    waiting.waiting.postMessage({ type: 'SKIP_WAITING' })
  }
  return <>
    {(!online || ready) && <span className={`pwa-status ${online ? '' : 'pwa-status-offline'}`} title={online ? 'この端末への保存が完了しました。次回は通信なしでも開けます。' : ready ? '保存済みのアプリで練習を続けられます。' : '現在ネットワークに接続していません。'}>{online ? <CheckCircle2 size={14} /> : <WifiOff size={14} />}<span>{online ? 'オフライン対応' : 'オフライン'}</span></span>}
    {waiting && !dismissed && <aside className="pwa-update" role="status" aria-label="アプリの更新"><span className="pwa-update-icon"><RefreshCw size={20} /></span><div><strong>新しいバージョンを使えます</strong><p>取引データを保存したまま更新します。</p><div className="pwa-update-actions"><button className="pwa-update-primary" onClick={update} disabled={updating}>{updating ? '更新中…' : '更新する'}</button><button onClick={() => setDismissed(true)} disabled={updating}>あとで</button></div></div><button className="pwa-update-close" aria-label="更新のお知らせを閉じる" onClick={() => setDismissed(true)} disabled={updating}><X size={16} /></button></aside>}
  </>
}
