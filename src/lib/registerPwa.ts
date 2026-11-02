export interface PwaRegistrationOptions {
  onRegistered?: (registration: ServiceWorkerRegistration) => void
  onOfflineReady?: () => void
  onNeedRefresh?: (registration: ServiceWorkerRegistration) => void
  onError?: (error: unknown) => void
  onControllerChange?: () => void
}

/** Register only hosted production builds; a downloaded standalone HTML stays independent. */
export function registerPwa(options: PwaRegistrationOptions = {}): () => void {
  let disposed = false
  const cleanups: (() => void)[] = []
  const cleanup = () => { disposed = true; cleanups.splice(0).forEach(remove => remove()) }
  if (!import.meta.env.PROD || !['https:', 'http:'].includes(location.protocol) || !window.isSecureContext || !('serviceWorker' in navigator) || !document.querySelector('link[rel="manifest"]')) return cleanup

  const controllerChanged = () => { if (!disposed) options.onControllerChange?.() }
  navigator.serviceWorker.addEventListener('controllerchange', controllerChanged)
  cleanups.push(() => navigator.serviceWorker.removeEventListener('controllerchange', controllerChanged))
  const base = new URL(import.meta.env.BASE_URL, document.baseURI)
  const workerUrl = new URL('service-worker.js', base)

  void navigator.serviceWorker.register(workerUrl.href, { scope: base.href, updateViaCache: 'none' }).then(registration => {
    if (disposed) return
    options.onRegistered?.(registration)
    if (registration.active) options.onOfflineReady?.()
    if (registration.waiting && navigator.serviceWorker.controller) options.onNeedRefresh?.(registration)

    const observeInstalling = () => {
      const worker = registration.installing
      if (!worker) return
      const stateChanged = () => {
        if (disposed) return
        if (worker.state === 'installed') {
          if (navigator.serviceWorker.controller) options.onNeedRefresh?.(registration)
          else options.onOfflineReady?.()
        }
        if (worker.state === 'redundant' && !registration.active) options.onError?.(new Error('オフライン用データの保存に失敗しました。接続を確認して、再度お試しください。'))
      }
      worker.addEventListener('statechange', stateChanged)
      cleanups.push(() => worker.removeEventListener('statechange', stateChanged))
      stateChanged()
    }
    registration.addEventListener('updatefound', observeInstalling)
    cleanups.push(() => registration.removeEventListener('updatefound', observeInstalling))
    observeInstalling()
    if (registration.active) void registration.update().catch(error => { if (!disposed) options.onError?.(error) })
  }).catch(error => { if (!disposed) options.onError?.(error) })
  return cleanup
}
