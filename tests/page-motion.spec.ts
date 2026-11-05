import { expect, test, type Page } from '@playwright/test'

const practiceKey = 'mango-fx-simulator-v1'
type MotionRecord = { page: string | null; opacity: number[]; duration: number; finished: boolean; cancelled: boolean }
type MotionWindow = Window & { __pageMotions?: MotionRecord[] }

async function recordPageMotion(page: Page) {
  await page.addInitScript(() => {
    const target = window as MotionWindow
    target.__pageMotions = []
    const original = Element.prototype.animate
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
      const animation = original.apply(this, args)
      if (this.tagName === 'MAIN') {
        const frames = animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : []
        const record: MotionRecord = {
          page: this.getAttribute('data-page'),
          opacity: frames.map(frame => Number((frame as ComputedKeyframe & { opacity?: string | number }).opacity)).filter(Number.isFinite),
          duration: Number(animation.effect?.getTiming().duration),
          finished: false,
          cancelled: false,
        }
        target.__pageMotions!.push(record)
        void animation.finished.then(() => { record.finished = true }, () => { record.cancelled = true })
      }
      return animation
    }
  })
}

const motions = (page: Page) => page.evaluate(() => (window as MotionWindow).__pageMotions ?? [])
const storedPractice = (page: Page) => page.evaluate(key => localStorage.getItem(key), practiceKey)
const lastMarketTime = (page: Page) => page.evaluate(key => {
  const state = JSON.parse(localStorage.getItem(key) || 'null')
  return state?.markets?.USDJPY?.at(-1)?.time ?? null
}, practiceKey)
const go = (page: Page, label: string) => page.getByRole('button', { name: label, exact: true }).click()

test('page entry fades once while theme changes and market ticks keep the current page still', async ({ page }) => {
  await recordPageMotion(page)
  await page.goto('/')
  await go(page, '相場を一時停止')
  const initial = (await motions(page)).length
  await go(page, '学習ガイド')
  await expect(page.getByRole('heading', { name: 'しくみがわかると、取引が変わる。', exact: true })).toBeVisible()
  await expect.poll(async () => (await motions(page)).length).toBe(initial + 1)
  const entry = (await motions(page)).at(-1)!
  expect(entry.opacity.some(value => value < 1)).toBe(true)
  expect(entry.opacity.at(-1)).toBe(1)
  expect(entry.duration).toBeGreaterThan(0)
  expect(entry.duration).toBeLessThanOrEqual(1000)
  await expect.poll(() => page.locator('main').evaluate(element => element.getAnimations().length)).toBe(0)
  await page.getByRole('button', { name: /^表示モード（/ }).click()
  await page.getByRole('dialog', { name: '表示モード', exact: true }).getByRole('button', { name: 'ダーク', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect((await motions(page)).length).toBe(initial + 1)

  await go(page, 'トレード')
  await go(page, '相場を再生')
  const count = (await motions(page)).length
  const before = await lastMarketTime(page)
  await expect.poll(() => lastMarketTime(page), { timeout: 7000 }).not.toBe(before)
  expect((await motions(page)).length).toBe(count)
  await go(page, '相場を一時停止')
})

test('rapid navigation preserves positions, pending orders and an unfinished order draft', async ({ page }) => {
  await recordPageMotion(page)
  await page.route('**/rest/v1/rpc/get_reward_shop', route => route.fulfill({
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' },
    body: JSON.stringify({ role: null, realizedProfit: 0, spentProfit: 0, availableProfit: 0, photos: [], orders: [], lotteriesReady: true, productImagesReady: true }),
  }))
  await page.goto('/')
  await go(page, '相場を一時停止')
  await go(page, '0.1 lot')
  await go(page, '買い注文を出す')
  await expect(page.getByRole('button', { name: 'USD / JPYの買い建玉を決済', exact: true })).toBeVisible()
  await go(page, '指値')
  await page.getByRole('spinbutton', { name: '注文価格', exact: true }).fill('1')
  await go(page, '買い注文を出す')
  await expect(page.getByRole('button', { name: '取消', exact: true })).toBeVisible()
  await page.getByRole('spinbutton', { name: '取引数量（lot）', exact: true }).fill('0.5')
  await expect.poll(async () => JSON.parse((await storedPractice(page))!).account.orders.length).toBe(1)
  const before = await storedPractice(page)
  for (const label of ['学習ガイド', 'ランキング', 'ショップ', 'トレード']) await go(page, label)
  await expect(page.locator('main')).toHaveAttribute('data-page', 'trade')
  await expect(page.getByRole('spinbutton', { name: '取引数量（lot）', exact: true })).toHaveValue('0.5')
  await expect(page.getByRole('spinbutton', { name: '注文価格', exact: true })).toHaveValue('1')
  await expect(page.getByRole('button', { name: '取消', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: /建玉/ }).click()
  await expect(page.getByRole('button', { name: 'USD / JPYの買い建玉を決済', exact: true })).toBeVisible()
  expect(await storedPractice(page)).toBe(before)
  await expect(page.getByRole('heading', { name: '＋ランキング', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'しくみがわかると、取引が変わる。', exact: true })).toHaveCount(0)
  await expect.poll(() => page.locator('main').evaluate(element => element.getAnimations().length)).toBe(0)
  expect(await page.locator('main').evaluate(element => getComputedStyle(element).transform)).toBe('none')
})

test('reduced-motion preferences keep page navigation immediate and fully opaque', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await recordPageMotion(page)
  await page.goto('/')
  await go(page, '相場を一時停止')
  for (const [label, view] of [['学習ガイド', 'learn'], ['ランキング', 'ranking'], ['トレード', 'trade']]) {
    await go(page, label)
    await expect(page.locator('main')).toHaveAttribute('data-page', view)
    await expect(page.locator('main')).toHaveCSS('opacity', '1')
  }
  expect(await motions(page)).toEqual([])
})

test('history navigation still reaches the selected history after a page transition', async ({ page }) => {
  await page.goto('/')
  await go(page, '相場を一時停止')
  await go(page, '買い注文を出す')
  await go(page, 'USD / JPYの買い建玉を決済')
  await go(page, '学習ガイド')
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  await go(page, '取引履歴へ移動')
  await expect(page.locator('main')).toHaveAttribute('data-page', 'trade')
  await expect(page.getByRole('tab', { name: /取引履歴/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('region', { name: '取引管理', exact: true })).toBeInViewport()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  await expect(page.getByRole('region', { name: '取引管理', exact: true }).getByRole('cell', { name: '−¥30', exact: true })).toBeVisible()
})

test('navigation and order entry still work when the animation API is unavailable', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => Object.defineProperty(Element.prototype, 'animate', { configurable: true, writable: true, value: undefined }))
  await page.goto('/')
  await go(page, '相場を一時停止')
  await go(page, '学習ガイド')
  await expect(page.getByRole('heading', { name: 'しくみがわかると、取引が変わる。', exact: true })).toBeVisible()
  await go(page, 'トレード')
  await go(page, '買い注文を出す')
  await expect(page.getByRole('button', { name: 'USD / JPYの買い建玉を決済', exact: true })).toBeVisible()
  await expect(page.locator('main')).toHaveCSS('opacity', '1')
  expect(errors).toEqual([])
})
