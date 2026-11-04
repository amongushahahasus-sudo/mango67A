import { useEffect, useRef, useState } from 'react'
import { drawPhotoWatermark } from '../lib/photoWatermark'
import './ProtectedPhotoPreview.css'

interface Props { src: string; title: string; className?: string; eager?: boolean }

export default function ProtectedPhotoPreview({ src, title, className = '', eager = false }: Props) {
  const frame = useRef<HTMLSpanElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let active = true
    const image = new Image()
    image.crossOrigin = 'anonymous'
    setStatus('loading')
    image.onload = () => {
      if (!active || !canvas.current) return
      try {
        const surface = canvas.current
        if (!image.naturalWidth || !image.naturalHeight) throw new Error('Invalid preview')
        const ratio = Math.min(1, 640 / Math.max(image.naturalWidth, image.naturalHeight))
        surface.width = Math.max(1, Math.round(image.naturalWidth * ratio))
        surface.height = Math.max(1, Math.round(image.naturalHeight * ratio))
        const context = surface.getContext('2d')
        if (!context) throw new Error('Preview unavailable')
        context.drawImage(image, 0, 0, surface.width, surface.height)
        drawPhotoWatermark(context, surface.width, surface.height)
        setStatus('ready')
      } catch { setStatus('error') }
    }
    image.onerror = () => { if (active) setStatus('error') }
    const load = () => { image.src = src }
    let observer: IntersectionObserver | undefined
    if (eager || typeof IntersectionObserver === 'undefined' || !frame.current) load()
    else {
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); load() }
      }, { rootMargin: '300px' })
      observer.observe(frame.current)
    }
    return () => { active = false; observer?.disconnect(); image.onload = null; image.onerror = null }
  }, [src, eager])

  return <span ref={frame} className={`protected-photo-preview ${className}`} role="img" aria-label={`${title}（透かし入りプレビュー）`} aria-busy={status === 'loading'} data-preview-status={status} draggable={false} onContextMenu={event => event.preventDefault()} onDragStart={event => event.preventDefault()}>
    <canvas ref={canvas} width={1} height={1} aria-hidden="true" draggable={false} />
    {status !== 'ready' && <span className="protected-preview-message">{status === 'loading' ? 'プレビューを読み込み中' : 'プレビューを読み込めませんでした'}</span>}
  </span>
}
