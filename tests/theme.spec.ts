import { test, expect, type Page } from '@playwright/test'

test.use({ timezoneId: 'UTC' })

const themeKey = 'mango-fx-theme-v1'
const practiceKey = 'mango-fx-simulator-v1'
const themeTrigger = (page: Page) => page.getByRole('button', { name: /^表示モード（/ })

async function chooseMode(page: Page, label: 'ライト' | 'ダーク' | '時間帯で自動') {
  await themeTrigger(page).click()
  await page.getByRole('dialog', { name: '表示モード', exact: true }).getByRole('button', { name: label, exact: true }).click()
}

async function expectTheme(page: Page, mode: 'light' | 'dark') {
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
  await expect(page.locator('html')).toHaveCSS('background-color', mode === 'light' ? 'rgb(247, 249, 242)' : 'rgb(11, 16, 25)')
  await expect(page.locator('.panel').first()).toHaveCSS('background-color', mode === 'light' ? 'rgb(255, 254, 251)' : 'rgb(16, 23, 34)')
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', mode === 'light' ? '#f7f9f2' : '#0b1019')
}

async function openSettings(page: Page) {
  await themeTrigger(page).click()
  await page.getByRole('button', { name: '切り替え時刻を設定', exact: true }).click()
  return page.getByRole('region', { name: '配色設定', exact: true })
}

async function pauseClockAt(page: Page, time: string) {
  const instant = new Date(time)
  await page.clock.install({ time: new Date(instant.getTime() - 60_000) })
  await page.clock.pauseAt(instant)
}

test('manual themes persist while an existing trade remains intact', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: '相場を一時停止', exact: true }).click()
  await expectTheme(page, 'light')
  await page.getByRole('button', { name: '買い注文を出す', exact: true }).click()
  await expect(page.getByRole('button', { name: 'USD / JPYの買い建玉を決済', exact: true })).toBeVisible()
  const before = await page.evaluate(key => localStorage.getItem(key), practiceKey)
  await chooseMode(page, 'ダーク')
  await expectTheme(page, 'dark')
  expect(await page.evaluate(key => localStorage.getItem(key), practiceKey)).toBe(before)
  await page.reload()
  await expectTheme(page, 'dark')
  await expect(page.getByRole('button', { name: 'USD / JPYの買い建玉を決済', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  await expect(page.locator('.account-dialog')).toHaveCSS('background-color', 'rgb(17, 26, 38)')
  await page.keyboard.press('Escape')
  await chooseMode(page, 'ライト')
  await expectTheme(page, 'light')
  await page.reload()
  await expectTheme(page, 'light')
  await expect(page.getByRole('button', { name: 'USD / JPYの買い建玉を決済', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('automatic mode changes at both daily boundaries without a reload', async ({ page }) => {
  await pauseClockAt(page, '2026-11-02T06:59:50Z')
  await page.goto('/')
  await page.getByRole('button', { name: '相場を一時停止', exact: true }).click()
  await chooseMode(page, '時間帯で自動')
  await expectTheme(page, 'dark')
  await page.clock.fastForward(10_000)
  await expectTheme(page, 'light')
  await page.clock.setSystemTime(new Date('2026-11-02T18:59:50Z'))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expectTheme(page, 'light')
  await page.clock.fastForward(10_000)
  await expectTheme(page, 'dark')
  await expect(themeTrigger(page)).toHaveAccessibleName('表示モード（自動・現在ダーク）')
})

test('custom overnight hours are saved, invalid equal hours rejected, manual choice overrides them', async ({ page }) => {
  await pauseClockAt(page, '2026-11-02T20:00:00Z')
  await page.goto('/')
  await page.getByRole('button', { name: '相場を一時停止', exact: true }).click()
  const settings = await openSettings(page)
  await settings.getByRole('button', { name: '時間帯で自動', exact: true }).click()
  await expectTheme(page, 'dark')
  const lightTime = settings.getByLabel('ライトに切り替える時刻', { exact: true })
  const darkTime = settings.getByLabel('ダークに切り替える時刻', { exact: true })
  await darkTime.fill('08:00')
  await lightTime.fill('20:00')
  await expectTheme(page, 'light')
  await darkTime.fill('20:00')
  await expect(settings.getByRole('alert')).toContainText('異なる2つの時刻')
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), themeKey)).toEqual({ mode: 'auto', lightStart: '20:00', darkStart: '08:00' })
  await darkTime.fill('08:00')
  await expect(settings.getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: '設定を閉じる', exact: true }).click()
  await page.reload()
  await expectTheme(page, 'light')
  await page.clock.setSystemTime(new Date('2026-11-03T07:59:50Z'))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.clock.fastForward(10_000)
  await expectTheme(page, 'dark')
  await chooseMode(page, 'ライト')
  await expectTheme(page, 'light')
  await page.clock.setSystemTime(new Date('2026-11-03T12:00:00Z'))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expectTheme(page, 'light')
})

test('saved display choices update another open tab', async ({ page, context }) => {
  await page.goto('/')
  const otherPage = await context.newPage()
  await otherPage.goto('/')
  await expectTheme(otherPage, 'light')
  await chooseMode(page, 'ダーク')
  await expectTheme(otherPage, 'dark')
  await chooseMode(otherPage, 'ライト')
  await expectTheme(page, 'light')
  await otherPage.close()
})

test('blocked theme storage keeps the selected palette usable and explains it is temporary', async ({ page }) => {
  await page.addInitScript(key => {
    const originalSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (storageKey: string, value: string) {
      if (storageKey === key) throw new DOMException('Storage unavailable', 'QuotaExceededError')
      originalSetItem.call(this, storageKey, value)
    }
  }, themeKey)
  await page.goto('/')
  await themeTrigger(page).click()
  const picker = page.getByRole('dialog', { name: '表示モード', exact: true })
  await picker.getByRole('button', { name: 'ダーク', exact: true }).click()
  await expectTheme(page, 'dark')
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('alert')).toContainText('配色設定を保存できません')
  expect(await page.evaluate(key => localStorage.getItem(key), themeKey)).toBeNull()
  await page.reload()
  await expectTheme(page, 'light')
})

test('mobile mode picker and schedule remain visible without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto('/')
  await themeTrigger(page).click()
  const picker = page.getByRole('dialog', { name: '表示モード', exact: true })
  await expect(picker.getByRole('button', { name: 'ダーク', exact: true })).toBeInViewport()
  await page.keyboard.press('Escape')
  await expect(themeTrigger(page)).toBeFocused()
  await chooseMode(page, 'ダーク')
  await expectTheme(page, 'dark')
  const settings = await openSettings(page)
  await settings.getByRole('button', { name: '時間帯で自動', exact: true }).click()
  await expect(settings.getByLabel('ライトに切り替える時刻', { exact: true })).toBeInViewport()
  await expect(settings.getByLabel('ダークに切り替える時刻', { exact: true })).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  expect(await page.getByRole('dialog').last().evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
})
