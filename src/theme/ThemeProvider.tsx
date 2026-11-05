import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { isValidThemePreferences, parseThemePreferences, readThemePreferences, resolveTheme, THEME_STORAGE_KEY, type ResolvedTheme, type ThemePreferences } from '../lib/themePreferences'
import { INTERFACE_STYLE_STORAGE_KEY, isInterfaceStyle, parseInterfaceStyle, readInterfaceStyle, type InterfaceStyle } from '../lib/interfaceStyle'

interface ThemeContextValue {
  preferences: ThemePreferences
  resolvedTheme: ResolvedTheme
  saveFailed: boolean
  updatePreferences: (preferences: ThemePreferences) => boolean
  interfaceStyle: InterfaceStyle
  styleSaveFailed: boolean
  updateInterfaceStyle: (style: InterfaceStyle) => boolean
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function applyTheme(theme: ResolvedTheme) {
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0b1019' : '#f7f9f2')
}

function applyInterfaceStyle(style: InterfaceStyle) {
  document.documentElement.dataset.interfaceStyle = style
}

/** Apply the saved choice before React mounts, including account loading screens. */
export function initializeTheme() {
  applyTheme(resolveTheme(readThemePreferences(), new Date()))
  applyInterfaceStyle(readInterfaceStyle())
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(readThemePreferences)
  const [now, setNow] = useState(() => new Date())
  const [saveFailed, setSaveFailed] = useState(false)
  const [interfaceStyle, setInterfaceStyle] = useState(readInterfaceStyle)
  const [styleSaveFailed, setStyleSaveFailed] = useState(false)
  const resolvedTheme = resolveTheme(preferences, now)

  useLayoutEffect(() => { applyTheme(resolvedTheme) }, [resolvedTheme])
  useLayoutEffect(() => { applyInterfaceStyle(interfaceStyle) }, [interfaceStyle])

  useEffect(() => {
    if (preferences.mode !== 'auto') return
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      setNow(new Date())
      // Align with the next real minute, including schedules changed while open.
      timer = setTimeout(refresh, 60_000 - Date.now() % 60_000)
    }
    refresh()
    const onVisibility = () => { if (document.visibilityState === 'visible') refresh() }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [preferences.mode, preferences.lightStart, preferences.darkStart])

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) {
        setPreferences(parseThemePreferences(event.key === null ? null : event.newValue))
        setNow(new Date())
        setSaveFailed(false)
      }
      if (event.key === INTERFACE_STYLE_STORAGE_KEY || event.key === null) {
        setInterfaceStyle(parseInterfaceStyle(event.key === null ? null : event.newValue))
        setStyleSaveFailed(false)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const updatePreferences = (next: ThemePreferences) => {
    if (!isValidThemePreferences(next)) return false
    setPreferences({ ...next })
    setNow(new Date())
    try {
      localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(next))
      setSaveFailed(false)
      return true
    } catch { setSaveFailed(true); return false }
  }

  const updateInterfaceStyle = (next: InterfaceStyle) => {
    if (!isInterfaceStyle(next)) return false
    setInterfaceStyle(next)
    try {
      localStorage.setItem(INTERFACE_STYLE_STORAGE_KEY, next)
      setStyleSaveFailed(false)
      return true
    } catch { setStyleSaveFailed(true); return false }
  }

  return <ThemeContext.Provider value={{ preferences, resolvedTheme, saveFailed, updatePreferences, interfaceStyle, styleSaveFailed, updateInterfaceStyle }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const theme = useContext(ThemeContext)
  if (!theme) throw new Error('ThemeProvider is required')
  return theme
}
