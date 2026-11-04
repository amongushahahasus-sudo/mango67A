import { expect, test, type Page, type Route } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createSavedState } from '../src/lib/practiceState'

const buyerId = '11111111-1111-4111-8111-111111111111'
const developerId = '33333333-3333-4333-8333-333333333333'
const productId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const title = 'サンプルギフトくじ'
const exampleFile = 'EXAMPLE-NOT-VALID-0000\nThis is test data, not a redeemable gift code.\n'
const timestamp = '2026-11-04T00:00:00.000Z'
const markerKey = `mango-fx-lottery-request-v1:${buyerId}:${productId}`

const users = {
  [buyerId]: { id: buyerId, email: 'buyer@example.test', name: 'Buyer' },
  [developerId]: { id: developerId, email: 'developer@example.test', name: 'Developer' },
}
const authUser = (id: string) => ({
  id, email: users[id].email, user_metadata: { display_name: users[id].name },
  aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email', providers: ['email'] }, created_at: timestamp,
})
function session(id: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return {
    access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: id, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`,
    token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: `fixture-${id}`, user: authUser(id),
  }
}
function userId(route: Route): string | null {
  try {
    const token = route.request().headers().authorization.split(' ')[1]
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub ?? null
  } catch { return null }
}
function practiceRow() {
  const state = createSavedState()
  state.account.balance = 1_005_000
  state.paused = true
  return { state, revision: 1, updated_at: timestamp }
}
type Order = { id: string; userId: string; status: 'pending' | 'approved' | 'rejected'; purchasedAt: string; reviewedAt: string | null }
type Entry = { id: string; userId: string; requestId: string; productId: string; outcome: 'win' | 'lose'; cost: number; createdAt: string; refunded: boolean; orderId: string | null }

async function mockLottery(page: Page) {
  const server = {
    rows: { [buyerId]: practiceRow(), [developerId]: practiceRow() },
    config: { entryCost: 125, winRateBps: 2500, enabled: true, revision: 1 },
    saleMode: 'lottery' as 'direct' | 'lottery',
    productRevision: 1,
    entries: [] as Entry[], orders: [] as Order[],
    nextOutcome: 'lose' as Entry['outcome'],
    abortNextDraw: false, failLookups: false, conflictNextConfig: false, rejectNextDraw: '' as string,
    delayNextSnapshot: false, snapshotWaiting: false, releaseSnapshot: null as (() => Promise<void>) | null,
    drawRequests: [] as { userId: string; requestId: string; revision: number }[],
    lookupRequests: [] as string[], configRequests: [] as Record<string, unknown>[],
    privateDownloads: [] as string[], publicFileRequests: [] as string[],
  }
  const snapshot = (id: string | null) => {
    const realizedProfit = id ? Math.max(0, server.rows[id].state.account.balance - 1_000_000) : 0
    const spentProfit = id ? server.entries.filter(entry => entry.userId === id && !entry.refunded).reduce((sum, entry) => sum + entry.cost, 0) : 0
    const ownOrder = server.orders.filter(order => order.userId === id).at(-1)
    const activeOrder = server.orders.some(order => order.status !== 'rejected')
    return {
      role: id === developerId ? 'developer' : null,
      realizedProfit, spentProfit, availableProfit: Math.max(0, realizedProfit - spentProfit),
      lotteriesReady: true,
      photos: [{
        id: productId, title, description: '当選後、管理者の確認を経て受け取るテスト用ファイル。',
        price: server.config.entryCost, published: true, kind: 'file', saleMode: server.saleMode,
        lottery: server.saleMode === 'lottery' ? server.config : null,
        fileType: 'txt', previewPath: null, stockRemaining: activeOrder ? 0 : 1,
        purchased: Boolean(ownOrder && ownOrder.status !== 'rejected'),
        deliveryStatus: ownOrder?.status ?? 'not_purchased',
        orderId: ownOrder?.id ?? null, orderSource: ownOrder ? 'lottery' : null,
        paidPrice: ownOrder ? 0 : null, purchasedAt: ownOrder?.purchasedAt ?? null,
        revision: server.productRevision, createdAt: timestamp,
      }],
      orders: id === developerId ? server.orders.map(order => ({
        id: order.id, productId, productTitle: title, buyerLabel: users[order.userId].email,
        paidPrice: 0, source: 'lottery', status: order.status,
        purchasedAt: order.purchasedAt, reviewedAt: order.reviewedAt,
      })) : [],
    }
  }
  await page.context().route('https://testproject.supabase.co/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const id = userId(route)
    const json = (value: unknown, status = 200) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(value), headers: { 'access-control-allow-origin': '*' },
    })
    const fail = (message: string, status = 400, code = 'P0001') => json({ message, code }, status)
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' } })
      return
    }
    let body: Record<string, unknown> = {}
    try { body = request.postDataJSON() ?? {} } catch { /* No JSON body. */ }
    if (path === '/auth/v1/token') {
      const account = Object.values(users).find(user => user.email === body.email)
      if (account && body.password === 'Fixture-password-123!') await json(session(account.id))
      else await fail('invalid_credentials')
      return
    }
    if (path === '/auth/v1/user') { await json(id ? authUser(id) : null, id ? 200 : 401); return }
    if (path === '/auth/v1/logout') { await route.fulfill({ status: 204 }); return }
    if (path === '/rest/v1/practice_accounts') { await json(id ? [server.rows[id]] : []); return }
    if (path === '/rest/v1/rpc/save_practice_account') {
      if (!id || body.p_expected_user_id !== id) { await fail('ACCOUNT_USER_CHANGED', 403, '42501'); return }
      const row = server.rows[id]
      if (body.p_expected_revision !== row.revision) { await fail('ACCOUNT_CONFLICT'); return }
      row.state = body.p_state as typeof row.state
      row.revision += 1
      await json([row])
      return
    }
    if (path.startsWith('/rest/v1/rpc/')) {
      if ((body.p_expected_user_id ?? null) !== id) { await fail('ACCOUNT_USER_CHANGED', 403, '42501'); return }
      if (path.endsWith('/get_reward_shop')) {
        if (server.delayNextSnapshot) {
          server.delayNextSnapshot = false
          server.snapshotWaiting = true
          const oldSnapshot = structuredClone(snapshot(id))
          await new Promise<void>(resolve => {
            server.releaseSnapshot = async () => {
              await json(oldSnapshot)
              server.snapshotWaiting = false
              resolve()
            }
          })
        } else await json(snapshot(id))
        return
      }
      if (!id) { await fail('ACCOUNT_USER_CHANGED', 403, '42501'); return }
      if (path.endsWith('/get_shop_lottery_entry')) {
        server.lookupRequests.push(String(body.p_request_id))
        if (server.failLookups) { await route.abort('failed'); return }
        await json(server.entries.find(entry => entry.userId === id && entry.requestId === body.p_request_id && entry.productId === body.p_product_id) ?? null)
        return
      }
      if (path.endsWith('/draw_shop_lottery')) {
        const requestId = String(body.p_request_id)
        server.drawRequests.push({ userId: id, requestId, revision: Number(body.p_expected_revision) })
        const previous = server.entries.find(entry => entry.userId === id && entry.requestId === requestId)
        if (previous) { await json({ shop: snapshot(id), entry: previous }); return }
        if (server.rejectNextDraw) { const message = server.rejectNextDraw; server.rejectNextDraw = ''; await fail(message); return }
        if (!server.config.enabled) { await fail('SHOP_LOTTERY_UNAVAILABLE'); return }
        if (body.p_expected_revision !== server.config.revision) { await fail('SHOP_LOTTERY_CHANGED'); return }
        if (server.orders.some(order => order.status !== 'rejected')) { await fail('SHOP_OUT_OF_STOCK'); return }
        if (snapshot(id).availableProfit < server.config.entryCost) { await fail('SHOP_INSUFFICIENT_PROFIT'); return }
        const orderId = server.nextOutcome === 'win' ? crypto.randomUUID() : null
        if (orderId) server.orders.push({ id: orderId, userId: id, status: 'pending', purchasedAt: timestamp, reviewedAt: null })
        const entry: Entry = {
          id: crypto.randomUUID(), userId: id, requestId, productId, outcome: server.nextOutcome,
          cost: server.config.entryCost, createdAt: timestamp, refunded: false, orderId,
        }
        server.entries.push(entry)
        if (server.abortNextDraw) { server.abortNextDraw = false; await route.abort('failed'); return }
        await json({ shop: snapshot(id), entry })
        return
      }
      if (path.endsWith('/configure_shop_lottery')) {
        if (id !== developerId) { await fail('SHOP_ADMIN_REQUIRED', 403, '42501'); return }
        server.configRequests.push(body)
        if (server.conflictNextConfig) { server.conflictNextConfig = false; server.config.revision += 1; await fail('SHOP_LOTTERY_CONFLICT'); return }
        if (body.p_expected_revision !== server.config.revision) { await fail('SHOP_LOTTERY_CONFLICT'); return }
        server.config = { entryCost: Number(body.p_entry_cost), winRateBps: Number(body.p_win_rate_bps), enabled: Boolean(body.p_enabled), revision: server.config.revision + 1 }
        server.saleMode = 'lottery'
        server.productRevision += 1
        await json(snapshot(id))
        return
      }
      if (path.endsWith('/review_shop_order')) {
        if (id !== developerId) { await fail('SHOP_ADMIN_REQUIRED', 403, '42501'); return }
        const order = server.orders.find(order => order.id === body.p_order_id)
        if (!order || order.status !== 'pending') { await fail('SHOP_ORDER_CONFLICT'); return }
        order.status = body.p_decision === 'approve' ? 'approved' : 'rejected'
        order.reviewedAt = timestamp
        if (order.status === 'rejected') {
          const entry = server.entries.find(entry => entry.orderId === order.id)!
          entry.refunded = true
        }
        await json(snapshot(id))
        return
      }
      if (path.endsWith('/get_shop_product_download')) {
        const approved = server.orders.some(order => order.userId === id && order.status === 'approved')
        if (id !== developerId && !approved) { await fail('SHOP_PURCHASE_REQUIRED', 403, '42501'); return }
        await json({ bucket: 'shop-files', originalPath: `${productId}/original.txt`, fileName: `${title}.txt` })
        return
      }
    }
    if (path.startsWith('/storage/v1/object/public/shop-files/')) { server.publicFileRequests.push(path); await fail('Private bucket', 403); return }
    if (path === `/storage/v1/object/shop-files/${productId}/original.txt`) {
      if (!id || (id !== developerId && !server.orders.some(order => order.userId === id && order.status === 'approved'))) { await fail('SHOP_PURCHASE_REQUIRED', 403); return }
      server.privateDownloads.push(id)
      await route.fulfill({ status: 200, contentType: 'text/plain', body: exampleFile })
      return
    }
    await fail(`Unhandled fixture endpoint ${path}`, 500)
  })
  return server
}

async function login(page: Page, id = buyerId) {
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: 'メールアドレス', exact: true }).fill(users[id].email)
  await dialog.getByLabel('パスワード', { exact: true }).fill('Fixture-password-123!')
  await dialog.getByRole('button', { name: 'ログインする', exact: true }).click()
  await expect(page.getByRole('button', { name: `${users[id].name}のアカウント`, exact: true })).toBeVisible()
}
async function logout(page: Page, id = buyerId) {
  await page.getByRole('button', { name: `${users[id].name}のアカウント`, exact: true }).click()
  await page.getByRole('menuitem', { name: 'ログアウト', exact: true }).click()
  await expect(page.getByRole('button', { name: 'ログイン', exact: true })).toBeVisible({ timeout: 15_000 })
}
async function openShop(page: Page) { await page.getByRole('button', { name: 'ショップ', exact: true }).click() }
async function openLottery(page: Page) {
  await openShop(page)
  await page.getByRole('button', { name: 'くじを見る', exact: true }).click()
  const panel = page.getByRole('region', { name: '商品くじ', exact: true })
  await expect(panel).toBeVisible()
  return panel
}
const drawButton = (page: Page) => page.getByRole('button', { name: '125 仮想円でくじを引く', exact: true })

test('a losing draw shows its fee and odds before charging virtual profit on mobile', async ({ page }) => {
  const server = await mockLottery(page)
  await page.goto('/')
  await login(page)
  await page.setViewportSize({ width: 320, height: 800 })
  await page.getByRole('button', { name: 'メニューを開く', exact: true }).click()
  const panel = await openLottery(page)
  await expect(panel).toContainText('25%')
  await expect(panel).toContainText('はずれでも仮想利益を消費します。')
  expect(server.entries).toHaveLength(0)
  await drawButton(page).click()
  await expect(panel.getByText('今回ははずれでした', { exact: true })).toBeVisible()
  await expect(page.locator('.photo-wallet-main strong')).toHaveText('4,875 仮想円')
  expect(server.entries).toHaveLength(1)
  expect(server.entries[0].outcome).toBe('lose')
  expect(server.orders).toHaveLength(0)
  expect(server.privateDownloads).toHaveLength(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  await page.screenshot({ path: '.local/shop-lottery-mobile.png', fullPage: true })
})

test('winning reserves the file for admin review and approved delivery downloads its exact bytes', async ({ page }) => {
  const server = await mockLottery(page)
  server.nextOutcome = 'win'
  await page.goto('/')
  await login(page)
  await openLottery(page)
  await drawButton(page).click()
  await expect(page.getByRole('dialog')).toContainText('管理者の確認待ち')
  await expect(page.getByRole('dialog').getByRole('button', { name: /ダウンロード/ })).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(exampleFile.trim())
  expect(server.orders[0].status).toBe('pending')
  expect(server.privateDownloads).toHaveLength(0)
  expect(server.publicFileRequests).toHaveLength(0)
  await page.keyboard.press('Escape')
  await logout(page)
  await login(page, developerId)
  await page.getByRole('button', { name: 'ショップ管理', exact: true }).click()
  const order = page.locator('.shop-order-list > li')
  await expect(order).toContainText('くじ当選')
  await order.getByRole('button', { name: '承認して渡す', exact: true }).click()
  await order.getByRole('button', { name: '承認を確定', exact: true }).click()
  await expect.poll(() => server.orders[0].status).toBe('approved')
  await logout(page, developerId)
  await login(page)
  await openShop(page)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'ダウンロード', exact: true }).click()
  expect(await readFile((await (await download).path())!, 'utf8')).toBe(exampleFile)
  expect(server.entries).toHaveLength(1)
  expect(server.privateDownloads).toEqual([buyerId])
  await expect(page.locator('.photo-wallet-main strong')).toHaveText('4,875 仮想円')
})

test('an interrupted committed draw survives reload and recovers without another entry or charge', async ({ page }) => {
  const server = await mockLottery(page)
  server.abortNextDraw = true
  server.failLookups = true
  await page.goto('/')
  await login(page)
  await openLottery(page)
  await drawButton(page).click()
  await expect(page.getByRole('button', { name: '前のくじの結果を確認', exact: true })).toBeVisible()
  await expect.poll(() => server.entries.length).toBe(1)
  const savedRequest = await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), markerKey)
  expect(savedRequest.requestId).toBe(server.entries[0].requestId)
  await page.reload()
  server.failLookups = false
  await openLottery(page)
  const retry = page.getByRole('button', { name: '前のくじの結果を確認', exact: true })
  if (await retry.isVisible()) await retry.click()
  await expect(page.getByText('今回ははずれでした', { exact: true })).toBeVisible()
  expect(server.entries).toHaveLength(1)
  expect(new Set(server.drawRequests.map(request => request.requestId)).size).toBe(1)
  expect(server.lookupRequests.every(requestId => requestId === savedRequest.requestId)).toBe(true)
  await expect(page.locator('.photo-wallet-main strong')).toHaveText('4,875 仮想円')
  expect(await page.evaluate(key => localStorage.getItem(key), markerKey)).toBeNull()
})

test('a developer sets the fee and probability, handles stale edits, and pauses entry', async ({ page }) => {
  const server = await mockLottery(page)
  await page.goto('/')
  await login(page, developerId)
  await page.getByRole('button', { name: 'ショップ管理', exact: true }).click()
  const settings = page.getByRole('region', { name: `${title}のくじ設定`, exact: true })
  await settings.getByRole('button', { name: 'くじ設定を編集', exact: true }).click()
  await settings.getByLabel('1回に使う仮想利益', { exact: true }).fill('200')
  await settings.getByLabel('当選確率（%）', { exact: true }).fill('12.5')
  await settings.getByRole('button', { name: 'くじ設定を保存', exact: true }).click()
  await expect.poll(() => server.config.entryCost).toBe(200)
  expect(server.config.winRateBps).toBe(1250)
  await expect(settings).toContainText('くじ設定を保存しました。')
  server.conflictNextConfig = true
  await settings.getByLabel('当選確率（%）', { exact: true }).fill('50')
  await settings.getByRole('button', { name: 'くじ設定を保存', exact: true }).click()
  await expect(settings).toContainText('別の画面でくじが更新されました')
  expect(server.config.winRateBps).toBe(1250)
  const refresh = page.getByRole('region', { name: 'ショップ管理', exact: true }).getByRole('button', { name: '更新', exact: true })
  await refresh.click()
  await expect(refresh).toBeEnabled()
  await expect(settings.getByLabel('くじを有効にする', { exact: true })).toBeEnabled()
  await settings.getByLabel('くじを有効にする', { exact: true }).uncheck()
  await settings.getByRole('button', { name: 'くじ設定を保存', exact: true }).click()
  await expect.poll(() => server.config.enabled).toBe(false)
  await logout(page, developerId)
  await login(page)
  const panel = await openLottery(page)
  await expect(panel).toContainText(/停止|休止|お休み|利用できません/)
  await expect(panel.getByRole('button', { name: /仮想円でくじを引く$/ })).toBeDisabled()
  expect(server.entries).toHaveLength(0)
})

test('insufficient profit and a stock conflict never display a fabricated draw result', async ({ page }) => {
  const server = await mockLottery(page)
  server.rows[buyerId].state.account.balance = 1_000_010
  await page.goto('/')
  await login(page)
  const panel = await openLottery(page)
  await expect(drawButton(page)).toBeDisabled()
  await expect(panel).toContainText(/不足|足りません/)
  expect(server.drawRequests).toHaveLength(0)
  await page.keyboard.press('Escape')
  await logout(page)
  server.rows[buyerId].state.account.balance = 1_005_000
  await login(page)
  await openLottery(page)
  server.rejectNextDraw = 'SHOP_OUT_OF_STOCK'
  await drawButton(page).click()
  await expect(page.getByRole('region', { name: '商品くじ', exact: true })).toContainText(/在庫|受付/)
  await expect(page.getByText(/^(?:今回ははずれでした|当選しました)$/)).toHaveCount(0)
  expect(server.entries).toHaveLength(0)
  expect(server.orders).toHaveLength(0)
  expect(server.privateDownloads).toHaveLength(0)
})

test('an older catalog reload cannot overwrite a completed draw balance or reserved stock', async ({ page }) => {
  const server = await mockLottery(page)
  server.nextOutcome = 'win'
  await page.goto('/')
  await login(page)
  await openShop(page)
  await expect(page.locator('.photo-wallet-main strong')).toHaveText('5,000 仮想円')
  server.delayNextSnapshot = true
  await page.getByRole('button', { name: '更新', exact: true }).click()
  await expect.poll(() => server.snapshotWaiting).toBe(true)
  await page.getByRole('button', { name: 'くじを見る', exact: true }).click()
  await drawButton(page).click()
  await expect(page.getByRole('dialog')).toContainText('管理者の確認待ち')
  await expect(page.locator('.photo-wallet-main strong')).toHaveText('4,875 仮想円')
  await server.releaseSnapshot!()
  await expect(page.getByRole('button', { name: '更新', exact: true })).toBeEnabled()
  await expect(page.locator('.photo-wallet-main strong')).toHaveText('4,875 仮想円')
  await expect(page.getByRole('dialog')).toContainText('管理者の確認待ち')
  await expect(page.getByRole('button', { name: 'くじを見る', exact: true })).toHaveCount(0)
  expect(server.entries).toHaveLength(1)
  expect(server.orders[0].status).toBe('pending')
})
