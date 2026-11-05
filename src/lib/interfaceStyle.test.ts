import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_INTERFACE_STYLE, INTERFACE_STYLE_STORAGE_KEY, isInterfaceStyle, parseInterfaceStyle, readInterfaceStyle } from './interfaceStyle'
import { THEME_STORAGE_KEY } from './themePreferences'
import { initializeTheme } from '../theme/ThemeProvider'

afterEach(() => { vi.unstubAllGlobals() })

describe('interface design preferences', () => {
  it('accepts the two supported designs and retains standard as the default', () => {
    expect(DEFAULT_INTERFACE_STYLE).toBe('standard')
    for (const style of ['standard', 'glass']) {
      expect(isInterfaceStyle(style)).toBe(true)
      expect(parseInterfaceStyle(style)).toBe(style)
    }
  })

  it('does not trust malformed or obsolete persisted values', () => {
    for (const raw of [null, '', 'GLASS', 'glass\n', ' glass', '"glass"', '{}', 'true', 'dark']) {
      expect(parseInterfaceStyle(raw)).toBe('standard')
    }
    for (const value of [undefined, null, 1, true, {}, ['glass']]) expect(isInterfaceStyle(value)).toBe(false)
  })

  it('reads only its dedicated key, without changing theme schedules or account data', () => {
    const keys: string[] = []
    expect(readInterfaceStyle({ getItem: key => { keys.push(key); return 'glass' } })).toBe('glass')
    expect(keys).toEqual([INTERFACE_STYLE_STORAGE_KEY])
    expect(INTERFACE_STYLE_STORAGE_KEY).not.toBe(THEME_STORAGE_KEY)
  })

  it('remains usable when storage is absent or blocked', () => {
    expect(readInterfaceStyle({ getItem: () => null })).toBe('standard')
    expect(readInterfaceStyle({ getItem: () => { throw new Error('Storage blocked') } })).toBe('standard')
    expect(readInterfaceStyle()).toBe('standard')
  })

  it('applies saved color and design before mounting, with independent safe defaults', () => {
    const theme = JSON.stringify({ mode: 'dark', lightStart: '07:00', darkStart: '19:00' })
    const values = new Map([[THEME_STORAGE_KEY, theme], [INTERFACE_STYLE_STORAGE_KEY, 'glass']])
    const dataset: Record<string, string> = {}
    const setAttribute = vi.fn()
    const setItem = vi.fn()
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem } })
    vi.stubGlobal('document', { documentElement: { dataset }, querySelector: () => ({ setAttribute }) })

    initializeTheme()
    expect(dataset).toEqual({ theme: 'dark', interfaceStyle: 'glass' })
    expect(setAttribute).toHaveBeenCalledWith('content', '#0b1019')
    expect(setItem).not.toHaveBeenCalled()
    expect(values.get(THEME_STORAGE_KEY)).toBe(theme)

    values.delete(INTERFACE_STYLE_STORAGE_KEY)
    initializeTheme()
    expect(dataset).toEqual({ theme: 'dark', interfaceStyle: 'standard' })
    expect(values.get(THEME_STORAGE_KEY)).toBe(theme)
  })
})
