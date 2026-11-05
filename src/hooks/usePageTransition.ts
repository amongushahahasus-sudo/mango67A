import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import '../components/PageTransition.css'

interface Options { direction?: 1 | -1; onCommitted?: () => void }
interface Navigation<T> extends Options { next: T; commit: () => void; committed: boolean }
interface StyleValue { name: string; value: string; priority: string }
interface Session {
  element: HTMLElement
  stage: HTMLElement
  styles: StyleValue[]
  inert: boolean
  busy: string | null
  stageState: string | null
  focusWasInside: boolean
  baseTransform: string
  baseOpacity: string
  motion: MediaQueryList
  motionChanged: () => void
  blockInput: (event: Event) => void
}
interface Runtime<T> {
  mounted: boolean
  request: Navigation<T> | null
  animation: Animation | null
  session: Session | null
}

/** Slide the existing page out before committing its replacement. */
export function usePageTransition<T extends string>(
  target: RefObject<HTMLElement | null>, stage: RefObject<HTMLElement | null>, page: T,
) {
  const currentPage = useRef(page)
  currentPage.current = page
  const [pendingPage, setPendingPage] = useState<T | null>(null)
  const runtime = useRef<Runtime<T>>({ mounted: true, request: null, animation: null, session: null })

  const navigate = useCallback((next: T, commit: () => void, options: Options = {}) => {
    const state = runtime.current
    if (!state.mounted) return
    const request: Navigation<T> = { next, commit, ...options, committed: false }
    state.request = request
    setPendingPage(next)
    const current = () => state.mounted && state.request === request

    const cancelAnimation = () => {
      const animation = state.animation
      state.animation = null
      animation?.cancel()
    }
    const commitPage = () => {
      if (!current() || request.committed) return
      request.committed = true
      flushSync(request.commit)
      if (!current()) return
      currentPage.current = request.next
      request.onCommitted?.()
    }
    const finish = () => {
      if (!current()) return
      state.request = null
      cancelAnimation()
      restoreSession(state)
      setPendingPage(null)
    }
    const settleImmediately = () => {
      if (!current()) return
      cancelAnimation()
      try { commitPage() } finally { finish() }
    }

    if (!state.session && next === currentPage.current) { settleImmediately(); return }
    const element = target.current, frame = stage.current
    let motion: MediaQueryList | null = null
    try { motion = window.matchMedia('(prefers-reduced-motion: reduce)') } catch { /* Immediate navigation remains available. */ }
    if (!element || !frame || typeof element.animate !== 'function' || !motion || motion.matches) {
      settleImmediately()
      return
    }
    const motionQuery = motion

    const originalStyles = state.session ? [] : ['transform', 'opacity', 'will-change', 'pointer-events'].map(name => ({
      name, value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name),
    }))
    // Freeze the current visual position before replacing an in-flight intent.
    const visual = getComputedStyle(element)
    const from = { transform: visual.transform, opacity: visual.opacity }
    element.style.transform = from.transform
    element.style.opacity = from.opacity
    cancelAnimation()

    if (!state.session) {
      const focus = document.activeElement
      const blockInput = (event: Event) => { event.preventDefault(); event.stopPropagation() }
      const session: Session = {
        element, stage: frame, styles: originalStyles,
        inert: element.inert, busy: element.getAttribute('aria-busy'), stageState: frame.getAttribute('data-transitioning'),
        focusWasInside: Boolean(focus && element.contains(focus)),
        baseTransform: from.transform, baseOpacity: from.opacity, motion: motionQuery,
        motionChanged: () => {
          if (!motionQuery.matches) return
          const latest = state.request
          if (!latest || !state.mounted) return
          state.animation?.cancel()
          state.animation = null
          try {
            if (!latest.committed) {
              latest.committed = true
              flushSync(latest.commit)
              if (state.request === latest && state.mounted) {
                currentPage.current = latest.next
                latest.onCommitted?.()
              }
            }
          } finally {
            if (state.request === latest && state.mounted) {
              state.request = null
              restoreSession(state)
              setPendingPage(null)
            }
          }
        },
        blockInput,
      }
      state.session = session
      if (session.focusWasInside && focus instanceof HTMLElement) focus.blur()
      element.inert = true
      element.setAttribute('aria-busy', 'true')
      element.style.pointerEvents = 'none'
      element.style.willChange = 'transform, opacity'
      frame.setAttribute('data-transitioning', 'true')
      element.addEventListener('click', blockInput, true)
      element.addEventListener('keydown', blockInput, true)
      motionQuery.addEventListener?.('change', session.motionChanged)
      element.style.transform = from.transform
      element.style.opacity = from.opacity
    }

    const session = state.session
    const direction = options.direction ?? 1
    const distance = Math.min(110, Math.max(60, frame.clientWidth * 0.16))
    const offset = (value: number) => `${session.baseTransform === 'none' ? '' : session.baseTransform} translate3d(${value}px, 0, 0)`.trim()
    const base = { transform: session.baseTransform, opacity: session.baseOpacity }

    const play = async (frames: Keyframe[], duration: number, phase: 'exit' | 'enter') => {
      if (!current()) return false
      let animation: Animation
      try {
        animation = element.animate(frames, {
          duration,
          easing: phase === 'exit' ? 'cubic-bezier(0.4, 0, 1, 1)' : 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'forwards',
        })
        animation.id = `mango-page-${phase}`
      } catch { return false }
      state.animation = animation
      const complete = await animation.finished.then(() => true, () => false)
      if (!current() || state.animation !== animation) return false
      if (complete) {
        const last = frames[frames.length - 1]
        element.style.transform = String(last.transform)
        element.style.opacity = String(last.opacity)
      }
      cancelAnimation()
      return complete
    }

    void (async () => {
      try {
        if (next === currentPage.current) {
          await play([from, base], 180, 'enter')
          if (current()) commitPage()
          return
        }
        const exited = await play([from, { transform: offset(-direction * distance), opacity: 0 }], 160, 'exit')
        if (!current()) return
        if (!exited) { settleImmediately(); return }
        commitPage()
        if (!current()) return
        const incoming = { transform: offset(direction * distance), opacity: 0 }
        element.style.transform = incoming.transform
        element.style.opacity = '0'
        await play([incoming, base], 240, 'enter')
      } finally { finish() }
    })().catch(reason => { console.error('Unable to complete the page transition.', reason) })
  }, [target, stage])

  useLayoutEffect(() => {
    const state = runtime.current
    state.mounted = true
    return () => {
      state.mounted = false
      state.request = null
      state.animation?.cancel()
      state.animation = null
      restoreSession(state, false)
    }
  }, [])

  return { navigate, activePage: pendingPage ?? page }
}

function restoreSession<T>(state: Runtime<T>, restoreFocus = true) {
  const session = state.session
  if (!session) return
  state.session = null
  const { element, stage } = session
  session.motion.removeEventListener?.('change', session.motionChanged)
  element.removeEventListener('click', session.blockInput, true)
  element.removeEventListener('keydown', session.blockInput, true)
  for (const style of session.styles) {
    if (style.value) element.style.setProperty(style.name, style.value, style.priority)
    else element.style.removeProperty(style.name)
  }
  element.inert = session.inert
  if (session.busy === null) element.removeAttribute('aria-busy')
  else element.setAttribute('aria-busy', session.busy)
  if (session.stageState === null) stage.removeAttribute('data-transitioning')
  else stage.setAttribute('data-transitioning', session.stageState)
  if (restoreFocus && !element.inert && session.focusWasInside && document.activeElement === document.body && element.isConnected) {
    element.focus({ preventScroll: true })
  }
}
