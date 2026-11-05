import { useLayoutEffect, useRef, type RefObject } from 'react'
import './SlidingNavigation.css'

interface Props {
  containerRef: RefObject<HTMLDivElement | null>
  activePage: string
}
interface Position { left: number; top: number; width: number; height: number }

/** A single decorative selection follows the buttons without moving their hit areas. */
export default function SlidingNavigation({ containerRef, activePage }: Props) {
  const marker = useRef<HTMLSpanElement>(null)
  const currentPage = useRef(activePage)
  const measure = useRef<() => void>(() => {})
  currentPage.current = activePage

  useLayoutEffect(() => {
    const element = marker.current
    // The child's layout effect can precede attachment of its parent's ref.
    const container = containerRef.current ?? element?.parentElement
    if (!element || !container) return

    const originalReady = container.getAttribute('data-page-navigation')
    let disposed = false
    let position: Position | null = null
    let frame: number | null = null
    let secondFrame: number | null = null
    const update = () => {
      if (disposed) return
      const button = Array.from(container.querySelectorAll<HTMLElement>('[data-page-button]'))
        .find(candidate => candidate.dataset.pageButton === currentPage.current)
      if (!button) { container.removeAttribute('data-page-navigation'); return }
      const bounds = button.getBoundingClientRect()
      const parent = container.getBoundingClientRect()
      if (bounds.width <= 0 || bounds.height <= 0) { container.removeAttribute('data-page-navigation'); return }
      const next: Position = { left: bounds.left - parent.left, top: bounds.top - parent.top, width: bounds.width, height: bounds.height }
      if (!position || Object.keys(next).some(key => Math.abs(next[key as keyof Position] - position![key as keyof Position]) > .1)) {
        element.style.width = `${next.width}px`
        element.style.height = `${next.height}px`
        element.style.transform = `translate(${next.left}px, ${next.top}px)`
        if (!position) {
          element.dataset.positioned = 'true'
          // Establish the first position before enabling transitions.
          frame = requestAnimationFrame(() => {
            secondFrame = requestAnimationFrame(() => { if (!disposed) element.dataset.animated = 'true' })
          })
        }
        position = next
      }
      container.dataset.pageNavigation = 'ready'
    }

    measure.current = update
    update()
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
    resize?.observe(container)
    const mutations = typeof MutationObserver === 'function' ? new MutationObserver(update) : null
    mutations?.observe(container, { childList: true, subtree: true })
    window.addEventListener('resize', update)
    return () => {
      disposed = true
      measure.current = () => {}
      resize?.disconnect()
      mutations?.disconnect()
      window.removeEventListener('resize', update)
      if (frame !== null) cancelAnimationFrame(frame)
      if (secondFrame !== null) cancelAnimationFrame(secondFrame)
      delete element.dataset.animated
      delete element.dataset.positioned
      if (originalReady === null) container.removeAttribute('data-page-navigation')
      else container.setAttribute('data-page-navigation', originalReady)
    }
  }, [containerRef])

  useLayoutEffect(() => { measure.current() }, [activePage])

  return <span className="nav-active-indicator" ref={marker} aria-hidden="true" />
}
