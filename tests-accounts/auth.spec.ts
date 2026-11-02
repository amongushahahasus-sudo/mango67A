import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import { createSavedState } from '../src/lib/practiceState'

const alice = '11111111-1111-4111-8111-111111111111'
const bob = '22222222-2222-4222-8222-222222222222'
const password = 'Fixture-password-123!'
const users = {
  [alice]: { id:alice,email:'alice@example.test',user_metadata:{display_name:'Alice'},aud:'authenticated',role:'authenticated',app_metadata:{provider:'email',providers:['email']},created_at:'2026-01-01T00:00:00Z' },
  [bob]: { id:bob,email:'bob@example.test',user_metadata:{display_name:'Bob'},aud:'authenticated',role:'authenticated',app_metadata:{provider:'email',providers:['email']},created_at:'2026-01-01T00:00:00Z' },
}
type Row = {state:ReturnType<typeof createSavedState>; revision:number;updated_at:string}
function snapshot(balance:number):Row {const state=createSavedState();state.account.balance=balance;state.paused=true;return {state,revision:1,updated_at:new Date().toISOString()}}
function token(id:string) {const part=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');return `${part({alg:'HS256',typ:'JWT'})}.${part({sub:id,aud:'authenticated',role:'authenticated',exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000)})}.fixture-signature`}
function session(id:keyof typeof users) {return {access_token:token(id),token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,refresh_token:`fixture-refresh-${id}`,user:users[id]}}
function uid(route:Route) {try{return JSON.parse(Buffer.from(route.request().headers().authorization!.split(' ')[1].split('.')[1],'base64url').toString()).sub as string}catch{return ''}}
async function backend(page:Page) {
  const rows:Record<string,Row> = {[alice]:snapshot(1_200_000),[bob]:snapshot(800_000)}
  const writes:{user:string;expected:string;revision:unknown}[]=[]
  const authRequests:{path:string;data:unknown}[]=[]
  const server={rows,writes,authRequests,offline:false,oauthUrl:'',saveDelayMs:0,signupFailure:false}
  await page.context().route('https://testproject.supabase.co/**',async route=>{
    if(server.offline){await route.abort('internetdisconnected');return}
    const request=route.request(),url=new URL(request.url()),path=url.pathname
    const json=async(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body),headers:{'access-control-allow-origin':'*'}})
    if(request.method()==='OPTIONS'){await route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-methods':'GET, POST, PUT, OPTIONS','access-control-allow-headers':'*'}});return}
    let body:Record<string,unknown>={}
    try{body=request.postDataJSON()||{}}catch{/* GET */}
    if(path.startsWith('/auth/v1/')) authRequests.push({path:path+url.search,data:body})
    if(path==='/auth/v1/token'){
      const id=body.email==='alice@example.test'?alice:body.email==='bob@example.test'?bob:null
      if(id&&body.password===password) await json(session(id))
      else await json({code:'invalid_credentials',msg:'Invalid login credentials'},400)
    } else if(path==='/auth/v1/user'){
      const id=uid(route) as keyof typeof users
      if(users[id])await json(users[id]);else await json({msg:'Invalid token'},401)
    } else if(path==='/auth/v1/logout')await route.fulfill({status:204})
    else if(path==='/auth/v1/signup'){
      if(server.signupFailure)await json({code:'unexpected_failure',msg:'Error sending confirmation email'},500)
      else await json({user:{id:'33333333-3333-4333-8333-333333333333',email:body.email,identities:[{provider:'email'}]},session:null})
    }
    else if(path==='/auth/v1/recover')await json({})
    else if(path==='/auth/v1/authorize'){server.oauthUrl=request.url();await route.fulfill({status:200,contentType:'text/html',body:'OAuth provider redirect intercepted by test fixture'})}
    else if(path==='/rest/v1/practice_accounts'){
      const id=uid(route),filter=url.searchParams.get('user_id')
      if(filter!==`eq.${id}`){await json({message:'owner filter mismatch',code:'42501'},403);return}
      await json(rows[id]?[rows[id]]:[])
    } else if(path==='/rest/v1/rpc/save_practice_account'){
      const id=uid(route),expected=body.p_expected_user_id as string
      writes.push({user:id,expected,revision:body.p_expected_revision})
      if(server.saveDelayMs) await new Promise(resolve=>setTimeout(resolve,server.saveDelayMs))
      if(id!==expected){await json({message:'ACCOUNT_USER_CHANGED',code:'42501'},403);return}
      const previous=rows[id]
      if(previous?body.p_expected_revision!==previous.revision:body.p_expected_revision!==null){await json({message:'ACCOUNT_CONFLICT',code:'P0001'},400);return}
      rows[id]={state:body.p_state as Row['state'],revision:(previous?.revision||0)+1,updated_at:new Date().toISOString()}
      await json([rows[id]])
    } else await json({message:`Unhandled mock endpoint ${path}`},500)
  })
  return server
}
async function login(page:Page,email:string) {
  await page.getByRole('button',{name:'ログイン',exact:true}).click()
  const dialog=page.getByRole('dialog')
  await dialog.getByRole('textbox',{name:'メールアドレス',exact:true}).fill(email)
  await dialog.getByLabel('パスワード',{exact:true}).fill(password)
  await dialog.getByRole('button',{name:'ログインする',exact:true}).click()
}
async function logout(page:Page,name:string) {
  await page.getByRole('button',{name:`${name}のアカウント`,exact:true}).click()
  await page.getByRole('menuitem',{name:'ログアウト',exact:true}).click()
  await expect(page.getByRole('button',{name:'ログイン',exact:true})).toBeVisible()
}

test('real SDK flow isolates Alice and Bob from guest data and from each other',async({page})=>{
  const server=await backend(page)
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button',{name:'相場を一時停止',exact:true}).click()
  await page.getByRole('button',{name:'買い注文を出す',exact:true}).click()
  await page.getByRole('button',{name:'USD / JPYの買い建玉を決済',exact:true}).click()
  await login(page,'alice@example.test')
  await expect(page.locator('.stat-value').first()).toHaveText('¥1,200,000')
  await page.getByRole('button',{name:'買い注文を出す',exact:true}).click()
  await expect.poll(()=>server.rows[alice].state.account.positions.length).toBe(1)
  await logout(page,'Alice')
  await expect(page.locator('.stat-value').first()).toHaveText('¥999,970')
  await login(page,'bob@example.test')
  await expect(page.locator('.stat-value').first()).toHaveText('¥800,000')
  await expect(page.getByRole('heading',{name:'まだ、ポジションはありません'})).toBeVisible()
  await logout(page,'Bob')
  await login(page,'alice@example.test')
  await expect(page.getByRole('button',{name:'USD / JPYの買い建玉を決済',exact:true})).toBeVisible()
  expect(server.writes.every(write=>write.user===write.expected)).toBe(true)
  expect(errors).toEqual([])
  const storage=await page.evaluate(()=>Object.values(localStorage).join(''))
  expect(storage).not.toContain(password)
})

test('registration confirmation, password validation, reset and Google redirect',async({page})=>{
  const server=await backend(page)
  await page.goto('/')
  await page.getByRole('button',{name:'ログイン',exact:true}).click()
  let dialog=page.getByRole('dialog')
  await dialog.getByRole('button',{name:'新規登録',exact:true}).click()
  await dialog.getByRole('textbox',{name:'メールアドレス',exact:true}).fill('new@example.test')
  await dialog.getByLabel('パスワード8文字以上',{exact:false}).fill('short')
  await dialog.getByLabel('パスワード（確認）',{exact:true}).fill('short')
  await dialog.getByRole('button',{name:'アカウントを作成',exact:true}).click()
  await expect(dialog.getByRole('alert')).toContainText('8文字以上')
  await dialog.locator('input[autocomplete="new-password"]').first().fill(password)
  await dialog.getByLabel('パスワード（確認）',{exact:true}).fill(password)
  await dialog.getByRole('button',{name:'アカウントを作成',exact:true}).click()
  await expect(dialog.getByRole('heading',{name:'メールをご確認ください'})).toBeVisible()
  expect(server.writes).toHaveLength(0)
  await dialog.getByRole('button',{name:'ログインに戻る',exact:true}).click()
  await dialog.getByRole('button',{name:'パスワードを忘れた方',exact:true}).click()
  await dialog.getByRole('textbox',{name:'メールアドレス',exact:true}).fill('new@example.test')
  await dialog.getByRole('button',{name:'再設定メールを送る',exact:true}).click()
  await expect(dialog.getByRole('heading',{name:'再設定メールをご確認ください'})).toBeVisible()
  await dialog.getByRole('button',{name:'アカウント画面を閉じる',exact:true}).click()
  await page.getByRole('button',{name:'ログイン',exact:true}).click()
  dialog=page.getByRole('dialog')
  await dialog.getByRole('button',{name:'Googleでログイン',exact:true}).click()
  await expect.poll(()=>server.oauthUrl).toContain('provider=google')
  expect(new URL(server.oauthUrl).searchParams.get('redirect_to')).toBe('http://127.0.0.1:5175/')
})

test('invalid credentials stay signed out and do not read cloud accounts',async({page})=>{
  const server=await backend(page)
  await page.goto('/')
  await page.getByRole('button',{name:'ログイン',exact:true}).click()
  const dialog=page.getByRole('dialog')
  await dialog.getByRole('textbox',{name:'メールアドレス',exact:true}).fill('alice@example.test')
  await dialog.getByLabel('パスワード',{exact:true}).fill('wrong-password')
  await dialog.getByRole('button',{name:'ログインする',exact:true}).click()
  await expect(dialog.getByRole('alert')).toContainText('メールアドレスまたはパスワード')
  await expect(page.getByRole('button',{name:'Aliceのアカウント',exact:true})).not.toBeVisible()
  expect(server.writes).toEqual([])
})


test('new accounts ask before importing existing guest practice',async({page})=>{
  const server=await backend(page)
  delete server.rows[alice]
  await page.goto('/')
  await page.getByRole('button',{name:'相場を一時停止',exact:true}).click()
  await page.getByRole('button',{name:'買い注文を出す',exact:true}).click()
  await page.getByRole('button',{name:'USD / JPYの買い建玉を決済',exact:true}).click()
  await login(page,'alice@example.test')
  await expect(page.getByRole('heading',{name:'最初の口座を選んでください'})).toBeVisible()
  expect(server.writes).toHaveLength(0)
  await page.getByRole('button',{name:'この端末の練習を引き継ぐ',exact:true}).click()
  await expect(page.locator('.stat-value').first()).toHaveText('¥999,970')
  await expect.poll(()=>server.rows[alice]?.state.account.history.length).toBe(1)
  await logout(page,'Alice')
  await expect(page.locator('.stat-value').first()).toHaveText('¥999,970')
})

test('conflicting cloud changes require a choice instead of silent overwriting',async({page})=>{
  const server=await backend(page)
  await page.goto('/')
  await login(page,'alice@example.test')
  await expect(page.locator('.stat-value').first()).toHaveText('¥1,200,000')
  server.rows[alice]=snapshot(900_000)
  server.rows[alice].revision=2
  await page.getByRole('button',{name:'買い注文を出す',exact:true}).click()
  await expect(page.getByRole('button',{name:'クラウドのデータを使う',exact:true})).toBeVisible()
  expect(server.rows[alice].state.account.balance).toBe(900_000)
  expect(server.rows[alice].state.account.positions).toHaveLength(0)
  await page.getByRole('button',{name:'クラウドのデータを使う',exact:true}).click()
  await expect(page.locator('.stat-value').first()).toHaveText('¥900,000')
  await expect(page.getByRole('heading',{name:'まだ、ポジションはありません'})).toBeVisible()
})

test('backend outage restores only scoped local data and later resumes syncing',async({page})=>{
  const server=await backend(page)
  await page.goto('/')
  await login(page,'alice@example.test')
  await expect(page.locator('.stat-value').first()).toHaveText('¥1,200,000')
  await expect.poll(()=>page.evaluate(()=>!!navigator.serviceWorker.controller)).toBe(true)
  server.offline=true
  await page.context().setOffline(true)
  await page.reload()
  await expect(page.locator('.stat-value').first()).toHaveText('¥1,200,000')
  await expect(page.getByText('オフラインで練習中です',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'買い注文を出す',exact:true}).click()
  expect(server.rows[alice].state.account.positions).toHaveLength(0)
  server.offline=false
  await page.context().setOffline(false)
  await expect.poll(()=>server.rows[alice].state.account.positions.length).toBe(1)
  expect(server.rows[bob].state.account.balance).toBe(800_000)
})

test('logout waits for new trades even when an older save is still in progress',async({page})=>{
  const server=await backend(page)
  await page.goto('/')
  await login(page,'alice@example.test')
  await expect(page.locator('.stat-value').first()).toHaveText('¥1,200,000')
  server.saveDelayMs=2500
  await page.getByRole('button',{name:'買い注文を出す',exact:true}).click()
  await expect.poll(()=>server.writes.length).toBe(1)
  await page.getByRole('button',{name:'買い注文を出す',exact:true}).click()
  await logout(page,'Alice')
  expect(server.rows[alice].state.account.positions).toHaveLength(2)
  expect(server.writes.every(write=>write.user===alice&&write.expected===alice)).toBe(true)
})


test('a second tab cannot overwrite unsynced trades from the active account tab',async({page})=>{
  const server=await backend(page)
  await page.goto('/')
  await login(page,'alice@example.test')
  await expect(page.locator('.stat-value').first()).toHaveText('¥1,200,000')
  const second=await page.context().newPage()
  await second.goto('/')
  await expect(second.getByRole('heading',{name:'この口座は別のタブで開いています'})).toBeVisible()
  server.offline=true
  await page.getByRole('button',{name:'買い注文を出す',exact:true}).click()
  await expect(page.getByRole('button',{name:'USD / JPYの買い建玉を決済',exact:true})).toBeVisible()
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('mango-fx-user:11111111-1111-4111-8111-111111111111:v1')||'{}').account?.positions?.length)).toBe(1)
  await page.close()
  await expect(second.getByRole('button',{name:'USD / JPYの買い建玉を決済',exact:true})).toBeVisible({timeout:15000})
  expect(server.rows[alice].state.account.positions).toHaveLength(0)
})


test('SMTP failure displays a delivery error without claiming a confirmation was sent',async({page})=>{
  const server=await backend(page)
  server.signupFailure=true
  await page.goto('/')
  await page.getByRole('button',{name:'ログイン',exact:true}).click()
  const dialog=page.getByRole('dialog')
  await dialog.getByRole('button',{name:'新規登録',exact:true}).click()
  await dialog.getByRole('textbox',{name:'メールアドレス',exact:true}).fill('new@example.test')
  await dialog.locator('input[autocomplete="new-password"]').first().fill(password)
  await dialog.getByLabel('パスワード（確認）',{exact:true}).fill(password)
  await dialog.getByRole('button',{name:'アカウントを作成',exact:true}).click()
  await expect(dialog.getByRole('alert')).toContainText('確認メールを送信できませんでした')
  await expect(dialog.getByRole('heading',{name:'メールをご確認ください'})).not.toBeVisible()
  expect(server.authRequests.filter(request=>request.path.startsWith('/auth/v1/signup'))).toHaveLength(1)
  expect(server.writes).toHaveLength(0)
})
