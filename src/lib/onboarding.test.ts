import { describe, expect, it, vi } from 'vitest'
import { completeOnboarding, hasAccountCallback, ONBOARDING_STORAGE_KEY, readOnboardingStatus } from './onboarding'

describe('first-visit onboarding preferences', () => {
  it('only the current completion marker skips the first-visit guide', () => {
    for (const value of [null, '', 'false', 'unfinished', '{"completed":true}']) {
      expect(readOnboardingStatus({ getItem: () => value })).toBe('unseen')
    }
    expect(readOnboardingStatus({ getItem: () => 'completed' })).toBe('completed')
  })

  it('keeps practice and account data out of completion storage', () => {
    const setItem = vi.fn()
    expect(completeOnboarding({ setItem })).toBe(true)
    expect(setItem).toHaveBeenCalledExactlyOnceWith(ONBOARDING_STORAGE_KEY, 'completed')
  })

  it('handles blocked reads and writes without trapping the app in a modal', () => {
    expect(readOnboardingStatus({ getItem() { throw new Error('Storage denied') } })).toBe('unavailable')
    expect(completeOnboarding({ setItem() { throw new Error('Quota exceeded') } })).toBe(false)
  })

  it('defers to existing callback and recovery screens but allows ordinary first visits', () => {
    const site = 'https://example.test/mango67A/'
    for (const suffix of ['?code=one-time-code', '?token_hash=hash', '?error=invalid_client', '?error_code=example', '?error_description=example', '?type=recovery', '#type=recovery', '#access_token=token', '#refresh_token=token', '#error=example']) {
      expect(hasAccountCallback(site + suffix)).toBe(true)
    }
    for (const suffix of ['', '?theme=light', '#help', '?type=ordinary']) expect(hasAccountCallback(site + suffix)).toBe(false)
    expect(hasAccountCallback('not a URL')).toBe(false)
  })
})
