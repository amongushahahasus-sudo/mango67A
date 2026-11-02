import { useEffect, useRef, useState } from 'react'
import { Check, Clock3, Moon, Settings2, Sun } from 'lucide-react'
import { isValidThemePreferences, type ThemeMode } from '../lib/themePreferences'
import { useTheme } from '../theme/ThemeProvider'
import './ThemeControls.css'

const modes = [
  { value: 'light', label: 'ライト', icon: Sun },
  { value: 'dark', label: 'ダーク', icon: Moon },
  { value: 'auto', label: '時間帯で自動', icon: Clock3 },
] as const

function ModeButtons({ onSelect }: { onSelect?: () => void }) {
  const { preferences, updatePreferences } = useTheme()
  const choose = (mode: ThemeMode) => { if (updatePreferences({ ...preferences, mode })) onSelect?.() }
  return <div className="theme-mode-buttons" role="group" aria-label="表示モードを選択">{modes.map(({ value, label, icon: Icon }) => <button type="button" key={value} aria-pressed={preferences.mode === value} onClick={() => choose(value)}><Icon size={17} /><span>{label}</span>{preferences.mode === value && <Check size={13} className="theme-mode-check" />}</button>)}</div>
}

function SaveWarning() {
  const { saveFailed } = useTheme()
  return saveFailed ? <p className="theme-save-warning" role="alert">このブラウザでは配色設定を保存できません。再読み込みすると元に戻ります。</p> : null
}

export function ThemeSwitcher({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { preferences, resolvedTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const Icon = preferences.mode === 'auto' ? Clock3 : resolvedTheme === 'dark' ? Moon : Sun
  const current = resolvedTheme === 'dark' ? 'ダーク' : 'ライト'
  const close = () => { setOpen(false); trigger.current?.focus() }

  useEffect(() => {
    if (!open) return
    popover.current?.querySelector('button')?.focus()
    const onPointer = (event: PointerEvent) => { if (!wrapper.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus() } }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey) }
  }, [open])

  return <div className="theme-switcher" ref={wrapper}>
    <button type="button" className="theme-trigger" ref={trigger} title="表示モードを変更" aria-label={`表示モード（${preferences.mode === 'auto' ? '自動・現在' : '現在'}${current}）`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}><Icon size={17} /></button>
    {open && <div className="theme-popover" ref={popover} role="dialog" aria-label="表示モード">
      <strong>表示モード</strong>
      <ModeButtons onSelect={close} />
      <p>{preferences.mode === 'auto' ? `自動切り替え中 · 現在は${current}` : `${current}モードで表示中`}</p>
      <SaveWarning />
      <button type="button" className="theme-schedule-link" onClick={() => { close(); onOpenSettings() }}><Settings2 size={14} />切り替え時刻を設定</button>
    </div>}
  </div>
}

export function ThemeSettings() {
  const { preferences, resolvedTheme, updatePreferences } = useTheme()
  const [lightStart, setLightStart] = useState(preferences.lightStart)
  const [darkStart, setDarkStart] = useState(preferences.darkStart)
  useEffect(() => { setLightStart(preferences.lightStart); setDarkStart(preferences.darkStart) }, [preferences.mode, preferences.lightStart, preferences.darkStart])
  const valid = isValidThemePreferences({ ...preferences, lightStart, darkStart })
  const setTime = (field: 'lightStart' | 'darkStart', value: string) => {
    if (field === 'lightStart') setLightStart(value)
    else setDarkStart(value)
    const next = { ...preferences, lightStart, darkStart, [field]: value }
    if (isValidThemePreferences(next)) updatePreferences(next)
  }

  return <section className="theme-settings" aria-label="配色設定">
    <h3>表示モード</h3>
    <p className="theme-settings-description">気分に合わせて選んだり、時間帯で自動的に切り替えられます。</p>
    <ModeButtons />
    {preferences.mode === 'auto' && <div className="theme-schedule">
      <div className="theme-time-fields">
        <label><span><Sun size={14} />ライトに切り替える時刻</span><input type="time" aria-label="ライトに切り替える時刻" value={lightStart} onChange={event => setTime('lightStart', event.target.value)} required aria-invalid={!valid} aria-describedby="theme-schedule-note" /></label>
        <label><span><Moon size={14} />ダークに切り替える時刻</span><input type="time" aria-label="ダークに切り替える時刻" value={darkStart} onChange={event => setTime('darkStart', event.target.value)} required aria-invalid={!valid} aria-describedby="theme-schedule-note" /></label>
      </div>
      {!valid && <p className="theme-save-warning" role="alert">異なる2つの時刻を入力してください。直前の設定で切り替えを続けます。</p>}
      <p id="theme-schedule-note" className="theme-schedule-note">この端末の時刻で切り替わります。現在は{resolvedTheme === 'light' ? 'ライト' : 'ダーク'}モードです。</p>
    </div>}
    <p className="theme-settings-footnote">配色と切り替え時刻は、この端末のブラウザに保存されます。</p>
    <SaveWarning />
  </section>
}
