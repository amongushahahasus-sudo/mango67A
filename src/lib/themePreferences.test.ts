import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME_PREFERENCES, THEME_STORAGE_KEY, isValidThemePreferences, parseThemePreferences, readThemePreferences, resolveTheme } from './themePreferences'
import type { ThemePreferences } from './themePreferences'

const localTime = (hours: number, minutes = 0, seconds = 0) => new Date(2026, 10, 2, hours, minutes, seconds)
const automatic: ThemePreferences = { ...DEFAULT_THEME_PREFERENCES, mode: 'auto' }

describe('theme preferences storage', () => {
  it('preserves a valid manual or automatic choice and custom schedule', () => {
    for (const mode of ['light', 'dark', 'auto'] as const) {
      const preferences = { mode, lightStart: '06:30', darkStart: '20:45' }
      expect(parseThemePreferences(JSON.stringify(preferences))).toEqual(preferences)
    }
  })

  it('keeps the current light appearance when settings are absent or corrupted', () => {
    for (const raw of [null, '', '{', 'null', 'true', '4', '[]', '{}']) {
      expect(parseThemePreferences(raw)).toEqual(DEFAULT_THEME_PREFERENCES)
    }
  })

  it('rejects unknown modes and missing settings instead of trusting persisted JSON', () => {
    for (const value of [
      { ...automatic, mode: 'system' },
      { ...automatic, mode: null },
      { mode: 'auto', lightStart: '07:00' },
      { mode: 'auto', darkStart: '19:00' },
    ]) expect(parseThemePreferences(JSON.stringify(value))).toEqual(DEFAULT_THEME_PREFERENCES)
  })

  it('requires complete 24-hour HH:mm values with two distinct switching times', () => {
    for (const invalid of ['7:00', '07:0', '24:00', '19:60', '-1:00', '07:00:00', ' 07:00', '07:00\n', '', 700, null]) {
      expect(parseThemePreferences(JSON.stringify({ ...automatic, lightStart: invalid }))).toEqual(DEFAULT_THEME_PREFERENCES)
      expect(parseThemePreferences(JSON.stringify({ ...automatic, darkStart: invalid }))).toEqual(DEFAULT_THEME_PREFERENCES)
    }
    expect(parseThemePreferences(JSON.stringify({ mode: 'auto', lightStart: '07:00', darkStart: '07:00' }))).toEqual(DEFAULT_THEME_PREFERENCES)
  })

  it('can reject incomplete or equal time inputs without replacing the current choice', () => {
    expect(isValidThemePreferences({ ...automatic, lightStart: '' })).toBe(false)
    expect(isValidThemePreferences({ ...automatic, darkStart: '07:00' })).toBe(false)
    expect(isValidThemePreferences({ ...automatic, darkStart: '20:30' })).toBe(true)
  })

  it('returns fresh validated data and ignores unrelated persisted fields', () => {
    expect(parseThemePreferences(JSON.stringify({ ...automatic, unrelated: true }))).toEqual(automatic)
    const absent = parseThemePreferences(null)
    absent.mode = 'dark'
    expect(parseThemePreferences(null).mode).toBe('light')
  })

  it('reads the dedicated appearance key without touching account or trading data', () => {
    const keys: string[] = []
    const stored = { ...automatic, darkStart: '21:00' }
    expect(readThemePreferences({ getItem: key => { keys.push(key); return JSON.stringify(stored) } })).toEqual(stored)
    expect(keys).toEqual([THEME_STORAGE_KEY])
  })

  it('remains usable when browser storage is unavailable or throws', () => {
    expect(readThemePreferences({ getItem: () => { throw new Error('Storage blocked') } })).toEqual(DEFAULT_THEME_PREFERENCES)
    expect(readThemePreferences({ getItem: () => null })).toEqual(DEFAULT_THEME_PREFERENCES)
    expect(readThemePreferences()).toEqual(DEFAULT_THEME_PREFERENCES)
  })
})

describe('time-based theme resolution', () => {
  it('switches at the configured local times, including their exact boundaries', () => {
    expect(resolveTheme(automatic, localTime(6, 59, 59))).toBe('dark')
    expect(resolveTheme(automatic, localTime(7))).toBe('light')
    expect(resolveTheme(automatic, localTime(18, 59, 59))).toBe('light')
    expect(resolveTheme(automatic, localTime(19))).toBe('dark')
    expect(resolveTheme(automatic, localTime(23, 59))).toBe('dark')
    expect(resolveTheme(automatic, localTime(0))).toBe('dark')
  })

  it('supports minute-level schedules rather than rounding to hours', () => {
    const preferences = { ...automatic, lightStart: '06:30', darkStart: '20:45' }
    expect(resolveTheme(preferences, localTime(6, 29))).toBe('dark')
    expect(resolveTheme(preferences, localTime(6, 30))).toBe('light')
    expect(resolveTheme(preferences, localTime(20, 44))).toBe('light')
    expect(resolveTheme(preferences, localTime(20, 45))).toBe('dark')
  })

  it('allows the light interval to pass through midnight', () => {
    const overnight = { ...automatic, lightStart: '19:00', darkStart: '07:00' }
    expect(resolveTheme(overnight, localTime(18, 59))).toBe('dark')
    expect(resolveTheme(overnight, localTime(19))).toBe('light')
    expect(resolveTheme(overnight, localTime(0))).toBe('light')
    expect(resolveTheme(overnight, localTime(6, 59))).toBe('light')
    expect(resolveTheme(overnight, localTime(7))).toBe('dark')
  })

  it('handles a midnight start or end without an empty interval', () => {
    expect(resolveTheme({ ...automatic, lightStart: '00:00', darkStart: '12:00' }, localTime(0))).toBe('light')
    expect(resolveTheme({ ...automatic, lightStart: '00:00', darkStart: '12:00' }, localTime(12))).toBe('dark')
    expect(resolveTheme({ ...automatic, lightStart: '12:00', darkStart: '00:00' }, localTime(23, 59))).toBe('light')
    expect(resolveTheme({ ...automatic, lightStart: '12:00', darkStart: '00:00' }, localTime(0))).toBe('dark')
  })

  it('keeps manual selections fixed regardless of the time', () => {
    for (const hour of [0, 7, 12, 19, 23]) {
      expect(resolveTheme({ ...automatic, mode: 'light' }, localTime(hour))).toBe('light')
      expect(resolveTheme({ ...automatic, mode: 'dark' }, localTime(hour))).toBe('dark')
    }
  })
})
