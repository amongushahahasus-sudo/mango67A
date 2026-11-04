import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createSavedState } from '../src/lib/practiceState'
import type { ShopPhoto, ShopSnapshot } from '../src/lib/photoShop'

const alice = '11111111-1111-4111-8111-111111111111'
const developer = '33333333-3333-4333-8333-333333333333'
const photoId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const password = 'Fixture-password-123!'
const time = '2026-11-04T00:00:00.000Z'
const users = {
  [alice]: { id: alice, email: 'alice@example.test', user_metadata: { display_name: 'Alice', role: 'developer', is_admin: true }, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email', providers: ['email'] }, created_at: time },
  [developer]: { id: developer, email: 'developer@example.test', user_metadata: { display_name: 'Developer' }, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email', providers: ['email'] }, created_at: time },
}
type UserId = keyof typeof users
type PracticeRow = { state: ReturnType<typeof createSavedState>; revision: number; updated_at: string }
type CatalogPhoto = Omit<ShopPhoto, 'purchased' | 'paidPrice' | 'purchasedAt'> & { originalPath: string }
type Purchase = { price: number; at: string }

function practice(balance: number): PracticeRow {
  const state = createSavedState()
  state.account.balance = balance
  state.paused = true
  return { state, revision: 1, updated_at: time }
}
function session(id: UserId) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const accessToken = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: id, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) })}.fixture-signature`
  return { access_token: accessToken, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: `photo-fixture-${id}`, user: users[id] }
}
function identity(route: Route): string | null {
  try { return JSON.parse(Buffer.from(route.request().headers().authorization.split(' ')[1].split('.')[1], 'base64url').toString()).sub || null }
  catch { return null }
}

async function backend(page: Page) {
  const image = await readFile('public/icons/mango-fx-192.png')
  const server = {
    rows: { [alice]: practice(1_005_000), [developer]: practice(1_020_000) } as Record<string, PracticeRow>,
    roles: { [developer]: 'developer' } as Record<string, 'developer' | 'admin'>,
    photos: [{ id: photoId, title: '朝の海', description: '開発者が撮影した海の写真です。', price: 2000, published: true, previewPath: `${photoId}/preview.jpg`, originalPath: `${photoId}/original.png`, revision: 1, createdAt: time }] as CatalogPhoto[],
    purchases: {} as Record<string, Record<string, Purchase>>,
    purchaseRequests: [] as { user: string; photo: string; price: number }[],
    uploads: [] as { user: string; path: string; type: string; bytes: Buffer }[],
    previewImage: image,
    originalRequests: [] as { user: string; path: string }[],
    saves: [] as { user: string; body: Record<string, unknown> }[],
    setupMissing: false,
  }
  const snapshot = (id: string | null): ShopSnapshot => {
    const role = id ? server.roles[id] ?? null : null
    const owned = id ? server.purchases[id] ?? {} : {}
    const realizedProfit = id ? Math.max(0, Math.floor((server.rows[id]?.state.account.balance ?? 1_000_000) - 1_000_000)) : 0
    const spentProfit = Object.values(owned).reduce((sum, purchase) => sum + purchase.price, 0)
    return {
      role, realizedProfit, spentProfit, availableProfit: Math.max(0, realizedProfit - spentProfit),
      photos: server.photos.filter(photo => photo.published || role || owned[photo.id]).map(({ originalPath: _path, ...photo }) => ({ ...photo, purchased: Boolean(owned[photo.id]), paidPrice: owned[photo.id]?.price ?? null, purchasedAt: owned[photo.id]?.at ?? null })),
    }
  }
  await page.context().route('https://testproject.supabase.co/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, id = identity(route)
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } })
    const fail = (message: string, status = 400, code = 'P0001') => json({ message, code }, status)
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': '*' } }); return }
    let body: Record<string, unknown> = {}
    try { body = request.postDataJSON() || {} } catch { /* Storage binary body. */ }
    if (path === '/auth/v1/token') {
      const found = Object.values(users).find(user => user.email === body.email)
      if (found && body.password === password) await json(session(found.id as UserId))
      else await json({ code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400)
    } else if (path === '/auth/v1/user') {
      if (id && users[id as UserId]) await json(users[id as UserId]); else await fail('Invalid token', 401)
    } else if (path === '/auth/v1/logout') await route.fulfill({ status: 204 })
    else if (path === '/rest/v1/practice_accounts') {
      if (!id || new URL(request.url()).searchParams.get('user_id') !== `eq.${id}`) await fail('ACCOUNT_USER_CHANGED', 403, '42501')
      else await json(server.rows[id] ? [server.rows[id]] : [])
    } else if (path === '/rest/v1/rpc/save_practice_account') {
      if (!id || body.p_expected_user_id !== id) { await fail('ACCOUNT_USER_CHANGED', 403, '42501'); return }
      const previous = server.rows[id]
      if (previous ? body.p_expected_revision !== previous.revision : body.p_expected_revision !== null) { await fail('ACCOUNT_CONFLICT'); return }
      server.rows[id] = { state: body.p_state as PracticeRow['state'], revision: (previous?.revision ?? 0) + 1, updated_at: time }
      await json([server.rows[id]])
    } else if (path.startsWith('/rest/v1/rpc/') && server.setupMissing) await fail('Function not found', 404, 'PGRST202')
    else if (path === '/rest/v1/rpc/get_photo_shop') {
      if ((body.p_expected_user_id ?? null) !== id) await fail('ACCOUNT_USER_CHANGED', 403, '42501')
      else await json(snapshot(id))
    } else if (path === '/rest/v1/rpc/purchase_shop_photo') {
      if (!id || body.p_expected_user_id !== id) { await fail('ACCOUNT_USER_CHANGED', 403, '42501'); return }
      const selected = server.photos.find(photo => photo.id === body.p_photo_id)
      server.purchaseRequests.push({ user: id, photo: String(body.p_photo_id), price: Number(body.p_expected_price) })
      if (server.purchases[id]?.[String(body.p_photo_id)]) { await json(snapshot(id)); return }
      if (!selected || !selected.published) { await fail('SHOP_PHOTO_UNAVAILABLE'); return }
      if (selected.price !== body.p_expected_price) { await fail('SHOP_PRICE_CHANGED'); return }
      if (snapshot(id).availableProfit < selected.price) { await fail('SHOP_INSUFFICIENT_PROFIT'); return }
      server.purchases[id] ??= {}
      server.purchases[id][selected.id] = { price: selected.price, at: time }
      await json(snapshot(id))
    } else if (path === '/rest/v1/rpc/save_shop_photo') {
      if (!id || body.p_expected_user_id !== id || !server.roles[id]) { await fail('SHOP_ADMIN_REQUIRED', 403, '42501'); return }
      const selected = server.photos.find(photo => photo.id === body.p_photo_id)
      if (selected && body.p_expected_revision !== selected.revision) { await fail('SHOP_PHOTO_CONFLICT'); return }
      server.saves.push({ user: id, body })
      if (selected) Object.assign(selected, { title: body.p_title, description: body.p_description, price: body.p_price, published: body.p_published, revision: selected.revision + 1 })
      else server.photos.unshift({ id: String(body.p_photo_id), title: String(body.p_title), description: String(body.p_description), price: Number(body.p_price), published: Boolean(body.p_published), previewPath: String(body.p_preview_path), originalPath: String(body.p_original_path), revision: 1, createdAt: time })
      await json(snapshot(id))
    } else if (path === '/rest/v1/rpc/get_shop_photo_download') {
      if (!id || body.p_expected_user_id !== id) { await fail('ACCOUNT_USER_CHANGED', 403, '42501'); return }
      const selected = server.photos.find(photo => photo.id === body.p_photo_id)
      if (!selected || !(server.roles[id] || server.purchases[id]?.[selected.id])) { await fail('SHOP_PURCHASE_REQUIRED', 403, '42501'); return }
      await json({ originalPath: selected.originalPath, fileName: `${selected.title}.png` })
    } else if (path.startsWith('/storage/v1/object/public/photo-previews/')) {
      const objectPath = path.slice('/storage/v1/object/public/'.length)
      const uploaded = server.uploads.find(upload => upload.path === `/storage/v1/object/${objectPath}`)
      await route.fulfill({ status: 200, contentType: uploaded?.type ?? 'image/png', body: uploaded?.bytes ?? server.previewImage, headers: { 'access-control-allow-origin': '*' } })
    }
    else if (path.startsWith('/storage/v1/object/photo-originals/') && request.method() === 'GET') {
      const objectPath = path.slice('/storage/v1/object/photo-originals/'.length)
      const selected = server.photos.find(photo => photo.originalPath === objectPath)
      if (!id || !selected || !(server.roles[id] || server.purchases[id]?.[selected.id])) { await fail('SHOP_PURCHASE_REQUIRED', 403, '42501'); return }
      server.originalRequests.push({ user: id, path: objectPath })
      await route.fulfill({ status: 200, contentType: 'image/png', body: image, headers: { 'access-control-allow-origin': '*' } })
    } else if (path.startsWith('/storage/v1/object/') && request.method() === 'POST') {
      if (!id || !server.roles[id]) { await fail('SHOP_ADMIN_REQUIRED', 403, '42501'); return }
      const form = await new Response(request.postDataBuffer(), { headers: { 'content-type': request.headers()['content-type'] } }).formData()
      const uploaded = Array.from(form.values()).find(value => typeof value !== 'string')
      if (!uploaded || typeof uploaded === 'string') throw new Error('Fixture expected an uploaded image file')
      server.uploads.push({ user: id, path, type: uploaded.type, bytes: Buffer.from(await uploaded.arrayBuffer()) })
      await json({ Key: path.slice('/storage/v1/object/'.length), Id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' })
    } else if (path.startsWith('/storage/v1/object/') && request.method() === 'DELETE') await json([])
    else await fail(`Unhandled fixture endpoint ${path}`, 500)
  })
  return server
}

async function login(page: Page, email = 'alice@example.test') {
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: 'メールアドレス', exact: true }).fill(email)
  await dialog.getByLabel('パスワード', { exact: true }).fill(password)
  await dialog.getByRole('button', { name: 'ログインする', exact: true }).click()
  await expect(page.getByRole('button', { name: email.startsWith('developer') ? 'Developerのアカウント' : 'Aliceのアカウント', exact: true })).toBeVisible()
}
async function logout(page: Page, name = 'Alice') {
  await page.getByRole('button', { name: `${name}のアカウント`, exact: true }).click()
  await page.getByRole('menuitem', { name: 'ログアウト', exact: true }).click()
  await expect(page.getByRole('button', { name: 'ログイン', exact: true })).toBeVisible({ timeout: 15000 })
}
async function openShop(page: Page) { await page.getByRole('button', { name: '写真ショップ', exact: true }).click() }

async function largeFixtureImage(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1280; canvas.height = 960
    const context = canvas.getContext('2d')!
    const gradient = context.createLinearGradient(0, 0, 1280, 960)
    gradient.addColorStop(0, '#98ba72'); gradient.addColorStop(1, '#f7b25d')
    context.fillStyle = gradient; context.fillRect(0, 0, 1280, 960)
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'))
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  })
  return Buffer.from(bytes)
}

test('guests can browse previews and cannot access developer controls', async ({ page }) => {
  const server = await backend(page)
  await page.goto('/')
  await openShop(page)
  await expect(page.getByRole('heading', { name: '朝の海', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '写真の管理', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'ログインして購入', exact: true })).toBeVisible()
  expect(server.purchaseRequests).toHaveLength(0)
  expect(server.originalRequests).toHaveLength(0)
  await page.getByRole('button', { name: 'ログインして購入', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'メールアドレス', exact: true })).toBeVisible()
})

test('a normal user buys once and keeps private downloads after logout and archive', async ({ page }) => {
  const server = await backend(page)
  await page.goto('/')
  await login(page)
  await expect(page.getByRole('button', { name: '写真の管理', exact: true })).toHaveCount(0)
  await openShop(page)
  await expect(page.getByRole('heading', { name: '朝の海', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '写真の管理', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '写真を見る', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: /で購入する$/ }).click()
  await expect(page.getByRole('button', { name: 'ダウンロード', exact: true })).toBeVisible()
  expect(Object.values(server.purchases[alice])).toHaveLength(1)
  expect(server.rows[alice].state.account.balance).toBe(1_005_000)
  const download = page.waitForEvent('download')
  await page.getByRole('dialog').getByRole('button', { name: '原本をダウンロード', exact: true }).click()
  const downloaded = await download
  expect(downloaded.suggestedFilename()).toBe('朝の海.png')
  const downloadedPath = await downloaded.path()
  expect(downloadedPath).not.toBeNull()
  expect((await readFile(downloadedPath!)).equals(await readFile('public/icons/mango-fx-192.png'))).toBe(true)
  expect(server.originalRequests).toEqual([{ user: alice, path: `${photoId}/original.png` }])
  await page.getByRole('button', { name: '写真の詳細を閉じる', exact: true }).click()
  await expect(page.locator('.photo-wallet-main strong')).toHaveText('3,000 仮想円')
  server.photos[0].published = false
  server.photos[0].price = 3000
  await logout(page)
  await login(page)
  await openShop(page)
  await expect(page.getByRole('button', { name: 'ダウンロード', exact: true })).toBeVisible()
  expect(server.purchases[alice][photoId].price).toBe(2000)
  expect(server.purchaseRequests).toHaveLength(1)
})

test('price changes and a newly insufficient balance do not grant a purchase', async ({ page }) => {
  const server = await backend(page)
  await page.goto('/')
  await login(page)
  await openShop(page)
  await page.getByRole('button', { name: '写真を見る', exact: true }).click()
  server.photos[0].price = 2500
  await page.getByRole('dialog').getByRole('button', { name: /で購入する$/ }).click()
  await expect(page.getByRole('alert')).toContainText('価格が変更')
  expect(server.purchases[alice]).toBeUndefined()
  await page.getByRole('button', { name: '写真を見る', exact: true }).click()
  server.rows[alice].state.account.balance = 1_000_000
  await page.getByRole('dialog').getByRole('button', { name: /で購入する$/ }).click()
  await expect(page.getByRole('alert')).toContainText('利益が足りません')
  expect(server.purchases[alice]).toBeUndefined()
  expect(server.originalRequests).toHaveLength(0)
})

test('a developer uploads original and preview, then changes price and publication', async ({ page }) => {
  const server = await backend(page)
  await page.goto('/')
  await login(page, 'developer@example.test')
  await page.getByRole('button', { name: '写真の管理', exact: true }).click()
  const original = await largeFixtureImage(page)
  await page.getByLabel('投稿する写真', { exact: true }).setInputFiles({ name: 'large-landscape.png', mimeType: 'image/png', buffer: original })
  await page.getByLabel('タイトル', { exact: true }).fill('新しい風景')
  await page.getByLabel('写真の説明', { exact: true }).fill('撮影した風景の写真。')
  await page.getByLabel('価格（仮想円）', { exact: true }).fill('1500')
  await page.getByRole('button', { name: '写真を投稿する', exact: true }).click()
  await expect(page.getByRole('heading', { name: '新しい風景', exact: true })).toBeVisible()
  expect(server.uploads).toHaveLength(2)
  expect(server.uploads.every(upload => upload.user === developer)).toBe(true)
  expect(server.uploads.map(upload => upload.type)).toEqual(['image/png', 'image/jpeg'])
  expect(server.uploads[0].bytes.equals(original)).toBe(true)
  const previewSize = await page.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }))
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  }, Array.from(server.uploads[1].bytes))
  expect(Math.max(previewSize.width, previewSize.height)).toBe(960)
  expect(previewSize.width / previewSize.height).toBeCloseTo(4 / 3)
  const created = server.photos.find(photo => photo.title === '新しい風景')!
  expect(created.originalPath).toMatch(/^[0-9a-f-]+\/original\.png$/)
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: '新しい風景', exact: true }) })
  await card.getByRole('button', { name: '編集する', exact: true }).click()
  await page.getByLabel('価格（仮想円）', { exact: true }).fill('1750')
  await page.getByLabel('ショップに公開する', { exact: true }).uncheck()
  await page.getByRole('button', { name: '変更を保存する', exact: true }).click()
  await expect(page.locator('.photo-success')).toContainText('写真の設定を保存しました。')
  expect(created.price).toBe(1750)
  expect(created.published).toBe(false)
  expect(created.revision).toBe(2)
  expect(server.uploads).toHaveLength(2)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: '.local/photo-shop-admin.png', fullPage: true })
})

test('mobile shop works in both palettes and missing setup stays closed to purchases', async ({ page }) => {
  const server = await backend(page)
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto('/')
  await page.getByRole('button', { name: 'メニューを開く', exact: true }).click()
  await openShop(page)
  await expect(page.getByRole('heading', { name: '朝の海', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  await page.getByRole('button', { name: /^表示モード（/ }).click()
  await page.getByRole('button', { name: 'ダーク', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  await page.screenshot({ path: '.local/photo-shop-mobile-dark.png', fullPage: true })
  server.setupMissing = true
  await page.getByRole('button', { name: '更新', exact: true }).click()
  await expect(page.getByText(/写真ショップは準備中/)).toBeVisible()
  await expect(page.getByRole('button', { name: '写真を見る', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '写真の管理', exact: true })).toHaveCount(0)
  expect(server.purchaseRequests).toHaveLength(0)
})

test.describe('touch preview interaction', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('previews use reduced canvases and suppress save/drag events while the shop stays usable', async ({ page }) => {
    const server = await backend(page)
    await page.goto('/')
    server.previewImage = await largeFixtureImage(page)
    await page.getByRole('button', { name: 'メニューを開く', exact: true }).click()
    await openShop(page)
    const card = page.locator('.photo-preview-button .protected-photo-preview')
    await card.scrollIntoViewIfNeeded()
    await expect(card).toHaveAttribute('data-preview-status', 'ready')
    await expect(page.locator('.photo-preview-button img')).toHaveCount(0)
    expect(await card.locator('canvas').evaluate(canvas => Math.max((canvas as HTMLCanvasElement).width, (canvas as HTMLCanvasElement).height))).toBe(960)
    expect(await card.locator('canvas').evaluate(async (element, sourceUrl) => {
      const surface = element as HTMLCanvasElement
      const source = await createImageBitmap(await fetch(sourceUrl).then(response => response.blob()))
      const reference = document.createElement('canvas')
      reference.width = surface.width; reference.height = surface.height
      const referenceContext = reference.getContext('2d')!
      referenceContext.drawImage(source, 0, 0, reference.width, reference.height)
      const expected = referenceContext.getImageData(0, 0, reference.width, reference.height).data
      const actual = surface.getContext('2d')!.getImageData(0, 0, surface.width, surface.height).data
      source.close()
      reference.width = 0; reference.height = 0
      return actual.every((channel, index) => Math.abs(channel - expected[index]) <= 1)
    }, `https://testproject.supabase.co/storage/v1/object/public/photo-previews/${photoId}/preview.jpg`)).toBe(true)
    const checkSuppression = async (target: typeof card) => {
      expect(await target.evaluate(element => {
        const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
        const drag = new DragEvent('dragstart', { bubbles: true, cancelable: true })
        return { menuCancelled: !element.dispatchEvent(menu), dragCancelled: !element.dispatchEvent(drag), userSelect: getComputedStyle(element).userSelect }
      })).toEqual({ menuCancelled: true, dragCancelled: true, userSelect: 'none' })
    }
    await checkSuppression(card)
    const box = await card.boundingBox()
    await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2)
    const dialog = page.getByRole('dialog', { name: '朝の海', exact: true })
    await expect(dialog).toBeVisible()
    const detail = dialog.locator('.protected-photo-preview')
    await expect(detail).toHaveAttribute('data-preview-status', 'ready')
    await expect(dialog.locator('img')).toHaveCount(0)
    await checkSuppression(detail)
    await page.screenshot({ path: '.local/photo-shop-protected-preview-mobile.png' })
    await dialog.getByRole('button', { name: '写真の詳細を閉じる', exact: true }).tap()
    await expect(dialog).toHaveCount(0)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.getByRole('button', { name: '更新', exact: true }).tap()
    await expect(page.getByRole('heading', { name: '朝の海', exact: true })).toBeVisible()
    expect(server.originalRequests).toHaveLength(0)
    expect(server.purchaseRequests).toHaveLength(0)
  })
})
