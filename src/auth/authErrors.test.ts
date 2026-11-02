import { describe, expect, it } from 'vitest'
import { authErrorMessage, cleanAuthCallbackUrl, GOOGLE_LINK_CONFIGURATION_MESSAGE, OAUTH_RETRY_MESSAGE } from './AuthProvider'

describe('authentication error guidance', () => {
  it('explains a confirmation-email delivery failure without blaming input or exposing provider data', () => {
    const result = authErrorMessage({
      name: 'AuthRetryableFetchError', code: 'unexpected_failure', status: 500,
      message: 'Error sending confirmation email: smtp.example.invalid rejected recipient private@example.invalid; credential=DO_NOT_ECHO',
    }, 'signup')
    expect(result).toContain('確認メールを送信できませんでした')
    expect(result).toContain('Googleでログイン')
    expect(result).not.toMatch(/入力内容|通信でき|smtp|private@example|DO_NOT_ECHO/i)
  })

  it('distinguishes recovery-email delivery failure from a browser network failure', () => {
    const delivery = authErrorMessage({ code: 'unexpected_failure', status: 500, message: 'Failed to send recovery email' }, 'reset')
    const network = authErrorMessage({ name: 'AuthRetryableFetchError', message: 'Failed to fetch' }, 'reset')
    expect(delivery).toContain('再設定用メールを送信できませんでした')
    expect(delivery).toContain('Googleでログイン')
    expect(network).toContain('インターネット接続を確認')
    expect(network).not.toContain('再設定用メールを送信できませんでした')
  })

  it('keeps invalid credentials generic and does not reveal whether an address exists', () => {
    const result = authErrorMessage({ code: 'invalid_credentials', status: 400, message: 'Invalid login credentials for private@example.invalid' }, 'signin')
    expect(result).toBe('メールアドレスまたはパスワードを確認してください。')
    expect(result).not.toContain('private@example.invalid')
  })

  it('does not label unrelated signup validation failures as email-delivery failures', () => {
    const result = authErrorMessage({ code: 'email_address_invalid', status: 400, message: 'Email address private@example.invalid is invalid' }, 'signup')
    expect(result).toContain('入力内容を確認')
    expect(result).not.toContain('メールを送信できませんでした')
    expect(result).not.toContain('private@example.invalid')
  })

  it('gives rate-limit guidance precedence over a delivery-error message', () => {
    const result = authErrorMessage({ code: 'over_email_send_rate_limit', status: 429, message: 'Error sending confirmation email' }, 'signup')
    expect(result).toContain('試行回数が多く')
    expect(result).not.toContain('Googleでログイン')
  })

  it('keeps duplicate-signup responses conditional and free of account-existence disclosures', () => {
    const result = authErrorMessage({ code: 'user_already_exists', message: 'User private@example.invalid already registered; secret=DO_NOT_ECHO' }, 'signup')
    expect(result).toContain('登録済みの場合はログイン')
    expect(result).not.toMatch(/private@example|DO_NOT_ECHO|User /)
  })

  it('handles malformed provider errors without throwing or echoing arbitrary fields', () => {
    expect(() => authErrorMessage({ message: { raw: 'DO_NOT_ECHO' }, code: 123 }, 'signup')).not.toThrow()
    expect(authErrorMessage({ message: { raw: 'DO_NOT_ECHO' }, code: 123 }, 'signup')).not.toContain('DO_NOT_ECHO')
    expect(authErrorMessage('DO_NOT_ECHO', 'session')).not.toContain('DO_NOT_ECHO')
  })
})


describe('OAuth callback guidance and URL cleanup', () => {
  it.each(['pkce_code_verifier_not_found', 'bad_code_verifier', 'flow_state_not_found', 'flow_state_expired', 'bad_oauth_state'])('guides a %s failure to restart in the same browser', code => {
    const result = authErrorMessage({ code, message: 'DO_NOT_ECHO' }, 'session')
    expect(result).toBe(OAUTH_RETRY_MESSAGE)
    expect(result).toContain('同じブラウザ')
    expect(result).not.toContain('DO_NOT_ECHO')
  })

  it('reads auth-js wrapped callback details without displaying them', () => {
    const result = authErrorMessage({ name: 'AuthImplicitGrantRedirectError', code: 'unexpected_failure', details: { error: 'server_error', code: 'flow_state_expired' }, message: 'DO_NOT_ECHO' }, 'session')
    expect(result).toBe(OAUTH_RETRY_MESSAGE)
    expect(result).not.toMatch(/server_error|flow_state|DO_NOT_ECHO/)
  })

  it('recognizes a specific provider exchange failure even when the SDK labels it retryable', () => {
    const result = authErrorMessage({ name: 'AuthRetryableFetchError', status: 500, code: 'unexpected_failure', message: 'Unable to exchange external code: invalid_client, secret=DO_NOT_ECHO, code=PRIVATE_CODE' }, 'session')
    expect(result).toBe(GOOGLE_LINK_CONFIGURATION_MESSAGE)
    expect(result).not.toMatch(/invalid_client|DO_NOT_ECHO|PRIVATE_CODE|secret=/)
  })

  it('recognizes invalid_client in callback details and offers email login', () => {
    const result = authErrorMessage({ details: { error: 'invalid_client', code: 'unexpected_failure' }, message: 'DO_NOT_ECHO' }, 'google')
    expect(result).toBe(GOOGLE_LINK_CONFIGURATION_MESSAGE)
    expect(result).toContain('メールアドレスでログイン')
  })

  it('keeps an unrelated unexpected failure generic rather than guessing a Google settings problem', () => {
    const result = authErrorMessage({ code: 'unexpected_failure', status: 500, message: 'Internal server error DO_NOT_ECHO' }, 'session')
    expect(result).toBe('ログイン状態を確認できませんでした。もう一度ログインしてください。')
    expect(result).not.toMatch(/連携設定|DO_NOT_ECHO/)
  })

  it('does not reveal a provider denial description or confuse it with invalid password input', () => {
    const denial = authErrorMessage({ details: { error: 'access_denied', code: 'unexpected_failure' }, message: 'PRIVATE_ACCOUNT was denied' }, 'session')
    expect(denial).toContain('Googleログインが許可されませんでした')
    expect(denial).not.toContain('PRIVATE_ACCOUNT')
    expect(authErrorMessage({ code: 'invalid_credentials', message: 'invalid_client' }, 'signin')).toBe('メールアドレスまたはパスワードを確認してください。')
  })

  it('cleans only failed callback parameters while preserving the app URL and unrelated state', () => {
    const result = cleanAuthCallbackUrl('https://example.invalid/mango67A/?view=learn&code=PRIVATE_CODE&sb_flow_id=PRIVATE_FLOW&error=server_error&error_description=DO_NOT_ECHO#history', true)
    expect(result).toBe('https://example.invalid/mango67A/?view=learn#history')
  })

  it('does not consume a good pending PKCE code when only clearing an error notice', () => {
    const url = 'https://example.invalid/mango67A/?code=GOOD_CODE&sb_flow_id=GOOD_FLOW#orders'
    expect(cleanAuthCallbackUrl(url)).toBe(url)
    expect(cleanAuthCallbackUrl('https://example.invalid/mango67A/#error=access_denied&error_code=unexpected_failure&view=learn')).toBe('https://example.invalid/mango67A/#view=learn')
  })
})
