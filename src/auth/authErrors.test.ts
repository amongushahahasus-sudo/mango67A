import { describe, expect, it } from 'vitest'
import { authErrorMessage } from './AuthProvider'

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
