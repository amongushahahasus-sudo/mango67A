import { describe, expect, it } from 'vitest'
import { createSavedState, parseSavedState, userStorageKey, hasPracticeProgress, GUEST_STORAGE_KEY } from './practiceState'
import { validatePublicSupabaseConfig } from './supabase'

describe('account state boundaries', () => {
  it('keeps two users and guest on distinct storage keys', () => {
    const a=userStorageKey('11111111-1111-4111-8111-111111111111')
    const b=userStorageKey('22222222-2222-4222-8222-222222222222')
    expect(new Set([a,b,GUEST_STORAGE_KEY]).size).toBe(3)
  })
  it('recognizes actual guest progress before offering a migration',()=>{
    const state=createSavedState()
    expect(hasPracticeProgress(state)).toBe(false)
    state.account.balance-=30
    expect(hasPracticeProgress(state)).toBe(true)
  })
  it('resumes a legacy paused save without resetting its trading data',()=>{
    const state=createSavedState()
    state.paused=true
    state.speed=2
    state.account.balance=1_012_345
    state.account.positions.push({id:'held',pair:'USDJPY',side:'buy',units:1000,entryPrice:153,openedAt:1})
    state.account.orders.push({id:'pending',pair:'EURJPY',side:'buy',units:1000,type:'limit',price:1,createdAt:2})
    state.account.history.push({id:'closed',pair:'USDJPY',side:'sell',units:1000,entryPrice:154,exitPrice:153,pnl:1000,reason:'manual',openedAt:1,closedAt:2})
    expect(parseSavedState(state)).toEqual({...state,paused:false})
    expect(state.paused).toBe(true)
  })
  it('refuses a corrupted cloud history instead of replacing it with new money',()=>{
    const state=createSavedState()
    state.account.history.push({id:'bad',pair:'USDJPY',side:'buy',units:10000,entryPrice:153,exitPrice:154,pnl:10000,reason:'manual',openedAt:NaN,closedAt:1})
    expect(parseSavedState(state)).toBeNull()
    expect(parseSavedState(null)).toBeNull()
  })
})

describe('public authentication configuration',()=>{
  const url='https://testproject.supabase.co'
  const key='sb_publishable_test_public_key_1234567890'
  it('accepts publishable browser keys and HTTPS project URLs',()=>{
    expect(validatePublicSupabaseConfig(url+'/',key)).toEqual({url,publishableKey:key})
  })
  it('refuses privileged keys and account tokens',()=>{
    const jwt=(role:string)=>`eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({role})).replaceAll('=','')}.fixture_signature`
    expect(validatePublicSupabaseConfig(url,'sb_secret_do_not_expose_this_1234567890')).toBeNull()
    expect(validatePublicSupabaseConfig(url,jwt('service_role'))).toBeNull()
    expect(validatePublicSupabaseConfig(url,jwt('authenticated'))).toBeNull()
    expect(validatePublicSupabaseConfig(url,jwt('anon'))).not.toBeNull()
  })
  it('rejects insecure, credential-bearing and query-controlled endpoints',()=>{
    for(const endpoint of ['http://testproject.supabase.co','https://name:pass@testproject.supabase.co','https://testproject.supabase.co/?redirect=evil','https://testproject.supabase.co/path','https://unrelated.example']) expect(validatePublicSupabaseConfig(endpoint,key)).toBeNull()
    expect(validatePublicSupabaseConfig('http://127.0.0.1:54321',key,true)).not.toBeNull()
    expect(validatePublicSupabaseConfig('http://127.0.0.1:54321',key,false)).toBeNull()
  })
})
