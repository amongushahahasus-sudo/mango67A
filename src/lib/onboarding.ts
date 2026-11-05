export const ONBOARDING_STORAGE_KEY = 'mango-fx-onboarding-v1'
export type OnboardingStatus = 'unseen' | 'completed' | 'unavailable'
type ReadStorage = Pick<Storage, 'getItem'>
type WriteStorage = Pick<Storage, 'setItem'>

/** A failed storage read cannot establish whether this is the first visit. */
export function readOnboardingStatus(storage?: ReadStorage): OnboardingStatus {
  try {
    const target = storage ?? globalThis.localStorage
    return target.getItem(ONBOARDING_STORAGE_KEY) === 'completed' ? 'completed' : 'unseen'
  } catch { return 'unavailable' }
}

export function completeOnboarding(storage?: WriteStorage): boolean {
  try {
    const target = storage ?? globalThis.localStorage
    target.setItem(ONBOARDING_STORAGE_KEY, 'completed')
    return true
  } catch { return false }
}

/** Recovery and OAuth returns keep their existing account screen in front. */
export function hasAccountCallback(href: string): boolean {
  try {
    const url = new URL(href)
    const fragment = new URLSearchParams(url.hash.slice(1))
    return ['code', 'token_hash', 'error', 'error_code', 'error_description'].some(key => url.searchParams.has(key))
      || ['access_token', 'refresh_token', 'error', 'error_code', 'error_description'].some(key => fragment.has(key))
      || url.searchParams.get('type') === 'recovery' || fragment.get('type') === 'recovery'
  } catch { return false }
}
