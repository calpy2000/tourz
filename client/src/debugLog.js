import { useEffect, useState } from 'react'
import { DEV_MODE } from './devMode.js'

// Diagnostic log for the GPS gate (GpsGateScreen) — reinstated 2026-10-18 to debug an iPhone
// "Enable location" -> Allow -> same screen -> Settings instructions -> back to start loop.
// Shown by DebugOverlay on the gate screen whenever DEV_MODE is on, or the page was opened with
// `?debug=1` (sticks in sessionStorage for the rest of the tab).
//
// Entries persist to sessionStorage, not just memory, so they survive a tab reload — whether
// iOS reloads the tab (e.g. after a Settings change) is one of the things this needs to show.
// Each entry carries the boot number it was logged in, so a reload is visible as the number
// ticking up mid-log.
const STORE_KEY = 'tourzDebugLog'
const BOOT_KEY = 'tourzDebugBoot'
const MAX_ENTRIES = 200

try {
  if (new URLSearchParams(window.location.search).get('debug') === '1') {
    sessionStorage.setItem('tourzDebug', '1')
  }
} catch {
  // sessionStorage can throw in some private/in-app contexts — the in-memory log still works.
}

// explicitOnly: true ignores DEV_MODE — used for the app-wide copy of the panel (App.jsx), which
// should only appear when someone deliberately opened the app with ?debug=1.
export function isDebugMode({ explicitOnly = false } = {}) {
  if (DEV_MODE && !explicitOnly) return true
  try {
    return sessionStorage.getItem('tourzDebug') === '1'
  } catch {
    return false
  }
}

function load() {
  try {
    return JSON.parse(sessionStorage.getItem(STORE_KEY)) || []
  } catch {
    return []
  }
}

let boot = 1
try {
  boot = Number(sessionStorage.getItem(BOOT_KEY) || 0) + 1
  sessionStorage.setItem(BOOT_KEY, String(boot))
} catch {
  // keep boot = 1
}

let entries = load()
let listeners = []

export function logDebug(label, data) {
  const now = new Date()
  const time = now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0')
  // ms since this page load — lines up with the per-tap "ms" fields logged by gpsPreflight.js.
  const t = Math.round(performance.now())
  entries = [...entries, { boot, time, t, label, data }].slice(-MAX_ENTRIES)
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(entries))
  } catch {
    // quota/unavailable — keep the in-memory copy
  }
  console.log(`[debug] #${boot} ${time} +${t}ms ${label}`, data ?? '')
  listeners.forEach((fn) => fn(entries))
}

export function clearDebugLog() {
  entries = []
  try {
    sessionStorage.removeItem(STORE_KEY)
  } catch {
    // ignore
  }
  listeners.forEach((fn) => fn(entries))
}

export function useDebugLog() {
  const [state, setState] = useState(entries)
  useEffect(() => {
    listeners.push(setState)
    setState(entries)
    return () => {
      listeners = listeners.filter((fn) => fn !== setState)
    }
  }, [])
  return state
}

// Page-lifecycle events, logged from the moment this module loads — these are what reveal a
// trip out to the Settings app and back, and whether the tab was restored or fully reloaded.
export function logBootContext() {
  const nav = performance.getEntriesByType?.('navigation')?.[0]
  let triedEscape = null
  try {
    triedEscape = sessionStorage.getItem('triedSafariEscape')
  } catch {
    // ignore
  }
  logDebug('BOOT', {
    boot,
    navType: nav?.type ?? 'unknown',
    url: window.location.pathname + window.location.search,
    ua: navigator.userAgent,
    standalone: Boolean(window.navigator.standalone) || window.matchMedia?.('(display-mode: standalone)').matches,
    inAppUA: /WhatsApp|FBAN|FBAV|Instagram|Line\//.test(navigator.userAgent),
    triedSafariEscape: triedEscape,
    visibility: document.visibilityState,
    hasGeo: 'geolocation' in navigator,
    hasPermissionsApi: Boolean(navigator.permissions?.query),
  })
  document.addEventListener('visibilitychange', () => logDebug('visibility', document.visibilityState))
  window.addEventListener('pageshow', (e) => logDebug('pageshow', { persisted: e.persisted }))
  window.addEventListener('pagehide', (e) => logDebug('pagehide', { persisted: e.persisted }))
}
