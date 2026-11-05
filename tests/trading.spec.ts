import { test, expect, type Page } from '@playwright/test'
import { createSavedState } from '../src/lib/practiceState'

async function freezeMarketClock(page: Page) {
  const instant = new Date('2026-11-05T12:00:00Z')
  await page.clock.install({ time: new Date(instant.getTime() - 60_000) })
  await page.clock.pauseAt(instant)
}

const lastMarketTime = (page: Page) => page.evaluate(() =>
  JSON.parse(localStorage.getItem('mango-fx-simulator-v1')!).markets.USDJPY.at(-1).time as number)

test('market buy, spread, close, CSV export and persisted history', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await freezeMarketClock(page)
  await page.goto('/')
  await page.clock.runFor(100)
  await expect(page.getByRole('heading', { name: /^(おはようございます|こんにちは|こんばんは)。$/ })).toBeVisible()
  await page.getByRole('button', { name: '買い注文を出す' }).click()
  const positions = page.getByRole('region', { name: '取引管理' })
  await expect(positions.getByRole('button', { name: 'USD / JPYの買い建玉を決済', exact: true })).toBeVisible()
  await expect(positions.getByRole('cell', { name: '−¥30', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'USD / JPYの買い建玉を決済', exact: true }).click()
  await page.getByRole('tab', { name: /取引履歴/ }).click()
  await expect(positions.getByRole('cell', { name: '−¥30', exact: true })).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '取引履歴をCSV出力' }).click()
  expect((await download).suggestedFilename()).toBe('mango-fx-trades.csv')
  await page.reload()
  await expect(page.getByRole('button', { name: /相場を一時停止|相場を再生/ })).toHaveCount(0)
  await expect(page.locator('.market-note')).toContainText('シミュレーション稼働中')
  await page.getByRole('tab', { name: /取引履歴/ }).click()
  await expect(positions.getByRole('cell', { name: '−¥30', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('pending order validation, placement and cancellation', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '指値', exact: true }).click()
  await page.getByRole('button', { name: '買い注文を出す' }).click()
  await expect(page.getByRole('alert')).toContainText('注文価格')
  await page.getByRole('spinbutton', { name: '注文価格', exact: true }).fill('1')
  await page.getByRole('button', { name: '買い注文を出す' }).click()
  const panel = page.getByRole('region', { name: '取引管理' })
  await expect(panel.getByRole('button', { name: '取消', exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByRole('heading', { name: '待機中の注文はありません' })).toBeVisible()
})

test('lot and margin validation, sell workflow, guide and safe reset', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('spinbutton', { name: '取引数量（lot）', exact: true }).fill('0.01')
  await page.getByRole('button', { name: '買い注文を出す' }).click()
  await expect(page.getByRole('alert')).toContainText('0.1 lot')
  await page.getByRole('spinbutton', { name: '取引数量（lot）', exact: true }).fill('100')
  await page.getByRole('button', { name: '買い注文を出す' }).click()
  await expect(page.getByRole('alert')).toContainText('証拠金が不足')
  await page.getByRole('button', { name: '0.1 lot', exact: true }).click()
  await page.getByRole('button', { name: /売り SELL/ }).click()
  await page.getByRole('button', { name: '売り注文を出す' }).click()
  await expect(page.getByRole('button', { name: 'USD / JPYの売り建玉を決済', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '使い方', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await page.getByRole('button', { name: 'シミュレーター設定', exact: true }).click()
  await page.getByLabel('相場シナリオ').selectOption('volatile')
  await page.getByRole('button', { name: '練習をリセットする', exact: true }).click()
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click()
  await page.getByRole('button', { name: '練習をリセットする', exact: true }).click()
  await page.getByRole('button', { name: 'リセットする', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'まだ、ポジションはありません' })).toBeVisible()
})

test('all currency pairs, chart timeframes and responsive mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  for (const pair of ['EUR / JPY', 'GBP / JPY', 'EUR / USD', 'USD / JPY']) {
    await page.getByRole('button', { name: new RegExp(pair.replaceAll('/', '\\/')) }).filter({ has: page.locator('.pair-top') }).click()
    await expect(page.locator('.instrument-name')).toContainText(pair)
  }
  await page.getByRole('button', { name: '5分', exact: true }).click()
  await expect(page.getByRole('button', { name: '5分', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: '1時間', exact: true }).click()
  await page.getByRole('button', { name: '買い注文を出す' }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'メニューを開く' }).click()
  await page.getByRole('button', { name: '学習ガイド', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'しくみがわかると、取引が変わる。' })).toBeVisible()
})

test('corrupted local storage recovers to a usable account', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mango-fx-simulator-v1', '{broken'))
  await page.goto('/')
  await page.getByRole('button', { name: '買い注文を出す' }).click()
  await expect(page.getByRole('button', { name: 'USD / JPYの買い建玉を決済', exact: true })).toBeVisible()
})


test('running market automatically takes profit and announces the result', async ({ page }) => {
  await freezeMarketClock(page)
  await page.addInitScript(() => { Math.random = () => 0.9 })
  await page.goto('/')
  await page.clock.runFor(100)
  const ask = Number(await page.locator('.quote-button.buy strong').textContent())
  await page.getByRole('checkbox', { name: '利確・損切りを設定' }).check()
  await page.getByRole('spinbutton', { name: '利確価格', exact: true }).fill((ask + 0.015).toFixed(3))
  await page.getByRole('button', { name: '買い注文を出す' }).click()
  await page.clock.runFor(2_000)
  await expect(page.getByRole('status')).toContainText('自動決済', { timeout: 7000 })
  await page.getByRole('tab', { name: /取引履歴/ }).click()
  await expect(page.getByRole('region', { name: '取引管理' }).getByRole('cell', { name: /利確/ })).toBeVisible()
  await expect(page.getByRole('region', { name: '取引管理' }).getByRole('cell').filter({ hasText: /\+¥/ })).toBeVisible()
})

test('a legacy paused market resumes automatically and exposes only speed controls', async ({ page }) => {
  const legacy = createSavedState()
  legacy.paused = true
  await page.addInitScript(state => localStorage.setItem('mango-fx-simulator-v1', JSON.stringify(state)), legacy)
  await page.goto('/')
  await expect(page.getByRole('button', { name: /相場を一時停止|相場を再生/ })).toHaveCount(0)
  await expect(page.locator('.market-note')).toContainText('シミュレーション稼働中')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('mango-fx-simulator-v1')!).paused)).toBe(false)
  const before = await lastMarketTime(page)
  await expect.poll(() => lastMarketTime(page), { timeout: 7_000 }).toBeGreaterThan(before)
  for (const speed of [2, 5, 1]) {
    await page.getByRole('button', { name: `×${speed}`, exact: true }).click()
    await expect(page.getByRole('button', { name: `×${speed}`, exact: true })).toHaveAttribute('aria-pressed', 'true')
  }
  const afterSpeedChange = await lastMarketTime(page)
  await expect.poll(() => lastMarketTime(page), { timeout: 7_000 }).toBeGreaterThan(afterSpeedChange)
})

test('installation help works on Chromebook-sized screens and restores keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const trigger = page.getByRole('button', { name: 'アプリのインストール方法', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'いつもの練習を、アプリから。' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Chromebook / Google Chrome')
  await expect(dialog).toContainText('Windows / Microsoft Edge')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(trigger).toBeFocused()
})
