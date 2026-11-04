import { test, expect, type Page, type Route } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createSavedState } from '../src/lib/practiceState'
const alice = '11111111-1111-4111-8111-111111111111'
const bob = '22222222-2222-4222-8222-222222222222'
const developer = '33333333-3333-4333-8333-333333333333'
const photoId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const fileId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const code = 'EXAMPLE-NOT-VALID-0000\nThis is test data, not a redeemable gift code.\n'
const stamp = '2026-11-04T00:00:00.000Z'
const users = Object.fromEntries([[alice, 'Alice'], [bob, 'Bob'], [developer, 'Developer']].map(([id, name]) => [id, {
    id, email: `${name.toLowerCase()}@example.test`, user_metadata: { display_name: name }, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email', providers: ['email'] }, created_at: stamp,
  }]))
type Product = {
  id: string
  title: string
  description: string
  price: number
  published: boolean
  kind: 'photo' | 'file'
  saleMode: 'direct' | 'lottery'
  fileType: 'txt' | 'pdf' | 'zip' | null
  previewPath: string | null
  originalPath: string
  revision: number
  createdAt: string
}
type Order = {
  id: string
  userId: string
  productId: string
  paidPrice: number
  status: 'pending' | 'approved' | 'rejected'
  purchasedAt: string
  reviewedAt: string | null
}
type PracticeRow = {
  state: ReturnType<typeof createSavedState>
  revision: number
  updated_at: string
}
const practice = (): PracticeRow => { const state = createSavedState(); state.account.balance = 1005000; state.paused = true; return { state, revision: 1, updated_at: stamp }; }
function session(id: string) {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return { access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: id, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: `fixture-${id}`, user: users[id] }
}
function uid(route: Route): string | null { try {
  return JSON.parse(Buffer.from(route.request().headers().authorization.split(' ')[1].split('.')[1], 'base64url').toString()).sub ?? null
}
catch {
  return null
} }
async function backend(page: Page) {
  const photoBytes = await readFile('public/icons/mango-fx-192.png')
  const server = {
    rows: { [alice]: practice(), [bob]: practice(), [developer]: practice() } as Record<string, PracticeRow>,
    products: [
      { id: photoId, title: '朝の海', description: '撮影した海の写真。', price: 2000, published: true, kind: 'photo', saleMode: 'direct', fileType: null, previewPath: `${photoId}/preview.jpg`, originalPath: `${photoId}/original.png`, revision: 1, createdAt: stamp },
      { id: fileId, title: 'サンプルコードファイル', description: '管理者の確認後に受け取るテスト用ファイル。', price: 500, published: true, kind: 'file', saleMode: 'direct', fileType: 'txt', previewPath: null, originalPath: `${fileId}/original.txt`, revision: 1, createdAt: stamp },
    ] as Product[],
    orders: [] as Order[], photoPurchases: {} as Record<string, Record<string, number>>,
    uploads: [] as {
      path: string
      type: string
      bytes: Buffer
    }[], downloads: [] as {
      user: string
      path: string
    }[],
    purchaseRequests: [] as {
      user: string
      product: string
    }[], reviewRequests: [] as {
      user: string
      order: string
      decision: string
    }[],
    publicFileRequests: [] as string[], fileApiMissing: false,
  }
  const role = (id: string | null) => id === developer ? 'developer' : null
  const active = (id: string) => server.orders.find(order => order.productId === id && order.status !== 'rejected')
  const snapshot = (id: string | null) => {
    const realizedProfit = id ? Math.max(0, Math.floor((server.rows[id]?.state.account.balance ?? 1000000) - 1000000)) : 0
    const spentProfit = id ? Object.values(server.photoPurchases[id] ?? {}).reduce((sum, n) => sum + n, 0) + server.orders.filter(order => order.userId === id && order.status !== 'rejected').reduce((sum, order) => sum + order.paidPrice, 0) : 0
    return { role: role(id), realizedProfit, spentProfit, availableProfit: Math.max(0, realizedProfit - spentProfit), photos: server.products.filter(product => product.published || role(id) || server.orders.some(order => order.userId === id && order.productId === product.id) || Boolean(id && server.photoPurchases[id]?.[product.id])).map(product => {
        const order = server.orders.filter(order => order.productId === product.id && order.userId === id).at(-1)
        const paid = id ? server.photoPurchases[id]?.[product.id] : undefined
        const { originalPath: _private, ...fields } = product
        return { ...fields, lottery: null, purchased: product.kind === 'photo' ? paid !== undefined : Boolean(order && order.status !== 'rejected'), paidPrice: product.kind === 'photo' ? paid ?? null : order?.paidPrice ?? null, purchasedAt: product.kind === 'photo' ? (paid !== undefined ? stamp : null) : order?.purchasedAt ?? null, stockRemaining: product.kind === 'photo' ? null : active(product.id) ? 0 : 1, deliveryStatus: product.kind === 'photo' ? (paid !== undefined ? 'approved' : 'not_purchased') : order?.status ?? 'not_purchased', orderId: product.kind === 'photo' ? null : order?.id ?? null, orderSource: product.kind === 'file' && order ? 'purchase' : null }
      }), orders: role(id) ? server.orders.map(order => ({ id: order.id, productId: order.productId, productTitle: server.products.find(p => p.id === order.productId)!.title, buyerLabel: users[order.userId]?.email ?? '削除済みアカウント', paidPrice: order.paidPrice, status: order.status, source: 'purchase', purchasedAt: order.purchasedAt, reviewedAt: order.reviewedAt })) : [] }
  }
  await page.context().route('https://testproject.supabase.co/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname, id = uid(route)
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } })
    const fail = (message: string, status = 400, code = 'P0001') => json({ message, code }, status)
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': '*' } })
      return
    }
    let body: Record<string, unknown> = {}
    try {
      body = request.postDataJSON() || {}
    }
    catch { /* binary file */ }
    if (path === '/auth/v1/token') {
      const found = Object.values(users).find(user => user.email === body.email)
      if (found && body.password === 'Fixture-password-123!')
        await json(session(found.id))
      else
        await fail('invalid_credentials', 400)
    }
    else if (path === '/auth/v1/user') {
      if (id && users[id])
        await json(users[id])
      else
        await fail('Invalid token', 401)
    }
    else if (path === '/auth/v1/logout')
      await route.fulfill({ status: 204 })
    else if (path === '/rest/v1/practice_accounts')
      await json(id && server.rows[id] ? [server.rows[id]] : [])
    else if (path === '/rest/v1/rpc/save_practice_account') {
      if (!id || body.p_expected_user_id !== id) {
        await fail('ACCOUNT_USER_CHANGED', 403, '42501')
        return
      }
      const previous = server.rows[id]
      if (previous ? body.p_expected_revision !== previous.revision : body.p_expected_revision !== null) {
        await fail('ACCOUNT_CONFLICT')
        return
      }
      server.rows[id] = { state: body.p_state as PracticeRow['state'], revision: (previous?.revision ?? 0) + 1, updated_at: stamp }
      await json([server.rows[id]])
    }
    else if (path === '/rest/v1/rpc/get_reward_shop') {
      if (server.fileApiMissing) {
        await fail('Function not found', 404, 'PGRST202')
        return
      }
      if ((body.p_expected_user_id ?? null) !== id)
        await fail('ACCOUNT_USER_CHANGED', 403, '42501')
      else
        await json(snapshot(id))
    }
    else if (path === '/rest/v1/rpc/get_photo_shop') {
      const data = snapshot(id)
      await json({ ...data, photos: data.photos.filter(p => p.kind === 'photo').map(({ kind: _kind, fileType: _type, deliveryStatus: _status, stockRemaining: _stock, orderId: _order, ...p }) => p) })
    }
    else if (path === '/rest/v1/rpc/purchase_shop_product') {
      if (!id || body.p_expected_user_id !== id) {
        await fail('ACCOUNT_USER_CHANGED', 403, '42501')
        return
      }
      const product = server.products.find(p => p.id === body.p_product_id)
      server.purchaseRequests.push({ user: id, product: String(body.p_product_id) })
      if (!product || !product.published) {
        await fail('SHOP_PHOTO_UNAVAILABLE')
        return
      }
      if (product.kind === 'photo' && server.photoPurchases[id]?.[product.id] !== undefined) {
        await json(snapshot(id))
        return
      }
      const held = active(product.id)
      if (product.kind === 'file' && held?.userId === id) {
        await json(snapshot(id))
        return
      }
      if (product.kind === 'file' && held) {
        await fail('SHOP_OUT_OF_STOCK')
        return
      }
      if (product.price !== body.p_expected_price) {
        await fail('SHOP_PRICE_CHANGED')
        return
      }
      if (snapshot(id).availableProfit < product.price) {
        await fail('SHOP_INSUFFICIENT_PROFIT')
        return
      }
      if (product.kind === 'photo') {
        server.photoPurchases[id] ??= {}
        server.photoPurchases[id][product.id] = product.price
      }
      else
        server.orders.push({ id: crypto.randomUUID(), userId: id, productId: product.id, paidPrice: product.price, status: 'pending', purchasedAt: new Date().toISOString(), reviewedAt: null })
      await json(snapshot(id))
    }
    else if (path === '/rest/v1/rpc/review_shop_order') {
      if (!id || id !== developer || body.p_expected_user_id !== id) {
        await fail('SHOP_ADMIN_REQUIRED', 403, '42501')
        return
      }
      const order = server.orders.find(order => order.id === body.p_order_id)
      if (!order) {
        await fail('SHOP_ORDER_NOT_FOUND')
        return
      }
      const status = body.p_decision === 'approve' ? 'approved' : 'rejected'
      if (order.status !== 'pending' && order.status !== status) {
        await fail('SHOP_ORDER_CONFLICT')
        return
      }
      server.reviewRequests.push({ user: id, order: order.id, decision: String(body.p_decision) })
      order.status = status
      order.reviewedAt = new Date().toISOString()
      await json(snapshot(id))
    }
    else if (path === '/rest/v1/rpc/save_shop_product') {
      if (!id || id !== developer || body.p_expected_user_id !== id) {
        await fail('SHOP_ADMIN_REQUIRED', 403, '42501')
        return
      }
      const product = server.products.find(p => p.id === body.p_product_id)
      if (product) {
        if (body.p_expected_revision !== product.revision) {
          await fail('SHOP_PHOTO_CONFLICT')
          return
        }
        Object.assign(product, { title: body.p_title, description: body.p_description, price: body.p_price, published: body.p_published, revision: product.revision + 1 })
      }
      else
        server.products.unshift({ id: String(body.p_product_id), title: String(body.p_title), description: String(body.p_description), price: Number(body.p_price), published: Boolean(body.p_published), kind: body.p_kind as Product['kind'], saleMode: 'direct', fileType: body.p_kind === 'file' ? body.p_file_ext as Product['fileType'] : null, previewPath: body.p_kind === 'file' ? null : String(body.p_preview_path), originalPath: String(body.p_original_path), revision: 1, createdAt: new Date().toISOString() })
      await json(snapshot(id))
    }
    else if (path === '/rest/v1/rpc/get_shop_product_download') {
      if (!id || body.p_expected_user_id !== id) {
        await fail('ACCOUNT_USER_CHANGED', 403, '42501')
        return
      }
      const product = server.products.find(p => p.id === body.p_product_id)
      const owned = product?.kind === 'photo' ? Boolean(server.photoPurchases[id]?.[product.id] !== undefined) : server.orders.some(order => order.productId === product?.id && order.userId === id && order.status === 'approved')
      if (!product || !(role(id) || owned)) {
        await fail('SHOP_PURCHASE_REQUIRED', 403, '42501')
        return
      }
      const ext = product.originalPath.split('.').at(-1)
      await json({ bucket: product.kind === 'photo' ? 'photo-originals' : 'shop-files', originalPath: product.originalPath, fileName: `${product.title}.${ext}` })
    }
    else if (path.startsWith('/storage/v1/object/public/photo-previews/'))
      await route.fulfill({ status: 200, contentType: 'image/png', body: photoBytes, headers: { 'access-control-allow-origin': '*' } })
    else if (path.startsWith('/storage/v1/object/public/shop-files/')) {
      server.publicFileRequests.push(path)
      await fail('Private bucket', 403, '42501')
    }
    else if (path.startsWith('/storage/v1/object/') && request.method() === 'GET') {
      const bucket = path.split('/')[4], objectPath = path.split('/').slice(5).join('/'), product = server.products.find(p => p.originalPath === objectPath)
      const owned = id && product && (product.kind === 'photo' ? server.photoPurchases[id]?.[product.id] !== undefined : server.orders.some(order => order.productId === product.id && order.userId === id && order.status === 'approved'))
      if (!id || !product || !(role(id) || owned)) {
        await fail('SHOP_PURCHASE_REQUIRED', 403, '42501')
        return
      }
      server.downloads.push({ user: id, path })
      const uploaded = server.uploads.find(upload => upload.path === path)
      await route.fulfill({ status: 200, contentType: bucket === 'shop-files' ? 'text/plain' : 'image/png', body: uploaded?.bytes ?? (bucket === 'shop-files' ? Buffer.from(code) : photoBytes), headers: { 'access-control-allow-origin': '*' } })
    }
    else if (path.startsWith('/storage/v1/object/') && request.method() === 'POST') {
      if (id !== developer) {
        await fail('SHOP_ADMIN_REQUIRED', 403, '42501')
        return
      }
      const form = await new Response(request.postDataBuffer(), { headers: { 'content-type': request.headers()['content-type'] } }).formData(), file = Array.from(form.values()).find(value => typeof value !== 'string')
      if (!file || typeof file === 'string')
        throw new Error('Missing uploaded file')
      server.uploads.push({ path, type: file.type, bytes: Buffer.from(await file.arrayBuffer()) })
      await json({ Key: path.slice('/storage/v1/object/'.length), Id: crypto.randomUUID() })
    }
    else if (path.startsWith('/storage/v1/object/') && request.method() === 'DELETE')
      await json([])
    else
      await fail(`Unhandled fixture endpoint ${path}`, 500)
  })
  return server
}
async function login(page: Page, id = alice) { await page.getByRole('button', { name: 'ログイン', exact: true }).click(); const dialog = page.getByRole('dialog'); await dialog.getByRole('textbox', { name: 'メールアドレス', exact: true }).fill(users[id].email); await dialog.getByLabel('パスワード', { exact: true }).fill('Fixture-password-123!'); await dialog.getByRole('button', { name: 'ログインする', exact: true }).click(); await expect(page.getByRole('button', { name: `${users[id].user_metadata.display_name}のアカウント`, exact: true })).toBeVisible(); }
async function logout(page: Page, id = alice) { await page.getByRole('button', { name: `${users[id].user_metadata.display_name}のアカウント`, exact: true }).click(); await page.getByRole('menuitem', { name: 'ログアウト', exact: true }).click(); await expect(page.getByRole('button', { name: 'ログイン', exact: true })).toBeVisible({ timeout: 15000 }); }
async function openShop(page: Page) { await page.getByRole('button', { name: 'ショップ', exact: true }).click(); }
function card(page: Page, title = 'サンプルコードファイル') { return page.locator('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) }); }
test('the renamed shop omits the old introduction and never previews code-file contents', async ({ page }) => {
  const server = await backend(page)
  await page.goto('/')
  await openShop(page)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('練習の成果を、ごほうびに。')
  await expect(page.getByText('THE MANGO COLLECTION', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '練習の先に、お気に入りの一枚を。', exact: true })).toHaveCount(0)
  await expect(card(page)).toBeVisible()
  await expect(card(page).locator('img,canvas')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(code.trim())
  expect(server.downloads).toHaveLength(0)
  expect(server.publicFileRequests).toHaveLength(0)
})
test('a file purchase reserves one item and only approval permits its original download', async ({ page }) => {
  const server = await backend(page)
  await page.goto('/')
  await login(page)
  await openShop(page)
  await card(page).getByRole('button', { name: '商品を見る', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: /で購入を申請する$/ }).click()
  await expect(page.getByRole('dialog')).toContainText('確認待ち')
  await expect(page.getByRole('dialog').getByRole('button', { name: /ダウンロード/ })).toHaveCount(0)
  await expect(page.locator('.photo-wallet-main strong')).toHaveText('4,500 仮想円')
  expect(server.orders).toHaveLength(1)
  expect(server.orders[0].status).toBe('pending')
  expect(server.downloads).toHaveLength(0)
  await page.keyboard.press('Escape')
  await logout(page)
  await login(page, bob)
  await openShop(page)
  await expect(card(page)).toContainText(/売り切れ|受付終了|在庫なし/)
  await expect(card(page).getByRole('button', { name: /申請する$/ })).toHaveCount(0)
  await logout(page, bob)
  await login(page, developer)
  await page.getByRole('button', { name: 'ショップ管理', exact: true }).click()
  const order = page.locator('.shop-order-list > li').filter({ hasText: 'alice@example.test' })
  await order.getByRole('button', { name: '承認して渡す', exact: true }).click()
  await order.getByRole('button', { name: '承認を確定', exact: true }).click()
  await expect.poll(() => server.orders[0].status).toBe('approved')
  await logout(page, developer)
  await login(page)
  await openShop(page)
  const download = page.waitForEvent('download')
  await card(page).getByRole('button', { name: 'ダウンロード', exact: true }).click()
  const saved = await download
  expect(await readFile((await saved.path())!, 'utf8')).toBe(code)
  expect(server.downloads).toHaveLength(1)
  expect(server.downloads[0].user).toBe(alice)
  expect(server.purchaseRequests).toHaveLength(1)
})
test('rejecting a pending file order refunds its credit and makes the item available again', async ({ page }) => {
  const server = await backend(page)
  await page.goto('/')
  await login(page)
  await openShop(page)
  await card(page).getByRole('button', { name: '商品を見る', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: /で購入を申請する$/ }).click()
  await page.keyboard.press('Escape')
  await logout(page)
  await login(page, developer)
  await page.getByRole('button', { name: 'ショップ管理', exact: true }).click()
  const order = page.locator('.shop-order-list > li').filter({ hasText: 'alice@example.test' })
  await order.getByRole('button', { name: '却下して戻す', exact: true }).click()
  await order.getByRole('button', { name: '却下を確定', exact: true }).click()
  await expect.poll(() => server.orders[0].status).toBe('rejected')
  await logout(page, developer)
  await login(page)
  await openShop(page)
  await expect(page.locator('.photo-wallet-main strong')).toHaveText('5,000 仮想円')
  await expect(card(page)).toContainText(/却下|見送り|戻し/)
  await card(page).getByRole('button', { name: '商品を見る', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: /で購入を申請する$/ }).click()
  await expect.poll(() => server.orders.length).toBe(2)
  expect(server.orders[1].status).toBe('pending')
  expect(server.downloads).toHaveLength(0)
})
test('a developer uploads code data only to private file storage', async ({ page }) => {
  const server = await backend(page)
  await page.goto('/')
  await login(page, developer)
  await page.getByRole('button', { name: 'ショップ管理', exact: true }).click()
  await page.getByRole('combobox', { name: '商品の種類', exact: true }).selectOption('file')
  await page.getByLabel('販売するファイル', { exact: true }).setInputFiles({ name: 'sample-code.txt', mimeType: 'text/plain', buffer: Buffer.from(code) })
  await page.getByLabel('タイトル', { exact: true }).fill('確認後に渡すファイル')
  await page.getByLabel('商品の説明', { exact: true }).fill('テスト用の商品です。')
  await page.getByLabel('価格（仮想円）', { exact: true }).fill('700')
  await page.getByRole('button', { name: '商品を登録する', exact: true }).click()
  await expect(page.getByRole('heading', { name: '確認後に渡すファイル', exact: true })).toBeVisible()
  expect(server.uploads).toHaveLength(1)
  expect(server.uploads[0].path).toMatch(/\/shop-files\/[0-9a-f-]+\/original\.txt$/)
  expect(server.uploads[0].bytes.toString()).toBe(code)
  const product = server.products.find(p => p.title === '確認後に渡すファイル')!
  expect(product.previewPath).toBeNull()
  expect(product.kind).toBe('file')
  await expect(page.locator('body')).not.toContainText(code.trim())
  await page.screenshot({ path: '.local/shop-files-admin.png', fullPage: true })
})
test('files remain private and usable on a narrow screen in both display modes', async ({ page }) => {
  const server = await backend(page)
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto('/')
  await page.getByRole('button', { name: 'メニューを開く', exact: true }).click()
  await openShop(page)
  await expect(card(page)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  await page.getByRole('button', { name: /^表示モード（/ }).click()
  await page.getByRole('button', { name: 'ダーク', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  expect(server.downloads).toHaveLength(0)
  expect(server.publicFileRequests).toHaveLength(0)
  await page.screenshot({ path: '.local/shop-files-mobile.png', fullPage: true })
})
