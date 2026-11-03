import { useEffect, useState } from 'react'

function greetingNow() {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 11) return 'おはようございます。'
  if (hour >= 11 && hour < 18) return 'こんにちは。'
  return 'こんばんは。'
}

export default function HomeGreeting() {
  const [greeting, setGreeting] = useState(greetingNow)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      setGreeting(greetingNow())
      timer = setTimeout(refresh, 60_000 - Date.now() % 60_000)
    }
    const onVisibility = () => { if (document.visibilityState === 'visible') refresh() }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return <>{greeting}</>
}
