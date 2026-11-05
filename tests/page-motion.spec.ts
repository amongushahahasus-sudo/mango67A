import { expect, test, type Page } from '@playwright/test'

const practiceKey = 'mango-fx-simulator-v1'
type RecordedMotion = { page: string | null; animation: Animation; x: number[]; opacity: number[]; duration: number; finished: boolean; cancelled: boolean }
type MotionWindow = Window & { __pageMotions?: RecordedMotion[]; __holdPageMotion?: boolean; __pageCommits?: string[]; __pageObserver?: MutationObserver }

async function recordPageMotion(page: Page) {
  await page.addInitScript(() => {
    const target = window as MotionWindow
    target.__pageMotions = []
    target.__pageCommits = []
    target.__holdPageMotion = false
    const original = Element.prototype.animate
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
      const animation = original.apply(this, args)
      if (this.tagName === 'MAIN') {
        const frames = animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : []
        const record: RecordedMotion = {
          page: this.getAttribute('data-page'), animation,
          x: frames.map(frame => {
            try { return new DOMMatrixReadOnly(String((frame as ComputedKeyframe & { transform?: string }).transform || 'none')).m41 } catch { return Number.NaN }
          }).filter(Number.isFinite),
          opacity: frames.map(frame => Number((frame as ComputedKeyframe & { opacity?: string | number }).opacity)).filter(Number.isFinite),
          duration: Number(animation.effect?.getTiming().duration), finished: false, cancelled: false,
        }
        target.__pageMotions!.push(record)
        if (target.__holdPageMotion) animation.pause()
        void animation.finished.then(() => { record.finished = true }, () => { record.cancelled = true })
      }
      return animation
    }
  })
}
const motions = (page: Page) => page.evaluate(() => ((window as MotionWindow).__pageMotions ?? []).map(record => ({
  page: record.page, id: record.animation.id, x: record.x, opacity: record.opacity, duration: record.duration,
  finished: record.finished, cancelled: record.cancelled,
})))
async function observeCommits(page: Page) {
  await page.locator('main').evaluate(element => {
    const target = window as MotionWindow
    target.__pageObserver = new MutationObserver(records => {
      for (const record of records) target.__pageCommits!.push((record.target as HTMLElement).getAttribute('data-page') || '')
    })
    target.__pageObserver.observe(element, { attributes: true, attributeFilter: ['data-page'] })
  })
}
const storedPractice = (page: Page) => page.evaluate(key => localStorage.getItem(key), practiceKey)
const lastMarketTime = (page: Page) => page.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null')?.markets?.USDJPY?.at(-1)?.time ?? null, practiceKey)
const go = (page: Page, label: string) => page.getByRole('button', { name: label, exact: true }).click()
const hold = (page: Page, enabled: boolean) => page.evaluate(value => { (window as MotionWindow).__holdPageMotion = value }, enabled)
async function phase(page: Page, id: 'mango-page-exit' | 'mango-page-enter') {
  await expect.poll(() => page.locator('main').evaluate((element, wanted) => element.getAnimations().some(animation => animation.id === wanted), id)).toBe(true)
}
async function halfway(page: Page, id: 'mango-page-exit' | 'mango-page-enter') {
  await phase(page, id)
  return page.locator('main').evaluate((element, wanted) => {
    const animation = element.getAnimations().find(value => value.id === wanted)!
    animation.currentTime = Number(animation.effect!.getTiming().duration) / 2
    return new DOMMatrixReadOnly(getComputedStyle(element).transform).m41
  }, id)
}
async function finishPhase(page: Page, id: 'mango-page-exit' | 'mango-page-enter') {
  await phase(page, id)
  await page.locator('main').evaluate((element, wanted) => element.getAnimations().find(value => value.id === wanted)!.finish(), id)
}
async function settled(page: Page, view?: string) {
  if (view) await expect(page.locator('main')).toHaveAttribute('data-page', view)
  await expect.poll(() => page.locator('main').evaluate(element => (element as HTMLElement).inert)).toBe(false)
  await expect.poll(() => page.locator('main').evaluate(element => element.getAnimations().length)).toBe(0)
  await expect(page.locator('main')).toHaveCSS('transform', 'none')
  await expect(page.locator('main')).toHaveCSS('opacity', '1')
  await expect(page.locator('.page-stage')).not.toHaveAttribute('data-transitioning', 'true')
}
async function stubShop(page: Page) {
  await page.route('**/rest/v1/rpc/get_reward_shop', route => route.fulfill({
    contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' },
    body: JSON.stringify({ role: null, realizedProfit: 0, spentProfit: 0, availableProfit: 0, photos: [], orders: [], lotteriesReady: true, productImagesReady: true }),
  }))
}

test('the old page slides out before content changes, then the new page slides in', async ({ page }) => {
  await recordPageMotion(page)
  await page.goto('/')
  await go(page, '相場を一時停止')
  await page.getByRole('button', { name: '買い注文を出す', exact: true }).scrollIntoViewIfNeeded()
  await hold(page, true)
  await go(page, '学習ガイド')
  await phase(page, 'mango-page-exit')
  await expect(page.locator('main')).toHaveAttribute('data-page', 'trade')
  expect(await page.locator('main').evaluate(element => (element as HTMLElement).inert)).toBe(true)
  expect(await halfway(page, 'mango-page-exit')).toBeLessThan(-1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  const buy = await page.locator('.submit-order').boundingBox()
  expect(buy).not.toBeNull()
  expect(buy!.y + buy!.height / 2).toBeGreaterThan(0)
  expect(buy!.y + buy!.height / 2).toBeLessThan(await page.evaluate(() => innerHeight))
  await page.mouse.click(buy!.x + buy!.width / 2, buy!.y + buy!.height / 2)
  expect(JSON.parse((await storedPractice(page))!).account.positions).toHaveLength(0)
  await finishPhase(page, 'mango-page-exit')
  await expect(page.locator('main')).toHaveAttribute('data-page', 'learn')
  await phase(page, 'mango-page-enter')
  expect(await halfway(page, 'mango-page-enter')).toBeGreaterThan(1)
  expect(await page.locator('main').evaluate(element => (element as HTMLElement).inert)).toBe(true)
  await finishPhase(page, 'mango-page-enter')
  await settled(page, 'learn')
  await expect(page.getByRole('heading', { name: 'しくみがわかると、取引が変わる。', exact: true })).toBeVisible()

  await go(page, 'トレード')
  expect(await halfway(page, 'mango-page-exit')).toBeGreaterThan(1)
  await finishPhase(page, 'mango-page-exit')
  expect(await halfway(page, 'mango-page-enter')).toBeLessThan(-1)
  await finishPhase(page, 'mango-page-enter')
  await settled(page, 'trade')
  const captured = await motions(page)
  expect(captured).toHaveLength(4)
  expect(captured.map(value => value.page)).toEqual(['trade', 'learn', 'learn', 'trade'])
  expect(captured.every(value => value.duration > 0 && value.duration <= 1000)).toBe(true)
})

test('rapid navigation before and after commit keeps only the latest target and preserves trading state', async ({ page }) => {
  await recordPageMotion(page)
  await stubShop(page)
  await page.goto('/')
  await observeCommits(page)
  await go(page, '相場を一時停止')
  await go(page, '0.1 lot')
  await go(page, '買い注文を出す')
  await go(page, '指値')
  await page.getByRole('spinbutton', { name: '注文価格', exact: true }).fill('1')
  await go(page, '買い注文を出す')
  await expect(page.getByRole('button', { name: '取消', exact: true })).toBeVisible()
  await page.getByRole('spinbutton', { name: '取引数量（lot）', exact: true }).fill('0.5')
  await expect.poll(async () => JSON.parse((await storedPractice(page))!).account.orders.length).toBe(1)
  const before = await storedPractice(page)
  await go(page, 'チャートを拡大')
  await expect(page.locator('.chart-is-expanded')).toBeVisible()
  await hold(page, true)
  for (const label of ['学習ガイド', 'ランキング', 'ショップ']) await go(page, label)
  await expect(page.locator('main')).toHaveAttribute('data-page', 'trade')
  await finishPhase(page, 'mango-page-exit')
  await expect(page.locator('main')).toHaveAttribute('data-page', 'shop')
  await halfway(page, 'mango-page-enter')
  await go(page, '学習ガイド')
  await expect(page.locator('main')).toHaveAttribute('data-page', 'shop')
  await finishPhase(page, 'mango-page-exit')
  await finishPhase(page, 'mango-page-enter')
  await settled(page, 'learn')
  expect(await page.evaluate(() => (window as MotionWindow).__pageCommits)).toEqual(['shop', 'learn'])
  await hold(page, false)
  await go(page, 'トレード')
  await settled(page, 'trade')
  await expect(page.locator('.chart-is-expanded')).toBeVisible()
  await go(page, 'チャートの拡大を終了')
  await expect(page.getByRole('spinbutton', { name: '取引数量（lot）', exact: true })).toHaveValue('0.5')
  await expect(page.getByRole('spinbutton', { name: '注文価格', exact: true })).toHaveValue('1')
  await expect(page.getByRole('button', { name: '取消', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: /建玉/ }).click()
  await expect(page.getByRole('button', { name: 'USD / JPYの買い建玉を決済', exact: true })).toBeVisible()
  expect(await storedPractice(page)).toBe(before)
  expect((await motions(page)).some(value => value.cancelled)).toBe(true)
  await page.getByRole('button', { name: 'チャートを拡大', exact: true }).click()
  const expanded = page.locator('.chart-is-expanded')
  await expect(expanded).toBeVisible()
  const geometry = await expanded.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    const main = element.closest('main')!
    const style = getComputedStyle(main)
    return { width: bounds.width, availableWidth: main.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), height: bounds.height }
  })
  expect(Math.abs(geometry.width - geometry.availableWidth)).toBeLessThan(2)
  expect(geometry.height).toBeGreaterThan(0)
  await expect(page.locator('.chart-is-expanded .order-column')).toHaveCSS('display', 'none')
  await expect(page.getByRole('region', { name: 'USD / JPYのマーケットチャート', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'チャートの拡大を終了', exact: true }).click()
})

test('returning to the current page while it is exiting cancels the pending replacement', async ({ page }) => {
  await recordPageMotion(page)
  await page.goto('/')
  await observeCommits(page)
  await go(page, '相場を一時停止')
  await hold(page, true)
  await go(page, '学習ガイド')
  expect(await halfway(page, 'mango-page-exit')).toBeLessThan(-1)
  await go(page, 'トレード')
  await finishPhase(page, 'mango-page-enter')
  await settled(page, 'trade')
  expect(await page.evaluate(() => (window as MotionWindow).__pageCommits)).toEqual([])
  await expect(page.getByRole('heading', { name: 'しくみがわかると、取引が変わる。', exact: true })).toHaveCount(0)
})

test('theme changes and market updates do not replay page movement', async ({ page }) => {
  await recordPageMotion(page)
  await page.goto('/')
  await go(page, '相場を一時停止')
  await go(page, '学習ガイド')
  await settled(page, 'learn')
  expect(await motions(page)).toHaveLength(2)
  await page.getByRole('button', { name: /^表示モード（/ }).click()
  await page.getByRole('dialog', { name: '表示モード', exact: true }).getByRole('button', { name: 'ダーク', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await motions(page)).toHaveLength(2)
  await go(page, 'トレード')
  await settled(page, 'trade')
  await go(page, '相場を再生')
  const count = (await motions(page)).length
  const before = await lastMarketTime(page)
  await expect.poll(() => lastMarketTime(page), { timeout: 7000 }).not.toBe(before)
  expect(await motions(page)).toHaveLength(count)
  await go(page, '相場を一時停止')
})

test('reduced motion is immediate and enabling it during an exit settles the latest request', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await recordPageMotion(page)
  await page.goto('/')
  await go(page, '相場を一時停止')
  await go(page, '学習ガイド')
  await settled(page, 'learn')
  expect(await motions(page)).toEqual([])
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await hold(page, true)
  await go(page, 'トレード')
  await phase(page, 'mango-page-exit')
  await expect(page.locator('main')).toHaveAttribute('data-page', 'learn')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await settled(page, 'trade')
  expect(await motions(page)).toHaveLength(1)
})

test('history navigation reaches its selected section after commit and cancelled history cannot scroll another page', async ({ page }) => {
  await recordPageMotion(page)
  await page.goto('/')
  await go(page, '相場を一時停止')
  await go(page, '買い注文を出す')
  await go(page, 'USD / JPYの買い建玉を決済')
  await go(page, '学習ガイド')
  await settled(page, 'learn')
  await hold(page, true)
  await go(page, '取引履歴へ移動')
  await phase(page, 'mango-page-exit')
  await go(page, 'ランキング')
  await finishPhase(page, 'mango-page-exit')
  await finishPhase(page, 'mango-page-enter')
  await settled(page, 'ranking')
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  await hold(page, false)
  await go(page, '取引履歴へ移動')
  await settled(page, 'trade')
  await expect(page.getByRole('tab', { name: /取引履歴/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('region', { name: '取引管理', exact: true })).toBeInViewport()
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  await expect(page.getByRole('region', { name: '取引管理', exact: true }).getByRole('cell', { name: '−¥30', exact: true })).toBeVisible()
})

test('navigation and order entry still work without the animation API', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => Object.defineProperty(Element.prototype, 'animate', { configurable: true, writable: true, value: undefined }))
  await page.goto('/')
  await go(page, '相場を一時停止')
  await go(page, '学習ガイド')
  await settled(page, 'learn')
  await go(page, 'トレード')
  await settled(page, 'trade')
  await go(page, '買い注文を出す')
  await expect(page.getByRole('button', { name: 'USD / JPYの買い建玉を決済', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})
