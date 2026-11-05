export type InterfaceStyle = 'standard' | 'glass'

export const INTERFACE_STYLE_STORAGE_KEY = 'mango-fx-interface-style-v1'
export const DEFAULT_INTERFACE_STYLE: InterfaceStyle = 'standard'

export function isInterfaceStyle(value: unknown): value is InterfaceStyle {
  return value === 'standard' || value === 'glass'
}

export function parseInterfaceStyle(raw: string | null): InterfaceStyle {
  return isInterfaceStyle(raw) ? raw : DEFAULT_INTERFACE_STYLE
}

/** Design preferences stay separate from color schedules and practice data. */
export function readInterfaceStyle(storage?: Pick<Storage, 'getItem'>): InterfaceStyle {
  try {
    const source = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage)
    return parseInterfaceStyle(source?.getItem(INTERFACE_STYLE_STORAGE_KEY) ?? null)
  } catch {
    return DEFAULT_INTERFACE_STYLE
  }
}
