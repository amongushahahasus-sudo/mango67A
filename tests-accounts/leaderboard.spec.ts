import { expect, test, type Page, type Route } from '@playwright/test'
import { createSavedState } from '../src/lib/practiceState'

const alice = '11111111-1111-4111-8111-111111111111'
const bob = '22222222-2222-4222-8222-222222222222'
const password = 'Fixture-password-123!'
const stamp = '2026-11-05T00:00:00.000Z'
const aliceAlias = 'トレーダーAAAAAAAAAA'
const bobAlias = 'トレーダーBBBBBBBBBB'
type Direction = 'profit' | 'loss'
type Entry = { position: number; rank: number; displayName: string; realizedPnl: number; isMe: boolean }
const users = {
  [alice]: { id: alice, email: 'alice@example.test', user_metadata: { display_name: 'Alice' }, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email', providers: ['email'] }, created_at: stamp },
  [bob]: { id: bob, email: 'bob@example.test', user_metadata: { display_name: 'Bob' }, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email', providers: ['email'] }, created_at: stamp },
}
type Row = { state: ReturnType<typeof createSavedState>; revision: number; updated_at: string }
function row(balance: number): Row { const state = createSavedState(); state.account.balance = balance; state.paused = true; return { state, revision: 1, updated_at: stamp } }
function session(id: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return { access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: id, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: `fixture-${id}`, user: users[id] }
}
function uid(route: Route): string | null {
  try { return JSON.parse(Buffer.from(route.request().headers().authorization.split(' ')[1].split('.')[1], 'base64url').toString()).sub ?? null } catch { return null }
}
async function backend(page: Page) {
  let release: (() => void) | null = null
  const server = {
    rows: { [alice]: row(1_234_567.89), [bob]: row(800_000) },
    requests: [] as { direction: Direction; user: string; expected: string; pnl: number }[],
    events: [] as string[], empty: false, missing: false, failLoss: false,
    hold: false,
    release: () => { server.hold = false; release?.(); release = null },
  }
  let gate: Promise<void> | null = null
  const snapshot = (direction: Direction, id: string) => {
    const pnl = server.empty ? 0 : Math.round((server.rows[id].state.account.balance - 1_000_000) * 100) / 100
    let entries: Entry[] = []
    if (!server.empty) {
      const ranked = direction === 'profit'
        ? [{ displayName: 'トレーダーCCCCCCCCCC', realizedPnl: 2_000_000, isMe: false }, { displayName: aliceAlias, realizedPnl: Math.round((server.rows[alice].state.account.balance - 1_000_000) * 100) / 100, isMe: id === alice }]
        : [{ displayName: 'トレーダーDDDDDDDDDD', realizedPnl: -900_000, isMe: false }, { displayName: 'トレーダーEEEEEEEEEE', realizedPnl: -500_000.25, isMe: false }, { displayName: bobAlias, realizedPnl: -200_000, isMe: id === bob }]
      entries = ranked.map((entry, index) => ({ ...entry, position: index + 1, rank: index + 1 }))
    }
    return { direction, entries, ownEntry: entries.find(entry => entry.isMe) ?? null, myRealizedPnl: pnl, participantCount: entries.length, generatedAt: stamp }
  }
  await page.context().route('https://testproject.supabase.co/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, id = uid(route)
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } })
    const fail = (message: string, code = 'P0001', status = 400) => json({ message, code }, status)
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' } }); return }
    let body: Record<string, unknown> = {}
    try { body = request.postDataJSON() ?? {} } catch { /* GET. */ }
    if (path === '/auth/v1/token') {
      const account = Object.values(users).find(user => user.email === body.email)
      if (account && body.password === password) await json(session(account.id)); else await fail('invalid_credentials')
    } else if (path === '/auth/v1/user') await json(id ? users[id] : null, id ? 200 : 401)
    else if (path === '/auth/v1/logout') await route.fulfill({ status: 204 })
    else if (path === '/rest/v1/practice_accounts') await json(id ? [server.rows[id]] : [])
    else if (path === '/rest/v1/rpc/save_practice_account') {
      if (!id || body.p_expected_user_id !== id) { await fail('ACCOUNT_USER_CHANGED', '42501', 403); return }
      const previous = server.rows[id]
      if (previous.revision !== body.p_expected_revision) { await fail('ACCOUNT_CONFLICT'); return }
      server.rows[id] = { state: body.p_state as Row['state'], revision: previous.revision + 1, updated_at: stamp }
      server.events.push('save')
      await json([server.rows[id]])
    } else if (path === '/rest/v1/rpc/get_reward_shop') await fail('function not found', 'PGRST202', 404)
    else if (path === '/rest/v1/rpc/get_photo_shop') {
      const profit = id ? Math.max(0, Math.floor(server.rows[id].state.account.balance - 1_000_000)) : 0
      await json({ role: null, realizedProfit: profit, spentProfit: 0, availableProfit: profit, photos: [] })
    } else if (path === '/rest/v1/rpc/get_practice_leaderboard') {
      if (!id || body.p_expected_user_id !== id) { await fail('ACCOUNT_USER_CHANGED', '42501', 403); return }
      const direction = body.p_direction as Direction
      server.requests.push({ direction, user: id, expected: String(body.p_expected_user_id), pnl: server.rows[id].state.account.balance - 1_000_000 })
      server.events.push(`ranking:${direction}`)
      if (server.missing) { await fail('function not found', 'PGRST202', 404); return }
      if (direction === 'loss' && server.failLoss) { await fail('private server detail', 'XX000', 500); return }
      const result = snapshot(direction, id)
      if (server.hold) { gate ??= new Promise<void>(resolve => { release = resolve }); await gate }
      await json(result)
    } else await fail(`Unhandled fixture endpoint ${path}`, 'XX000', 500)
  })
  return server
}
async function login(page: Page, id = alice) {
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: 'メールアドレス', exact: true }).fill(users[id].email)
  await dialog.getByLabel('パスワード', { exact: true }).fill(password)
  await dialog.getByRole('button', { name: 'ログインする', exact: true }).click()
  await expect(page.getByRole('button', { name: `${users[id].user_metadata.display_name}のアカウント`, exact: true })).toBeVisible()
}
async function openRanking(page: Page) {
  const nav = page.getByRole('button', { name: 'ランキング', exact: true })
  const menu = page.getByRole('button', { name: 'メニューを開く', exact: true })
  if (await menu.isVisible()) await menu.click()
  await nav.click()
}
const region = (page: Page, direction: Direction) => page.getByRole('region', { name: direction === 'profit' ? 'プラスランキング' : 'マイナスランキング', exact: true })

test('one ranking page contains both boards, requires login, and stacks on mobile', async ({ page }) => {
  const server = await backend(page)
  await page.setViewportSize({ width: 320, height: 780 })
  await page.goto('/')
  await openRanking(page)
  await expect(page.getByRole('heading', { name: '＋ランキング', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '−ランキング', exact: true })).toBeVisible()
  await expect(page.getByText('ランキングを見るにはログインしてください。', { exact: true })).toBeVisible()
  expect(server.requests).toEqual([])
  const plus = await region(page, 'profit').boundingBox(), minus = await region(page, 'loss').boundingBox()
  expect(plus).not.toBeNull(); expect(minus).not.toBeNull()
  expect(minus!.y).toBeGreaterThanOrEqual(plus!.y + plus!.height - 1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  await page.screenshot({ path: '.local/leaderboard-mobile-guest.png', fullPage: true })
})

test('registered users see ordered signs, their own rank, and both boards refresh after saved trading', async ({ page }) => {
  const server = await backend(page)
  await page.goto('/')
  await login(page)
  server.events.length = 0
  await page.getByRole('button', { name: '買い注文を出す', exact: true }).click()
  await page.getByRole('button', { name: 'USD / JPYの買い建玉を決済', exact: true }).click()
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  await openRanking(page)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  await expect(page.getByRole('heading', { level: 1 })).toBeInViewport()
  const plus = region(page, 'profit'), minus = region(page, 'loss')
  await expect(plus.getByRole('list', { name: 'プラスの順位一覧' }).getByRole('listitem')).toHaveCount(2)
  await expect(minus.getByRole('list', { name: 'マイナスの順位一覧' }).getByRole('listitem')).toHaveCount(3)
  const plusRows = plus.getByRole('listitem'), minusRows = minus.getByRole('listitem')
  await expect(plusRows.nth(0)).toContainText('トレーダーCCCCCCCCCC')
  await expect(plusRows.nth(0)).toContainText('+2,000,000 円')
  await expect(plusRows.nth(1)).toContainText(aliceAlias)
  await expect(plusRows.nth(1)).toContainText('あなた')
  await expect(minusRows.nth(0)).toContainText('−900,000 円')
  await expect(minusRows.nth(1)).toContainText('−500,000.25 円')
  await expect(minusRows.nth(2)).toContainText('−200,000 円')
  await expect(plus.getByLabel('プラスランキングの自分の順位')).toContainText('2位')
  await expect(minus.getByLabel('マイナスランキングの自分の順位')).toContainText('対象外')
  await expect(page.getByRole('region', { name: '登録者ランキング', exact: true })).not.toContainText('alice@example.test')
  expect(server.events.indexOf('save')).toBeGreaterThanOrEqual(0)
  expect(server.events.indexOf('save')).toBeLessThan(server.events.findIndex(value => value.startsWith('ranking:')))
  expect(server.requests.every(request => request.user === alice && request.expected === alice)).toBe(true)
  expect(server.rows[alice].state.account.history).toHaveLength(1)
  expect(server.requests.every(request => request.pnl === server.rows[alice].state.account.balance - 1_000_000)).toBe(true)
  const before = server.requests.length
  await page.getByRole('button', { name: 'ランキングを更新', exact: true }).click()
  await expect.poll(() => server.requests.length).toBe(before + 2)
  expect(server.requests.slice(-2).map(request => request.direction).sort()).toEqual(['loss', 'profit'])
  await page.screenshot({ path: '.local/leaderboard-desktop.png', fullPage: true })
})

test('empty boards and missing setup display clear states without sample users', async ({ page }) => {
  const server = await backend(page)
  server.empty = true
  server.rows[alice] = row(1_000_000)
  await page.goto('/')
  await login(page)
  await openRanking(page)
  await expect(page.getByRole('heading', { name: 'まだ参加者がいません', exact: true })).toHaveCount(2)
  await expect(page.getByRole('listitem').filter({ hasText: 'トレーダー' })).toHaveCount(0)
  server.missing = true
  await page.getByRole('button', { name: 'ランキングを更新', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'ランキングは準備中です', exact: true })).toHaveCount(2)
  await expect(page.getByRole('region', { name: '登録者ランキング', exact: true })).not.toContainText('function not found')
})

test('one board can fail without hiding the other board or exposing raw backend errors', async ({ page }) => {
  const server = await backend(page)
  server.failLoss = true
  await page.goto('/')
  await login(page)
  await openRanking(page)
  await expect(region(page, 'profit').getByText(aliceAlias, { exact: true })).toBeVisible()
  await expect(region(page, 'loss').getByRole('heading', { name: 'ランキングを読み込めませんでした', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '登録者ランキング', exact: true })).not.toContainText('private server detail')
})

test('a delayed previous-user result cannot appear after logout', async ({ page }) => {
  const server = await backend(page)
  await page.goto('/')
  await login(page)
  server.hold = true
  await openRanking(page)
  await expect.poll(() => server.requests.length).toBe(2)
  await page.getByRole('button', { name: 'Aliceのアカウント', exact: true }).click()
  await page.getByRole('menuitem', { name: 'ログアウト', exact: true }).click()
  await expect(page.getByRole('button', { name: 'ログイン', exact: true })).toBeVisible({ timeout: 15_000 })
  server.release()
  await openRanking(page)
  await expect(page.getByText('ランキングを見るにはログインしてください。', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '登録者ランキング', exact: true })).not.toContainText(aliceAlias)
  await expect(page.getByRole('listitem').filter({ hasText: 'トレーダー' })).toHaveCount(0)
})
