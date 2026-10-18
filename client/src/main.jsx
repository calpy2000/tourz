import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
// Self-hosted fonts (latin subset only — covers English and the French accents in Port Louis
// content). Same weights the Google Fonts link loaded. Same-origin also suits CertificatePage's
// html-to-image font embedding, which needed a crossorigin workaround with Google's stylesheet.
import '@fontsource/quicksand/latin-400.css'
import '@fontsource/quicksand/latin-500.css'
import '@fontsource/quicksand/latin-700.css'
import '@fontsource/cormorant-garamond/latin-600.css'
import '@fontsource/cormorant-garamond/latin-600-italic.css'
import './index.css'
import App from './App.jsx'
import { tryEscapeToSafari } from './escapeInAppBrowser.js'
import { initGpsCheck } from './gpsPreflight.js'
import { logBootContext, logDebug } from './debugLog.js'

logBootContext()

tryEscapeToSafari().then((handedOff) => {
  logDebug('safari escape', { handedOff })
  // If the handoff worked, this tab is being abandoned for a fresh Safari tab — that fresh
  // load will run its own check (and won't match the in-app-browser UA check anyway), so
  // there's nothing useful to check here.
  if (!handedOff) initGpsCheck()
})

// Service worker: keeps the app itself (and, via offline/contentCache.js, the tour's photos and
// narration) on the phone so it opens and plays with no signal — see sw-template.js. Built
// versions only; the dev server has no sw.js. Never reloads the page on update (a reload makes
// iOS ask for location again) — a new version simply takes over on the next open.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => logDebug('sw register failed', String(err)))
  })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
