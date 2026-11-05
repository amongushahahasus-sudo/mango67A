import { expect, test, type Page } from '@playwright/test'

const marker = (page: Page) => page.locator('.nav-main .nav-active-indicator')
const navButton = (page: Page, key: string) => page.locator(`.nav-main [data-page-button="${key}"]`)

async function ready(page: Page) {
  await expect(page.locator('.nav-main')).toHaveAttribute('data-page-navigation', 'ready')
  await expect(marker(page)).toHaveCount(1)
  await expect(marker(page)).toHaveAttribute('data-positioned', 'true')
}

async function aligned(page: Page, key: string) {
  await expect.poll(() => page.evaluate(active => {
    const pill = document.querySelector('.nav-main .nav-active-indicator')?.getBoundingClientRect()
    const button = document.querySelector(`.nav-main [data-page-button="${active}"]`)?.getBoundingClientRect()
    if (!pill || !button) return 10000
    return Math.max(Math.abs(pill.left - button.left), Math.abs(pill.top - button.top),
      Math.abs(pill.width - button.width), Math.abs(pill.height - button.height))
  }, key)).toBeLessThan(1.5)
}

async function openTheme(page: Page) {
  await page.getByRole('button', { name: /^表示モード（/ }).click()
  return page.getByRole('dialog', { name: '表示モード', exact: true })
}

test('one highlight moves between navigation buttons while the buttons keep keyboard focus', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '相場を一時停止', exact: true }).click()
  await ready(page)
  await aligned(page, 'trade')
  const originalTop = await marker(page).evaluate(element => element.getBoundingClientRect().top)
  await expect(marker(page)).toHaveAttribute('aria-hidden', 'true')
  await expect(marker(page)).toHaveCSS('pointer-events', 'none')
  await expect(marker(page)).toHaveAttribute('data-animated', 'true')
  await expect(marker(page)).toHaveCSS('transition-property', /transform/)

  const learning = navButton(page, 'learn')
  const learningRect = await learning.boundingBox()
  await learning.click()
  await expect(learning).toHaveClass(/active/)
  await expect(learning).toBeFocused()
  await aligned(page, 'learn')
  expect(await marker(page).evaluate(element => element.getBoundingClientRect().top)).toBeGreaterThan(originalTop)
  const settledRect = await learning.boundingBox()
  expect(settledRect?.x).toBe(learningRect?.x)
  expect(settledRect?.y).toBe(learningRect?.y)
  await expect(page.locator('main')).toHaveAttribute('data-page', 'learn')

  await navButton(page, 'ranking').click()
  await aligned(page, 'ranking')
  await navButton(page, 'trade').click()
  await aligned(page, 'trade')
  await expect(marker(page)).toHaveCount(1)
})

test('rapid navigation leaves one highlight at the final requested page', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '相場を一時停止', exact: true }).click()
  await ready(page)
  for (const key of ['learn', 'ranking', 'trade', 'learn', 'ranking']) await navButton(page, key).click()
  await expect(page.locator('main')).toHaveAttribute('data-page', 'ranking')
  await expect(page.locator('.nav-main .nav-button.active')).toHaveCount(1)
  await expect(navButton(page, 'ranking')).toHaveClass(/active/)
  await aligned(page, 'ranking')
  await expect(marker(page)).toHaveCount(1)
  await expect(page.getByRole('heading', { name: '＋ランキング', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '−ランキング', exact: true })).toBeVisible()
})

test('the moving highlight keeps its selected styling in dark, glass and normal designs', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '相場を一時停止', exact: true }).click()
  await ready(page)
  await navButton(page, 'learn').click()
  await aligned(page, 'learn')

  let theme = await openTheme(page)
  await theme.getByRole('button', { name: 'ダーク', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await aligned(page, 'learn')
  theme = await openTheme(page)
  await theme.getByRole('group', { name: 'デザインを選択', exact: true }).getByRole('button', { name: 'ガラス調', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-interface-style', 'glass')
  await page.keyboard.press('Escape')
  await expect(marker(page)).toHaveCSS('background-image', /gradient/)
  await expect(navButton(page, 'learn')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await navButton(page, 'ranking').click()
  await aligned(page, 'ranking')

  theme = await openTheme(page)
  await theme.getByRole('button', { name: 'ライト', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.locator('html')).toHaveAttribute('data-interface-style', 'glass')
  await aligned(page, 'ranking')
  theme = await openTheme(page)
  await theme.getByRole('group', { name: 'デザインを選択', exact: true }).getByRole('button', { name: '通常', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('html')).toHaveAttribute('data-interface-style', 'standard')
  await aligned(page, 'ranking')
  await expect(marker(page)).toHaveCount(1)
  expect(await marker(page).evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
})

test('the highlight stays aligned after mobile sidebar scrolling and a desktop resize', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '相場を一時停止', exact: true }).click()
  await ready(page)
  await page.setViewportSize({ width: 320, height: 568 })
  const menu = page.getByRole('button', { name: 'メニューを開く', exact: true })
  await menu.click()
  await navButton(page, 'learn').click()
  await expect(page.locator('main')).toHaveAttribute('data-page', 'learn')
  await expect(menu).toBeFocused()
  await menu.click()
  await page.locator('.sidebar').evaluate(element => { element.scrollTop = element.scrollHeight })
  await aligned(page, 'learn')
  await navButton(page, 'ranking').click()
  await expect(page.locator('main')).toHaveAttribute('data-page', 'ranking')
  await menu.click()
  await aligned(page, 'ranking')
  await expect(marker(page)).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  await page.setViewportSize({ width: 1440, height: 900 })
  await aligned(page, 'ranking')
  await expect(marker(page)).toHaveCount(1)
  await expect(navButton(page, 'ranking')).toHaveClass(/active/)
})

test('reduced motion updates the highlight immediately without moving keyboard focus away', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByRole('button', { name: '相場を一時停止', exact: true }).click()
  await ready(page)
  const learning = navButton(page, 'learn')
  await learning.focus()
  await page.keyboard.press('Enter')
  await expect(learning).toBeFocused()
  await expect(page.locator('main')).toHaveAttribute('data-page', 'learn')
  await aligned(page, 'learn')
  expect(await marker(page).evaluate(element => Math.max(...getComputedStyle(element).transitionDuration.split(',').map(value => parseFloat(value))))).toBeLessThanOrEqual(0.001)
})
