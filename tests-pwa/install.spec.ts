import { ACCOUNT_CONFIG } from '../src/config/accountConfig'
import { test as base, expect, chromium } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page, BrowserContext } from '@playwright/test'

// Installation checks require a normal browser profile: Playwright's default
// isolated contexts are incognito, where Chromium intentionally disallows PWAs.
const test = base.extend<{ installableContext: BrowserContext }>({
  installableContext: async ({}, use) => {
    const profile = await mkdtemp(join(tmpdir(),'mango-pwa-profile-'))
    const context = await chromium.launchPersistentContext(profile, { headless:true, executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage'] })
    try { await use(context) }
    finally { await context.close(); await rm(profile,{recursive:true,force:true}) }
  },
})

async function ready(page: Page, path = '/') {
  await page.goto(path)
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 15000 }).toBe(true)
  await expect(page.locator('.pwa-status')).toHaveAttribute('title', /保存が完了/)
}
async function pause(page: Page) {
  const pauseButton = page.getByRole('button', { name: '相場を一時停止', exact:true })
  if (await pauseButton.isVisible()) await pauseButton.click()
}

test('manifest, icons and Chromium installability requirements', async ({ installableContext: context }) => {
  const page = await context.newPage()
  await ready(page)
  const client = await context.newCDPSession(page)
  const manifest = await client.send('Page.getAppManifest')
  expect(manifest.errors.filter(error=>error.critical)).toEqual([])
  const data = JSON.parse(manifest.data!)
  expect(data.display).toBe('standalone')
  expect(data.start_url).toBe('./')
  expect(data.icons).toEqual(expect.arrayContaining([expect.objectContaining({ sizes:'192x192',type:'image/png' }),expect.objectContaining({sizes:'512x512',type:'image/png'})]))
  const installability = await client.send('Page.getInstallabilityErrors')
  expect(installability.installabilityErrors).toEqual([])
})

test('offline launch, market trade, close and persisted history', async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror',error=>errors.push(error.message))
  await ready(page)
  await pause(page)
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading',{name:'リスクの前に、経験を。'})).toBeVisible()
  await expect(page.locator('.pwa-status')).toContainText('オフライン')
  await page.getByRole('button',{name:'買い注文を出す',exact:true}).click()
  await page.getByRole('button',{name:'USD / JPYの買い建玉を決済',exact:true}).click()
  await page.getByRole('tab',{name:/取引履歴/}).click()
  await expect(page.getByRole('region',{name:'取引管理'}).getByRole('cell',{name:'−¥30',exact:true})).toBeVisible()
  await page.reload()
  await page.getByRole('tab',{name:/取引履歴/}).click()
  await expect(page.getByRole('region',{name:'取引管理'}).getByRole('cell',{name:'−¥30',exact:true})).toBeVisible()
  expect(errors).toEqual([])
})

test('subdirectory deployment caches and launches within its own scope', async ({ installableContext: context }) => {
  const page = await context.newPage()
  await ready(page,'/mango67A/')
  expect(await page.evaluate(async()=> (await navigator.serviceWorker.getRegistration())?.scope)).toBe('http://127.0.0.1:4174/mango67A/')
  const client = await context.newCDPSession(page)
  const result = await client.send('Page.getInstallabilityErrors')
  expect(result.installabilityErrors).toEqual([])
  await pause(page)
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('button',{name:'買い注文を出す',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'買い注文を出す',exact:true}).click()
  await expect(page.getByRole('button',{name:'USD / JPYの買い建玉を決済',exact:true})).toBeVisible()
})

test('update waits for consent and preserves account after activation', async ({ page, request }) => {
  await ready(page)
  await pause(page)
  await page.getByRole('button',{name:'買い注文を出す',exact:true}).click()
  const previousController = await page.evaluate(async()=> (await navigator.serviceWorker.getRegistration())?.active?.scriptURL)
  await request.post('/__test/advance-version')
  await page.evaluate(async()=> (await navigator.serviceWorker.getRegistration())?.update())
  await expect(page.getByRole('button',{name:'更新する',exact:true})).toBeVisible({timeout:15000})
  await expect(page.getByRole('button',{name:'USD / JPYの買い建玉を決済',exact:true})).toBeVisible()
  expect(await page.evaluate(async()=> (await navigator.serviceWorker.getRegistration())?.active?.scriptURL)).toBe(previousController)
  await page.getByRole('button',{name:'更新する',exact:true}).click()
  await expect(page.getByRole('button',{name:'更新する',exact:true})).not.toBeVisible({timeout:15000})
  await expect(page.getByRole('button',{name:'USD / JPYの買い建玉を決済',exact:true})).toBeVisible()
  await expect.poll(()=> page.evaluate(async()=> (await caches.keys()).filter(name=>name.startsWith('mango-fx-shell:/:')).length)).toBe(1)
})


test('account dialog exposes only email registration that is ready for users', async ({page})=>{
  await ready(page)
  await page.getByRole('button',{name:'ログイン',exact:true}).click()
  const dialog=page.getByRole('dialog')
  await expect(dialog.getByRole('button',{name:'Googleでログイン',exact:true})).toBeVisible()
  const signup=dialog.getByRole('button',{name:'新規登録',exact:true})
  if (ACCOUNT_CONFIG.emailRegistrationReady) {
    await expect(signup).toBeEnabled()
    await expect(dialog.getByRole('button',{name:'パスワードを忘れた方',exact:true})).toBeVisible()
  } else {
    await expect(signup).toBeDisabled()
    await expect(dialog.getByText('メールでの新規登録とパスワード再設定は準備中です。Googleでログインできます。',{exact:true})).toBeVisible()
    await expect(dialog.getByRole('button',{name:'パスワードを忘れた方',exact:true})).not.toBeVisible()
  }
})
