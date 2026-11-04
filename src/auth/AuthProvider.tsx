import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase, authConfigured, authRedirectUrl } from '../lib/supabase'
import { ACCOUNT_CONFIG } from '../config/accountConfig'

export interface AuthContextValue {
  user: User | null
  loading: boolean
  configured: boolean
  emailRegistrationReady: boolean
  recovery: boolean
  authError: string | null
  clearAuthError: () => void
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, displayName: string) => Promise<{ confirmationRequired: boolean }>
  signInWithGoogle: () => Promise<void>
  signOut: () => Promise<void>
  sendPasswordReset: (email: string) => Promise<void>
  updatePassword: (password: string) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)
const emailRegistrationReady = import.meta.env.VITE_EMAIL_REGISTRATION_READY === 'true' || ACCOUNT_CONFIG.emailRegistrationReady === true
const emailPreparationMessage = 'メールでの新規登録とパスワード再設定は準備中です。Googleでログインできます。'
export const OAUTH_RETRY_MESSAGE = 'ログインの有効期限が切れたか、開始時の情報を確認できません。同じブラウザでアプリを開き、ログインを最初からやり直してください。'
export const GOOGLE_LINK_CONFIGURATION_MESSAGE = 'Googleログインを完了できませんでした。連携設定の確認が必要です。メールアドレスでログインすることもできます。'

/** Keep provider details and account-existence information out of user-facing errors. */
export function authErrorMessage(error: unknown, action: 'signin' | 'signup' | 'reset' | 'google' | 'signout' | 'password' | 'session' = 'session'): string {
  const value = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown; name?: unknown; message?: unknown; details?: unknown } : null
  const code = typeof value?.code === 'string' ? value.code : ''
  const message = typeof value?.message === 'string' ? value.message.toLowerCase() : ''
  if (value?.status === 429 || code.includes('rate_limit') || /too many|rate limit/.test(message)) return '試行回数が多くなっています。少し時間をおいて、もう一度お試しください。'
  const emailDeliveryFailure = /error sending (?:confirmation|recovery|password recovery|password reset) e-?mail/.test(message)
    || /(?:failed|unable) to send (?:confirmation|recovery|password recovery|password reset) (?:e-?mail|message)/.test(message)
  if ((action === 'signup' || action === 'reset') && emailDeliveryFailure) return action === 'signup'
    ? '確認メールを送信できませんでした。Googleでログインするか、時間をおいてお試しください。'
    : '再設定用メールを送信できませんでした。Googleでログインするか、時間をおいてお試しください。'
  const oauthContext = action === 'google' || action === 'session'
  const details = value?.details && typeof value.details === 'object' ? value.details as { code?: unknown; error?: unknown } : null
  // URL callback errors are wrapped by auth-js; their stable codes live in details.
  const callbackCodes = [code, details?.code, details?.error].filter((item): item is string => typeof item === 'string').map(item => item.toLowerCase())
  const retryCodes = ['pkce_code_verifier_not_found', 'bad_code_verifier', 'flow_state_not_found', 'flow_state_expired', 'bad_oauth_state']
  if (oauthContext && (callbackCodes.some(item => retryCodes.includes(item)) || value?.name === 'AuthPKCECodeVerifierMissingError' || /pkce code verifier not found/.test(message))) return OAUTH_RETRY_MESSAGE
  if (oauthContext && (callbackCodes.includes('invalid_client') || /unable to exchange external code|\binvalid_client\b/.test(message))) return GOOGLE_LINK_CONFIGURATION_MESSAGE
  if (oauthContext && callbackCodes.includes('access_denied')) return 'Googleログインが許可されませんでした。アカウント選択からやり直すか、メールアドレスでログインしてください。'
  if (value?.name === 'AuthRetryableFetchError' || value?.name === 'TypeError' || /fetch|network|offline|failed to send/.test(message)) return action === 'signout' ? '通信できないため、ログアウトを完了できませんでした。接続を確認して、もう一度お試しください。' : '通信できませんでした。インターネット接続を確認して、もう一度お試しください。'
  if (code === 'email_not_confirmed' || /email not confirmed/.test(message)) return '確認メール内のリンクを開いて、メールアドレスの確認を完了してください。'
  if (code === 'weak_password' || /weak password|password.*least|password.*short/.test(message)) return 'より安全なパスワードを設定してください。8文字以上で、英字・数字などを組み合わせてください。'
  if (code === 'same_password' || /same password|different from.*old/.test(message)) return '現在のパスワードとは異なるパスワードを設定してください。'
  if (code === 'provider_disabled' || code === 'oauth_provider_not_supported' || /provider.*not enabled|unsupported provider/.test(message)) return 'Googleログインを現在利用できません。メールアドレスでのログインをお試しください。'
  if (action === 'signin' || code === 'invalid_credentials') return 'メールアドレスまたはパスワードを確認してください。'
  if (action === 'signup') return '登録を完了できませんでした。入力内容を確認してください。登録済みの場合はログインをお試しください。'
  if (action === 'reset') return '再設定用メールを送信できませんでした。しばらくしてから、もう一度お試しください。'
  if (action === 'google') return 'Googleログインを完了できませんでした。もう一度お試しください。'
  if (action === 'signout') return 'ログアウトを完了できませんでした。もう一度お試しください。'
  if (action === 'password') return 'パスワードを変更できませんでした。再設定メールからやり直してください。'
  return 'ログイン状態を確認できませんでした。もう一度ログインしてください。'
}

/** Remove only consumed/failed auth parameters, preserving all application state. */
export function cleanAuthCallbackUrl(href: string, failedCode = false): string {
  const url = new URL(href)
  const errorKeys = ['error', 'error_code', 'error_description']
  for (const key of errorKeys) if (url.searchParams.has(key)) url.searchParams.delete(key)
  if (failedCode) {
    url.searchParams.delete('code')
    url.searchParams.delete('sb_flow_id')
  }
  const fragment = new URLSearchParams(url.hash.slice(1))
  if (errorKeys.some(key => fragment.has(key)) || (failedCode && (fragment.has('code') || fragment.has('sb_flow_id')))) {
    for (const key of errorKeys) fragment.delete(key)
    if (failedCode) { fragment.delete('code'); fragment.delete('sb_flow_id') }
    url.hash = fragment.toString()
  }
  return url.href
}

function replaceAuthCallbackUrl(failedCode = false) {
  const clean = cleanAuthCallbackUrl(window.location.href, failedCode)
  if (clean !== window.location.href) {
    // A browser history restriction must not hide the actual authentication error.
    try { window.history.replaceState(window.history.state, '', clean) } catch { /* Keep the error UI usable. */ }
  }
}

function client() {
  if (!supabase) throw new Error('個人アカウントの準備が完了していません。ゲストとして練習できます。')
  return supabase
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(Boolean(supabase))
  const [recovery, setRecovery] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const clearAuthError = useCallback(() => {
    setAuthError(null)
    replaceAuthCallbackUrl()
  }, [])

  useEffect(() => {
    if (!supabase) { setLoading(false); return }
    let disposed = false, receivedEvent = false, authenticatedEvent = false
    // Never await another Supabase call inside this callback: auth uses a lock.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (disposed) return
      receivedEvent = true
      if (event === 'SIGNED_IN' || event === 'PASSWORD_RECOVERY') authenticatedEvent = true
      setUser(session?.user || null)
      setLoading(false)
      if (event === 'PASSWORD_RECOVERY') setRecovery(true)
      if (event === 'SIGNED_OUT') setRecovery(false)
      // Background session recovery can emit SIGNED_IN. Only an explicit
      // dismissal or a successful user auth action acknowledges a pending error.
    })
    const target = supabase
    void (async () => {
      // getSession() does not surface URL/PKCE initialization failures. Read the
      // public initializer result too, so expired/cancelled callbacks are visible.
      const initialized = await target.auth.initialize()
      const { data, error } = await target.auth.getSession()
      if (disposed) return
      if (!receivedEvent) {
        setUser(error ? null : data.session?.user || null)
        setLoading(false)
      }
      // A successful SDK callback consumes its code. If it is still present,
      // auth-js may have ignored it because no matching PKCE flow was found.
      // Keep any existing valid session; this is an error in this login attempt.
      const callbackUrl = new URL(window.location.href)
      const unconsumedCode = callbackUrl.searchParams.has('code') || new URLSearchParams(callbackUrl.hash.slice(1)).has('code')
      const initialError = initialized.error || (unconsumedCode ? { code: 'pkce_code_verifier_not_found' } : null) || error
      if (initialized.error || unconsumedCode) replaceAuthCallbackUrl(true)
      if (initialError && (!authenticatedEvent || unconsumedCode)) setAuthError(authErrorMessage(initialError))
    })().catch(error => {
      if (!disposed) {
        if (!receivedEvent) { setUser(null); setLoading(false) }
        if (!authenticatedEvent) setAuthError(authErrorMessage(error))
      }
    })
    return () => { disposed = true; subscription.unsubscribe() }
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await client().auth.signInWithPassword({ email: email.trim(), password })
    if (error) throw new Error(authErrorMessage(error, 'signin'))
    setAuthError(null)
  }, [])
  const signUp = useCallback(async (email: string, password: string, displayName: string) => {
    if (!emailRegistrationReady) throw new Error(emailPreparationMessage)
    const { data, error } = await client().auth.signUp({
      email: email.trim(), password,
      options: { emailRedirectTo: authRedirectUrl(), data: { display_name: displayName.trim().slice(0, 40) } },
    })
    if (error) throw new Error(authErrorMessage(error, 'signup'))
    setAuthError(null)
    return { confirmationRequired: !data.session }
  }, [])
  const signInWithGoogle = useCallback(async () => {
    const { error } = await client().auth.signInWithOAuth({ provider: 'google', options: { redirectTo: authRedirectUrl(), queryParams: { prompt: 'select_account' } } })
    if (error) throw new Error(authErrorMessage(error, 'google'))
  }, [])
  const signOut = useCallback(async () => {
    const target = client()
    const { error } = await target.auth.signOut({ scope: 'local' })
    if (error) {
      // The supported SDK removes the local session even if server revocation
      // fails offline. Verify that outcome instead of pretending it succeeded.
      const { data, error: sessionError } = await target.auth.getSession()
      if (sessionError || data.session) throw new Error(authErrorMessage(error, 'signout'))
    }
    setUser(null)
    setRecovery(false)
    setAuthError(null)
  }, [])
  const sendPasswordReset = useCallback(async (email: string) => {
    if (!emailRegistrationReady) throw new Error(emailPreparationMessage)
    const { error } = await client().auth.resetPasswordForEmail(email.trim(), { redirectTo: authRedirectUrl() })
    if (error) throw new Error(authErrorMessage(error, 'reset'))
  }, [])
  const updatePassword = useCallback(async (password: string) => {
    const { error } = await client().auth.updateUser({ password })
    if (error) throw new Error(authErrorMessage(error, 'password'))
    setRecovery(false)
  }, [])
  const value = useMemo<AuthContextValue>(() => ({ user, loading, configured: authConfigured, emailRegistrationReady, recovery, authError, clearAuthError, signIn, signUp, signInWithGoogle, signOut, sendPasswordReset, updatePassword }), [user, loading, recovery, authError, clearAuthError, signIn, signUp, signInWithGoogle, signOut, sendPasswordReset, updatePassword])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export default AuthProvider
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
