import React from 'react'
import ReactDOM from 'react-dom/client'
import AccountWorkspace from './auth/AccountWorkspace'
import { AuthProvider } from './auth/AuthProvider'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><AuthProvider><AccountWorkspace /></AuthProvider></React.StrictMode>,
)
