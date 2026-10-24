import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/theme.css'
import { startDomTranslation } from './lib/i18n'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
startDomTranslation()

// Installable app (PWA): the service worker only adds an offline page; production builds only, so dev reloads stay plain
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}) })
}
