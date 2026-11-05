import { useLayoutEffect, useRef, type RefObject } from 'react'

/** Animate a new page without delaying navigation or remounting its state. */
export function usePageTransition(target: RefObject<HTMLElement | null>, page: string) {
  const previousPage = useRef(page)

  useLayoutEffect(() => {
    const changed = previousPage.current !== page
    previousPage.current = page
    const element = target.current
    if (!changed || !element || typeof element.animate !== 'function') return

    let motion: MediaQueryList
    try { motion = window.matchMedia('(prefers-reduced-motion: reduce)') } catch { return }
    if (motion.matches) return

    let animation: Animation
    try {
      // Opacity preserves the viewport positioning of expanded charts and dialogs.
      animation = element.animate([{ opacity: 0.45 }, { opacity: 1 }], {
        duration: 220,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'none',
      })
      animation.id = 'mango-page-enter'
    } catch { return }

    const removeListeners = () => {
      element.removeEventListener('pointerdown', cancel, true)
      element.removeEventListener('keydown', cancel, true)
      motion.removeEventListener?.('change', onMotionChange)
    }
    const cancel = () => { removeListeners(); animation.cancel() }
    const onMotionChange = () => { if (motion.matches) cancel() }

    // An interaction should immediately reveal the controls at full opacity.
    element.addEventListener('pointerdown', cancel, true)
    element.addEventListener('keydown', cancel, true)
    motion.addEventListener?.('change', onMotionChange)
    void animation.finished.then(removeListeners, removeListeners)
    return cancel
  }, [target, page])
}
