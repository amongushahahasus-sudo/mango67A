import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { ACCOUNT_CONFIG } from '../config/accountConfig'

export interface PublicSupabaseConfig { url: string; publishableKey: string }

/** Frontend configuration accepts public browser keys only, never privileged keys. */
export function validatePublicSupabaseConfig(url: string, key: string, allowLocalhost = false): PublicSupabaseConfig | null {
  const publishableKey = key.trim()
  if (!url.trim() || !publishableKey || publishableKey.startsWith('sb_secret_')) return null
  let parsed: URL
  try { parsed = new URL(url.trim()) } catch { return null }
  const hosted = parsed.protocol === 'https:' && /^[a-z0-9-]+\.supabase\.co$/i.test(parsed.hostname)
  const local = allowLocalhost && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && ['http:', 'https:'].includes(parsed.protocol)
  if ((!hosted && !local) || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) return null
  if (hosted && parsed.port && parsed.port !== '443') return null
  if (!/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(publishableKey)) {
    const parts = publishableKey.split('.')
    if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return null
    try {
      const payload = JSON.parse(atob(parts[1].replaceAll('-', '+').replaceAll('_', '/'))) as { role?: unknown }
      if (payload.role !== 'anon') return null
    } catch { return null }
  }
  return { url: parsed.origin, publishableKey }
}

const config = validatePublicSupabaseConfig(
  import.meta.env.VITE_SUPABASE_URL || ACCOUNT_CONFIG.url,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || ACCOUNT_CONFIG.publishableKey,
  import.meta.env.DEV,
)

function initialize(): SupabaseClient | null {
  if (!config || typeof window === 'undefined' || !['http:', 'https:'].includes(window.location.protocol)) return null
  try {
    const path = new URL(import.meta.env.BASE_URL, window.location.href).pathname
    return createClient(config.url, config.publishableKey, {
      auth: {
        flowType: 'pkce',
        detectSessionInUrl: true,
        persistSession: true,
        autoRefreshToken: true,
        storageKey: `mango-fx-auth-v1:${new URL(config.url).hostname}:${path}`,
      },
    })
  } catch { return null }
}

export const supabase: SupabaseClient | null = initialize()
export const authConfigured = supabase !== null

/** The return destination is the current app directory, never a query-supplied URL. */
export function authRedirectUrl(): string {
  if (typeof window === 'undefined' || !['https:', 'http:'].includes(window.location.protocol)) throw new Error('ログインには公開されたアプリを開いてください。')
  const target = new URL(import.meta.env.BASE_URL || './', window.location.href)
  if (target.origin !== window.location.origin) throw new Error('ログインの戻り先を確認できませんでした。')
  target.search = ''
  target.hash = ''
  return target.href
}
