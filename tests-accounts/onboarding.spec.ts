import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import { createSavedState } from '../src/lib/practiceState'

const completionKey = 'mango-fx-onboarding-v1'
const userId = '77777777-7777-4777-8777-777777777777'
const password = 'Fixture-password-123!'
const user = { id: userId, email: 'tutorial@example.test', user_metadata: { display_name: 'Tutorial User' }, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email', providers: ['email'] }, created_at: '2026-11-05T00:00:00Z' }
const row = () => { const state = createSavedState(); state.paused = true; return { state, revision: 1, updated_at: '2026-11-05T00:00:00Z' } }
const authSession = () => {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return { access_token: `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: userId, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, token_type: 'bearer', expires_in: 3600, refresh_token: 'tutorial-fixture-refresh', user }
}

async function backend(page: Page) {
  const signupRequests: Record<string, unknown>[] = []
  let savedRow = row()
  await page.context().route('https://testproject.supabase.co/**', async (route: Route) => {
    const request = route.request(), path = new URL(request.url()).pathname
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value), headers: { 'access-control-allow-origin': '*' } })
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' } }); return }
    let body: Record<string, unknown> = {}
    try { body = request.postDataJSON() ?? {} } catch { /* GET */ }
    if (path === '/auth/v1/signup') {
      signupRequests.push(body)
      await json({ user: { ...user, email: body.email, identities: [{ provider: 'email' }] }, session: null })
    } else if (path === '/auth/v1/token') await json(authSession())
    else if (path === '/auth/v1/user') await json(user)
    else if (path === '/rest/v1/practice_accounts') await json([savedRow])
    else if (path === '/rest/v1/rpc/save_practice_account') {
      savedRow = { state: body.p_state as typeof savedRow.state, revision: savedRow.revision + 1, updated_at: savedRow.updated_at }
      await json([savedRow])
    } else if (path === '/rest/v1/rpc/get_reward_shop' || path === '/rest/v1/rpc/get_photo_shop') await json({ code: 'PGRST202', message: 'Fixture shop not installed' }, 404)
    else await json({ message: 'Unexpected tutorial fixture request' }, 500)
  })
  return { signupRequests }
}

async function advanceToLastPage(dialog: Locator) {
  for (let i = 0; i < 10; i += 1) {
    const next = dialog.getByRole('button', { name: '次へ', exact: true })
    if (!await next.isVisible()) return
    await next.click()
  }
  throw new Error('The tutorial did not reach its last page')
}

test.use({ storageState: { cookies: [], origins: [] } })

test('a first visit pages forward and back, finishes as a guest, and can be replayed', async ({ page }) => {
  await backend(page)
  await page.goto('/')
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: /ようこそ/ })).toBeVisible()
  const firstTitle = await dialog.getByRole('heading', { level: 2 }).textContent()
  await dialog.getByRole('button', { name: '次へ', exact: true }).click()
  await expect(dialog.getByRole('heading', { level: 2 })).not.toHaveText(firstTitle!)
  await dialog.getByRole('button', { name: '前に戻る', exact: true }).click()
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText(firstTitle!)
  await advanceToLastPage(dialog)
  await dialog.getByRole('button', { name: 'ゲストで始める', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(await page.evaluate(key => localStorage.getItem(key), completionKey)).toBe('completed')
  await page.reload()
  await expect(page.getByRole('button', { name: '買い注文を出す', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const replay = page.getByRole('button', { name: 'チュートリアル', exact: true })
  await replay.click()
  await expect(page.getByRole('dialog').getByRole('heading', { name: /ようこそ/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(replay).toBeFocused()
})

test('the final tutorial page opens the real registration form and confirmation flow', async ({ page }) => {
  const server = await backend(page)
  await page.goto('/')
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: /ようこそ/ })).toBeVisible()
  await advanceToLastPage(dialog)
  await dialog.getByRole('button', { name: '会員登録へ進む', exact: true }).click()
  const registration = page.getByRole('dialog', { name: 'あなただけの練習口座を。', exact: true })
  await expect(registration).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await expect(registration.getByRole('button', { name: 'Googleで登録 / ログイン', exact: true })).toBeVisible()
  await registration.getByRole('textbox', { name: /表示名/ }).fill('First Visitor')
  await registration.getByRole('textbox', { name: 'メールアドレス', exact: true }).fill('new-tutorial@example.test')
  await registration.locator('input[autocomplete="new-password"]').first().fill(password)
  await registration.getByLabel('パスワード（確認）', { exact: true }).fill(password)
  await registration.getByRole('button', { name: 'アカウントを作成', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'メールをご確認ください', exact: true })).toBeVisible()
  expect(server.signupRequests).toHaveLength(1)
  expect(server.signupRequests[0]).toMatchObject({ email: 'new-tutorial@example.test', data: { display_name: 'First Visitor' } })
  expect(await page.evaluate(key => localStorage.getItem(key), completionKey)).toBe('completed')
})

test('the welcome dialog fits a small screen and keeps keyboard focus inside', async ({ page }) => {
  await backend(page)
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto('/')
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: /ようこそ/ })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '次へ', exact: true })).toBeInViewport()
  for (let i = 0; i < 9; i += 1) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
  }
  await dialog.evaluate(element => { element.scrollTop = element.scrollHeight })
  await dialog.getByRole('button', { name: '次へ', exact: true }).click()
  await expect(dialog.getByRole('heading', { level: 2 })).toBeFocused()
  expect(await dialog.evaluate(element => element.scrollTop)).toBe(0)
  await expect(dialog.getByRole('button', { name: '前に戻る', exact: true })).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  expect(await dialog.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
  await page.screenshot({ path: '.local/onboarding-mobile.png', fullPage: true })
  await page.keyboard.press('Escape')
  const menu = page.getByRole('button', { name: 'メニューを開く', exact: true })
  await menu.click()
  await page.getByRole('button', { name: 'チュートリアル', exact: true }).click()
  await page.getByRole('button', { name: 'チュートリアルを閉じる', exact: true }).click()
  await expect(menu).toBeFocused()
})

test('OAuth callback failures remain actionable on a browser without tutorial history', async ({ page }) => {
  await backend(page)
  await page.goto('/#error=access_denied&error_code=access_denied&error_description=Fixture%20cancelled')
  const auth = page.getByRole('dialog', { name: 'おかえりなさい。', exact: true })
  await expect(auth).toBeVisible()
  await expect(auth.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('heading', { name: /ようこそ/ })).toHaveCount(0)
  await auth.getByRole('button', { name: 'アカウント画面を閉じる', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('quickly closing replay restores the visible menu opener while the sidebar is still closing', async ({ page }) => {
  await backend(page)
  await page.setViewportSize({ width: 320, height: 780 })
  await page.goto('/')
  await page.getByRole('button', { name: 'チュートリアルを閉じる', exact: true }).click()
  const menu = page.getByRole('button', { name: 'メニューを開く', exact: true })
  const sidebar = page.getByRole('complementary', { name: 'メインナビゲーション', exact: true })
  // Hold only the closing transition so the old trigger still overlaps the
  // viewport when focus restoration runs. Opening retains the real duration.
  await page.addStyleTag({ content: '.sidebar:not(.mobile-open) { transition: transform 10s linear !important; }' })
  await menu.click()
  await expect(sidebar).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
  await page.getByRole('button', { name: 'チュートリアル', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'MANGO FXへようこそ。', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(sidebar).not.toHaveClass(/mobile-open/)
  expect(await sidebar.evaluate(element => element.getBoundingClientRect().right)).toBeGreaterThan(0)
  await expect(menu).toBeFocused()
})

test('password recovery opens its existing form instead of the first-visit guide', async ({ page }) => {
  await backend(page)
  await page.addInitScript(() => localStorage.setItem('mango-fx-auth-v1:testproject.supabase.co:/-code-verifier', JSON.stringify('tutorial-fixture-verifier/recovery')))
  await page.goto('/?code=tutorial-fixture-recovery-code')
  const recovery = page.getByRole('dialog', { name: '新しいパスワードを設定', exact: true })
  await expect(recovery).toBeVisible()
  await expect(recovery.getByLabel('パスワード（確認）', { exact: true })).toBeEnabled()
  await expect(page.getByRole('heading', { name: /ようこそ/ })).toHaveCount(0)
})

test('unavailable first-visit storage does not trap the app and manual replay still works', async ({ page }) => {
  await backend(page)
  const errors: string[] = []
  page.on('pageerror', reason => errors.push(reason.message))
  await page.addInitScript(key => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem
    Storage.prototype.getItem = function (name) { if (name === key) throw new DOMException('Unavailable', 'SecurityError'); return get.call(this, name) }
    Storage.prototype.setItem = function (name, value) { if (name === key) throw new DOMException('Unavailable', 'QuotaExceededError'); return set.call(this, name, value) }
  }, completionKey)
  await page.goto('/')
  await expect(page.getByRole('button', { name: '買い注文を出す', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'チュートリアル', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: /ようこそ/ })).toBeVisible()
  await advanceToLastPage(dialog)
  await dialog.getByRole('button', { name: 'ゲストで始める', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(errors).toEqual([])
})
