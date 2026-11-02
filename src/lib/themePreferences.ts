export type ThemeMode = 'light' | 'dark' | 'auto'
export type ResolvedTheme = 'light' | 'dark'

export interface ThemePreferences {
  mode: ThemeMode
  lightStart: string
  darkStart: string
}

export const THEME_STORAGE_KEY = 'mango-fx-theme-v1'
export const DEFAULT_THEME_PREFERENCES: ThemePreferences = Object.freeze({
  mode: 'light',
  lightStart: '07:00',
  darkStart: '19:00',
})

const isTime = (value: unknown): value is string => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))

export function isValidThemePreferences(value: unknown): value is ThemePreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (candidate.mode === 'light' || candidate.mode === 'dark' || candidate.mode === 'auto')
    && isTime(candidate.lightStart) && isTime(candidate.darkStart)
    && candidate.lightStart !== candidate.darkStart
}

export function parseThemePreferences(raw: string | null): ThemePreferences {
  const fallback = () => ({ ...DEFAULT_THEME_PREFERENCES })
  if (raw === null) return fallback()
  try {
    const value: unknown = JSON.parse(raw)
    if (!isValidThemePreferences(value)) return fallback()
    return { mode: value.mode, lightStart: value.lightStart, darkStart: value.darkStart }
  } catch {
    return fallback()
  }
}

export function resolveTheme(preferences: ThemePreferences, now: Date): ResolvedTheme {
  if (preferences.mode !== 'auto') return preferences.mode
  const current = now.getHours() * 60 + now.getMinutes()
  const lightStart = minutesOf(preferences.lightStart)
  const darkStart = minutesOf(preferences.darkStart)
  const isLight = lightStart < darkStart
    ? current >= lightStart && current < darkStart
    : current >= lightStart || current < darkStart
  return isLight ? 'light' : 'dark'
}

export function readThemePreferences(storage?: Pick<Storage, 'getItem'>): ThemePreferences {
  try {
    const source = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage)
    return parseThemePreferences(source?.getItem(THEME_STORAGE_KEY) ?? null)
  } catch {
    return { ...DEFAULT_THEME_PREFERENCES }
  }
}
