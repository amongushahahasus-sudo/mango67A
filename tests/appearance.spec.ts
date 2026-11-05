import { expect, test, type Page } from '@playwright/test'

test.use({ timezoneId: 'UTC' })

const styleKey = 'mango-fx-interface-style-v1'
const themeKey = 'mango-fx-theme-v1'
const practiceKey = 'mango-fx-simulator-v1'
const trigger = (page: Page) => page.getByRole('button', { name: /^表示モード（/ })
const picker = (page: Page) => page.getByRole('dialog', { name: '表示モード', exact: true })

async function openPicker(page: Page) {
  if (await trigger(page).getAttribute('aria-expanded') !== 'true') await trigger(page).click()
  await expect(picker(page)).toBeVisible()
  return picker(page)
}

async function chooseStyle(page: Page, name: '通常' | 'ガラス調') {
  const menu = await openPicker(page)
  await menu.getByRole('group', { name: 'デザインを選択', exact: true }).getByRole('button', { name, exact: true }).click()
  await expect(menu).toBeVisible()
  return menu
}

async function chooseMode(page: Page, name: 'ライト' | 'ダーク' | '時間帯で自動') {
  const menu = await openPicker(page)
  await menu.getByRole('group', { name: '表示モードを選択', exact: true }).getByRole('button', { name, exact: true }).click()
}

async function pause(page: Page) {
  await page.getByRole('button', { name: '相場を一時停止', exact: true }).click()
}

test('glass is optional, persists independently, and does not change a paused trade', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await pause(page)
  await expect(page.locator('html')).toHaveAttribute('data-interface-style', 'standard')
  expect(await page.evaluate(key => localStorage.getItem(key), styleKey)).toBeNull()
  const normalMenu = await openPicker(page)
  await expect(normalMenu.getByRole('button', { name: '通常', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const normalRadius = await normalMenu.evaluate(element => getComputedStyle(element).borderRadius)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '買い注文を出す', exact: true }).click()
  await expect(page.getByRole('button', { name: 'USD / JPYの買い建玉を決済', exact: true })).toBeVisible()
  const savedTrade = await page.evaluate(key => localStorage.getItem(key), practiceKey)
  const quoteColors = await page.locator('.quote-button').evaluateAll(elements => elements.map(element => getComputedStyle(element).color))
  const glass = await chooseStyle(page, 'ガラス調')
  await expect(page.locator('html')).toHaveAttribute('data-interface-style', 'glass')
  await expect(glass.getByRole('button', { name: 'ガラス調', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(key => localStorage.getItem(key), styleKey)).toBe('glass')
  expect(await page.evaluate(key => localStorage.getItem(key), themeKey)).toBeNull()
  expect(await page.evaluate(key => localStorage.getItem(key), practiceKey)).toBe(savedTrade)
  expect(await glass.evaluate(element => getComputedStyle(element).borderRadius)).not.toBe(normalRadius)
  if (await page.evaluate(() => CSS.supports('backdrop-filter', 'blur(1px)'))) {
    expect(await glass.evaluate(element => getComputedStyle(element).backdropFilter)).not.toBe('none')
  }
  expect(await page.locator('.quote-button').evaluateAll(elements => elements.map(element => getComputedStyle(element).color))).toEqual(quoteColors)
  await page.screenshot({ path: '.local/glass-menu-light.png', fullPage: false, animations: 'disabled' })
  await chooseMode(page, 'ダーク')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('html')).toHaveAttribute('data-interface-style', 'glass')
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), themeKey)).toEqual({ mode: 'dark', lightStart: '07:00', darkStart: '19:00' })
  await openPicker(page)
  await page.screenshot({ path: '.local/glass-menu-dark.png', fullPage: false, animations: 'disabled' })
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-interface-style', 'glass')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByRole('button', { name: 'USD / JPYの買い建玉を決済', exact: true })).toBeVisible()
  expect(await page.evaluate(key => localStorage.getItem(key), practiceKey)).toBe(savedTrade)
  const menu = await openPicker(page)
  await menu.getByRole('button', { name: '切り替え時刻を設定', exact: true }).click()
  const settings = page.getByRole('region', { name: '配色設定', exact: true })
  await settings.getByRole('group', { name: 'デザインを選択', exact: true }).getByRole('button', { name: '通常', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-interface-style', 'standard')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await page.evaluate(key => localStorage.getItem(key), practiceKey)).toBe(savedTrade)
  expect(errors).toEqual([])
})

test('saved glass works with automatic time changes and keeps the existing schedule format', async ({ page }) => {
  const instant = new Date('2026-11-05T06:59:50Z')
  await page.clock.install({ time: new Date(instant.getTime() - 60_000) })
  await page.clock.pauseAt(instant)
  await page.addInitScript(({ themeKey, styleKey }) => {
    localStorage.setItem(themeKey, JSON.stringify({ mode: 'auto', lightStart: '07:00', darkStart: '19:00' }))
    localStorage.setItem(styleKey, 'glass')
  }, { themeKey, styleKey })
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('html')).toHaveAttribute('data-interface-style', 'glass')
  await pause(page)
  await page.clock.fastForward(10_000)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.locator('html')).toHaveAttribute('data-interface-style', 'glass')
  const menu = await chooseStyle(page, '通常')
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), themeKey)).toEqual({ mode: 'auto', lightStart: '07:00', darkStart: '19:00' })
  await menu.getByRole('button', { name: 'ガラス調', exact: true }).click()
  await page.clock.setSystemTime(new Date('2026-11-05T19:00:01Z'))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('html')).toHaveAttribute('data-interface-style', 'glass')
})

test('other tabs receive style changes and resetting only the style keeps the palette', async ({ page, context }) => {
  await page.goto('/')
  await chooseMode(page, 'ダーク')
  const other = await context.newPage()
  await other.goto('/')
  await chooseStyle(page, 'ガラス調')
  await expect(other.locator('html')).toHaveAttribute('data-interface-style', 'glass')
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark')
  await other.evaluate(key => localStorage.removeItem(key), styleKey)
  await expect(page.locator('html')).toHaveAttribute('data-interface-style', 'standard')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await chooseStyle(page, 'ガラス調')
  await expect(other.locator('html')).toHaveAttribute('data-interface-style', 'glass')
  await other.evaluate(() => localStorage.clear())
  await expect(page.locator('html')).toHaveAttribute('data-interface-style', 'standard')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await other.close()
})

test('blocked style storage applies the choice temporarily and leaves palette saving usable', async ({ page }) => {
  await page.addInitScript(key => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (storageKey: string, value: string) {
      if (storageKey === key) throw new DOMException('Storage unavailable', 'QuotaExceededError')
      original.call(this, storageKey, value)
    }
  }, styleKey)
  await page.goto('/')
  await pause(page)
  const menu = await chooseStyle(page, 'ガラス調')
  await expect(page.locator('html')).toHaveAttribute('data-interface-style', 'glass')
  await expect(menu.getByRole('alert')).toContainText('デザイン設定を保存できません')
  expect(await page.evaluate(key => localStorage.getItem(key), styleKey)).toBeNull()
  await chooseMode(page, 'ダーク')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-interface-style', 'standard')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('the glass picker and settings remain usable at a narrow short viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await page.goto('/')
  await pause(page)
  const menu = await chooseStyle(page, 'ガラス調')
  await expect(menu.getByRole('button', { name: '通常', exact: true })).toBeInViewport()
  await expect(menu.getByRole('button', { name: 'ガラス調', exact: true })).toBeInViewport()
  await expect(menu.getByRole('button', { name: '切り替え時刻を設定', exact: true })).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  expect(await menu.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
  await page.screenshot({ path: '.local/glass-menu-mobile.png', fullPage: false, animations: 'disabled' })
  await menu.getByRole('button', { name: '切り替え時刻を設定', exact: true }).click()
  const settings = page.getByRole('region', { name: '配色設定', exact: true })
  const styles = settings.getByRole('group', { name: 'デザインを選択', exact: true })
  await styles.getByRole('button', { name: '通常', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-interface-style', 'standard')
  await styles.getByRole('button', { name: 'ガラス調', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-interface-style', 'glass')
  expect(await page.getByRole('dialog').last().evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
  await page.getByRole('button', { name: '設定を閉じる', exact: true }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'メニューを開く', exact: true }).click()
  await page.getByRole('button', { name: 'チュートリアル', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'MANGO FXへようこそ。', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'チュートリアルを閉じる', exact: true }).click()
  await expect(page.getByRole('button', { name: 'メニューを開く', exact: true })).toBeFocused()
})

test('glass menus preserve trading colors and account-dialog interaction in both palettes', async ({ page }) => {
  await page.goto('/')
  await pause(page)
  await chooseStyle(page, 'ガラス調')
  await page.keyboard.press('Escape')
  for (const mode of ['ライト', 'ダーク'] as const) {
    await chooseMode(page, mode)
    const colors = await page.locator('.quote-button').evaluateAll(elements => elements.map(element => getComputedStyle(element).color))
    expect(colors[0]).not.toBe(colors[1])
    await page.getByRole('button', { name: 'ログイン', exact: true }).click()
    const account = page.getByRole('dialog')
    await expect(account.getByRole('textbox', { name: 'メールアドレス', exact: true })).toBeVisible()
    await account.getByRole('button', { name: '新規登録', exact: true }).click()
    await expect(account.locator('input[autocomplete="nickname"]')).toBeVisible()
    await account.getByRole('button', { name: 'アカウント画面を閉じる', exact: true }).click()
    await page.getByRole('button', { name: 'チャートを拡大', exact: true }).click()
    await expect(page.locator('.chart-is-expanded')).toBeVisible()
    await page.getByRole('button', { name: 'チャートの拡大を終了', exact: true }).click()
    await expect(page.getByRole('button', { name: '買い注文を出す', exact: true })).toBeVisible()
  }
  await page.getByRole('button', { name: '買い注文を出す', exact: true }).click()
  await page.getByRole('button', { name: 'USD / JPYの買い建玉を決済', exact: true }).click()
  await page.getByRole('tab', { name: /取引履歴/ }).click()
  await expect(page.getByRole('region', { name: '取引管理', exact: true }).getByRole('table').getByRole('row')).toHaveCount(2)
})

test('reduced-transparency preferences retain opaque readable menus', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] })
  const emulated = await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches)
  test.skip(!emulated, 'This Chromium does not expose the reduced-transparency media feature.')
  await page.goto('/')
  const menu = await chooseStyle(page, 'ガラス調')
  expect(await menu.evaluate(element => getComputedStyle(element).backdropFilter)).toBe('none')
  expect(await menu.evaluate(element => getComputedStyle(element).backgroundColor)).not.toContain('rgba')
  await expect(menu.getByRole('button', { name: 'ダーク', exact: true })).toBeVisible()
  await chooseMode(page, 'ダーク')
  const dark = await openPicker(page)
  expect(await dark.evaluate(element => getComputedStyle(element).backdropFilter)).toBe('none')
  expect(await dark.evaluate(element => getComputedStyle(element).backgroundColor)).not.toContain('rgba')
  await cdp.detach()
})
