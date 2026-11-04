import { createHash } from 'node:crypto'
import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import { createSavedState } from '../src/lib/practiceState'

// All identities and credentials in this file are synthetic local fixtures.
// The actual Google provider is never contacted and no real account is created.
const userId = '44444444-4444-4444-8444-444444444444'
const appUrl = 'http://127.0.0.1:5175/'
const fixtureProject = 'https://testproject.supabase.co'
const user = {
  id: userId, aud: 'authenticated', role: 'authenticated',
  email: 'google-fixture@example.test',
  user_metadata: { display_name: 'Google Fixture' },
  app_metadata: { provider: 'google', providers: ['google'] },
  identities: [{ id: 'fixture-google-identity', user_id: userId, provider: 'google', identity_data: { sub: 'fixture-google-subject' } }],
  created_at: '2026-01-01T00:00:00Z',
}
function fixtureSession() {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const now = Math.floor(Date.now()/1000)
  const access_token = `${part({alg:'HS256',typ:'JWT'})}.${part({sub:userId,aud:'authenticated',role:'authenticated',iat:now,exp:now+3600})}.fixture-signature`
  return {access_token,token_type:'bearer',expires_in:3600,expires_at:now+3600,refresh_token:'fixture-google-refresh-token',user}
}
function requestUser(route: Route) {
  try { return JSON.parse(Buffer.from(route.request().headers().authorization.split(' ')[1].split('.')[1],'base64url').toString()).sub as string }
  catch { return null }
}
type CallbackMode = 'success' | 'expired' | 'provider-error' | 'provider-denied'
async function callbackBackend(page: Page, mode: CallbackMode) {
  const state = createSavedState(); state.account.balance = 1_543_210; state.paused = true
  const server = { authorizeUrl:'',tokenBodies:[] as Record<string,unknown>[],cloudReads:0,cloudWrites:0,externalRequests:[] as string[] }
  await page.context().route('https://**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin !== fixtureProject) {
      server.externalRequests.push(url.origin)
      await route.abort('blockedbyclient')
      return
    }
    const headers = {'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET,POST,PUT,OPTIONS','x-supabase-api-version':'2024-01-01','access-control-expose-headers':'x-supabase-api-version'}
    const json = (body:unknown,status=200) => route.fulfill({status,headers,contentType:'application/json',body:JSON.stringify(body)})
    if (request.method()==='OPTIONS') { await route.fulfill({status:204,headers}); return }
    let body:Record<string,unknown>={}
    try { body=request.postDataJSON() || {} } catch { /* GET or no request body */ }
    if(url.pathname==='/auth/v1/authorize') {
      server.authorizeUrl = url.href
      const target = new URL(url.searchParams.get('redirect_to') || appUrl)
      // Emulate Supabase's redirect after Google, without any Google request.
      if(mode==='provider-error') {
        target.searchParams.set('error','server_error')
        target.searchParams.set('error_code','unexpected_failure')
        target.searchParams.set('error_description','Unable to exchange external code: oauth2: invalid_client')
      } else if(mode==='provider-denied') {
        target.searchParams.set('error','access_denied')
        target.searchParams.set('error_code','access_denied')
        target.searchParams.set('error_description','The user denied access to this provider')
      } else target.searchParams.set('code',mode==='expired'?'fixture_expired_code':'fixture_valid_code')
      await route.fulfill({status:302,headers:{...headers,location:target.href}})
    } else if(url.pathname==='/auth/v1/token' && url.searchParams.get('grant_type')==='pkce') {
      server.tokenBodies.push(body)
      if(mode==='expired') await json({code:'flow_state_expired',msg:'invalid flow state, no valid flow state found'},400)
      else await json(fixtureSession())
    } else if(url.pathname==='/auth/v1/user') {
      if(requestUser(route)===userId) await json(user)
      else await json({code:'bad_jwt',msg:'Invalid token'},401)
    } else if(url.pathname==='/rest/v1/practice_accounts') {
      server.cloudReads += 1
      if(requestUser(route)!==userId || url.searchParams.get('user_id')!==`eq.${userId}`) {
        await json({code:'42501',message:'fixture owner mismatch'},403); return
      }
      await json([{state,revision:7,updated_at:'2026-11-02T00:00:00Z'}])
    } else if(url.pathname==='/rest/v1/rpc/save_practice_account') {
      server.cloudWrites += 1
      await json({code:'P0001',message:'No writes expected in callback fixture'},400)
    } else await json({message:`Unhandled fixture endpoint: ${url.pathname}`},500)
  })
  return server
}
async function startGoogle(page:Page) {
  await page.goto('/')
  await page.getByRole('button',{name:'ログイン',exact:true}).click()
  await page.getByRole('dialog').getByRole('button',{name:'Googleでログイン',exact:true}).click()
}

test('Google PKCE roundtrip consumes the real SDK verifier, loads the owner account and cleans the URL',async({page})=>{
  const server=await callbackBackend(page,'success')
  const errors:string[]=[]
  page.on('pageerror',error=>errors.push(error.message))
  await startGoogle(page)
  await expect(page.getByRole('button',{name:'Google Fixtureのアカウント',exact:true})).toBeVisible({timeout:15000})
  await expect(page.locator('.stat-value').first()).toHaveText('¥1,543,210')
  expect(server.tokenBodies).toHaveLength(1)
  const authorize=new URL(server.authorizeUrl)
  expect(authorize.searchParams.get('provider')).toBe('google')
  expect(authorize.searchParams.get('redirect_to')).toBe(appUrl)
  expect(authorize.searchParams.get('code_challenge_method')).toBe('s256')
  const body=server.tokenBodies[0]
  expect(body.auth_code).toBe('fixture_valid_code')
  expect(typeof body.code_verifier).toBe('string')
  expect((body.code_verifier as string).length).toBeGreaterThanOrEqual(43)
  expect(createHash('sha256').update(body.code_verifier as string).digest('base64url')).toBe(authorize.searchParams.get('code_challenge'))
  await expect.poll(()=>new URL(page.url()).searchParams.has('code')).toBe(false)
  expect(server.cloudReads).toBeGreaterThan(0)
  expect(server.cloudWrites).toBe(0)
  expect(server.externalRequests).toEqual([])
  expect(errors).toEqual([])
  // A reload must use the saved session, not attempt to spend the code again.
  await page.reload()
  await expect(page.getByRole('button',{name:'Google Fixtureのアカウント',exact:true})).toBeVisible()
  await expect(page.locator('.stat-value').first()).toHaveText('¥1,543,210')
  expect(server.tokenBodies).toHaveLength(1)
})

test('an expired PKCE exchange stays signed out and never loads or overwrites an account',async({page})=>{
  const server=await callbackBackend(page,'expired')
  await startGoogle(page)
  const dialog=page.getByRole('dialog')
  await expect(dialog.getByRole('alert')).toBeVisible({timeout:15000})
  await expect(dialog.getByRole('alert')).toContainText('ログインの有効期限が切れたか、開始時の情報を確認できません')
  expect(server.tokenBodies).toHaveLength(1)
  await expect(page.getByRole('button',{name:'Google Fixtureのアカウント',exact:true})).not.toBeVisible()
  expect(server.cloudReads).toBe(0)
  expect(server.cloudWrites).toBe(0)
  expect(server.externalRequests).toEqual([])
})

test('a callback opened without its browser verifier explains the problem instead of silently ignoring the code',async({page})=>{
  const server=await callbackBackend(page,'success')
  await page.goto('/?code=fixture_missing_verifier_code')
  const dialog=page.getByRole('dialog')
  await expect(dialog.getByRole('alert')).toBeVisible({timeout:10000})
  await expect(dialog.getByRole('alert')).toContainText('同じブラウザでアプリを開き、ログインを最初からやり直してください')
  await expect.poll(()=>new URL(page.url()).searchParams.has('code')).toBe(false)
  expect(server.tokenBodies).toHaveLength(0)
  expect(server.cloudReads).toBe(0)
  expect(server.cloudWrites).toBe(0)
  expect(server.externalRequests).toEqual([])
})

test('a provider invalid_client callback reports an error and removes error parameters without exposing a session',async({page})=>{
  const server=await callbackBackend(page,'provider-error')
  await startGoogle(page)
  const dialog=page.getByRole('dialog')
  await expect(dialog.getByRole('alert')).toBeVisible({timeout:15000})
  await expect(dialog.getByRole('alert')).toContainText('連携設定の確認が必要です')
  await expect.poll(()=>new URL(page.url()).searchParams.has('error')).toBe(false)
  expect(server.tokenBodies).toHaveLength(0)
  expect(server.cloudReads).toBe(0)
  expect(server.cloudWrites).toBe(0)
  expect(server.externalRequests).toEqual([])
})


test('a user-denied Google redirect stays signed out and suggests restarting account selection',async({page})=>{
  const server=await callbackBackend(page,'provider-denied')
  await startGoogle(page)
  const dialog=page.getByRole('dialog')
  await expect(dialog.getByRole('alert')).toContainText('Googleログインが許可されませんでした', {timeout:15000})
  await expect.poll(()=>new URL(page.url()).searchParams.has('error')).toBe(false)
  expect(server.tokenBodies).toHaveLength(0)
  expect(server.cloudReads).toBe(0)
  expect(server.cloudWrites).toBe(0)
  expect(server.externalRequests).toEqual([])
})

test('a failed OAuth warning survives account hydration until dismissed and preserves the signed-in account',async({page})=>{
  const server=await callbackBackend(page,'success')
  await startGoogle(page)
  await expect(page.getByRole('button',{name:'Google Fixtureのアカウント',exact:true})).toBeVisible({timeout:15000})
  await expect(page.locator('.stat-value').first()).toHaveText('¥1,543,210')
  const failed=new URL(appUrl)
  failed.searchParams.set('error','server_error')
  failed.searchParams.set('error_code','unexpected_failure')
  failed.searchParams.set('error_description','Unable to exchange external code: oauth2: invalid_client')
  await page.goto(failed.href)
  // Only assert the warning after the scoped cloud account has fully hydrated.
  // A transient loading-screen dialog is not sufficient feedback to the user.
  await expect(page.locator('.stat-value').first()).toHaveText('¥1,543,210')
  expect(server.cloudReads).toBeGreaterThan(1)
  const dialog=page.getByRole('dialog')
  await expect(dialog.getByRole('alert')).toContainText('連携設定の確認が必要です')
  await expect.poll(()=>new URL(page.url()).searchParams.has('error')).toBe(false)
  await dialog.getByRole('button',{name:'アカウント画面を閉じる',exact:true}).click()
  await expect(dialog).not.toBeVisible()
  await page.reload()
  await expect(page.getByRole('button',{name:'Google Fixtureのアカウント',exact:true})).toBeVisible()
  await expect(page.locator('.stat-value').first()).toHaveText('¥1,543,210')
  await expect(page.getByRole('dialog')).not.toBeVisible()
  expect(server.tokenBodies).toHaveLength(1)
  expect(server.cloudWrites).toBe(0)
  expect(server.externalRequests).toEqual([])
})

test('a stale-code warning survives account hydration until dismissed and preserves the authenticated account',async({page})=>{
  const server=await callbackBackend(page,'success')
  await startGoogle(page)
  await expect(page.getByRole('button',{name:'Google Fixtureのアカウント',exact:true})).toBeVisible({timeout:15000})
  await page.goto('/?code=fixture_stale_code_without_verifier')
  await expect(page.locator('.stat-value').first()).toHaveText('¥1,543,210')
  expect(server.cloudReads).toBeGreaterThan(1)
  const dialog=page.getByRole('dialog')
  await expect(dialog.getByRole('alert')).toContainText('同じブラウザでアプリを開き、ログインを最初からやり直してください')
  await expect.poll(()=>new URL(page.url()).searchParams.has('code')).toBe(false)
  await dialog.getByRole('button',{name:'アカウント画面を閉じる',exact:true}).click()
  await expect(dialog).not.toBeVisible()
  await page.reload()
  await expect(page.getByRole('button',{name:'Google Fixtureのアカウント',exact:true})).toBeVisible()
  await expect(page.locator('.stat-value').first()).toHaveText('¥1,543,210')
  await expect(page.getByRole('dialog')).not.toBeVisible()
  expect(server.tokenBodies).toHaveLength(1)
  expect(server.cloudWrites).toBe(0)
  expect(server.externalRequests).toEqual([])
})
