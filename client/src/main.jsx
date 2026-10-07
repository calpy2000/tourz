import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import { tryEscapeToSafari } from './escapeInAppBrowser.js'
import { initGpsCheck } from './gpsPreflight.js'
import { logDebug } from './debugLog.js'

logDebug('app:boot', { url: window.location.href, ua: navigator.userAgent })

tryEscapeToSafari().then((handedOff) => {
  // If the handoff worked, this tab is being abandoned for a fresh Safari tab — that fresh
  // load will run its own check (and won't match the in-app-browser UA check anyway), so
  // there's nothing useful to check here.
  if (!handedOff) initGpsCheck()
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
