import { strict as assert } from 'node:assert'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
try {
  const context = await browser.newContext({ offline: true })
  const page = await context.newPage()
  // Managed cloud Chromium blocks file:// by policy. Fulfill the identical
  // single HTML from disk with networking disabled; no server/assets are used.
  const documentUrl = 'http://127.0.0.1:5173/MANGO-FX.html'
  const html = await readFile(resolve(root, 'dist/MANGO-FX.html'), 'utf8')
  await page.route(documentUrl, route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }))
  const errors = [], requests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (/^https?:/.test(request.url()) && request.url() !== documentUrl) requests.push(request.url()) })
  await page.goto(documentUrl)
  await page.getByRole('button', { name: '相場を一時停止', exact: true }).click()
  await page.getByRole('button', { name: '買い注文を出す', exact: true }).click()
  await page.getByRole('button', { name: 'USD / JPYの買い建玉を決済', exact: true }).click()
  await page.getByRole('tab', { name: /取引履歴/ }).click()
  const panel = page.getByRole('region', { name: '取引管理' })
  assert.equal(await panel.getByRole('cell', { name: '−¥30', exact: true }).count(), 1)
  await page.reload()
  await page.getByRole('tab', { name: /取引履歴/ }).click()
  assert.equal(await panel.getByRole('cell', { name: '−¥30', exact: true }).count(), 1)
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: '取引履歴をCSV出力', exact: true }).click()
  assert.equal((await downloaded).suggestedFilename(), 'mango-fx-trades.csv')
  assert.deepEqual(errors, [])
  assert.deepEqual(requests, [])
  console.log('PASS: standalone document runs with networking disabled, trades and closes, persists on reload, exports CSV, and loads no external assets. Direct file:// navigation is blocked by managed cloud Chromium policy and was not verified here.')
} finally { await browser.close() }
