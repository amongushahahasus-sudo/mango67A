import type { Page } from '@playwright/test'

/** Keep prices stable while testing account ownership and shop transactions. */
export async function useFixedMarketPrices(page: Page) {
  await page.context().addInitScript(() => {
    const nativeInterval = window.setInterval.bind(window)
    // Stretch only the market's two-second interval. Save/auth timers and
    // native page animations keep running normally in these mocked flows.
    window.setInterval = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
      nativeInterval(handler, delay === 2000 ? 3_600_000 : delay, ...args)) as typeof window.setInterval
  })
}
