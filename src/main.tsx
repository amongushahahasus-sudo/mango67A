import React from 'react'
import ReactDOM from 'react-dom/client'
import AccountWorkspace from './auth/AccountWorkspace'
import { AuthProvider } from './auth/AuthProvider'
import { initializeTheme, ThemeProvider } from './theme/ThemeProvider'
import './styles.css'
import './theme/dark.css'

initializeTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><ThemeProvider><AuthProvider><AccountWorkspace /></AuthProvider></ThemeProvider></React.StrictMode>,
)
