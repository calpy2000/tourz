import { useEffect, useState } from 'react'

// TEMPORARY — built to diagnose the WhatsApp in-app-browser GPS bug on a real device without
// needing a USB-attached debugger. Remove this whole file + DebugOverlay.jsx + their call sites
// once that investigation is done (see project_whatsapp_inapp_browser_gps_fix memory).
//
// Gated on a `?debug=1` query param rather than always-on, so ordinary players never see raw UA
// strings/GPS coordinates on screen. Sticks in sessionStorage once seen so it survives the
// x-safari-https:// handoff and any later navigation within the same tab/session.
const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
if (params?.get('debug') === '1') {
  sessionStorage.setItem('tourzDebug', '1')
}

export function isDebugMode() {
  try {
    return sessionStorage.getItem('tourzDebug') === '1'
  } catch {
    return false
  }
}

let entries = []
let listeners = []

function notify() {
  listeners.forEach((fn) => fn(entries))
}

export function logDebug(label, data) {
  const time = new Date().toISOString().slice(11, 23)
  entries = [...entries, { time, label, data }]
  if (isDebugMode()) console.log(`[debug] ${time} ${label}`, data ?? '')
  notify()
}

export function useDebugLog() {
  const [state, setState] = useState(entries)
  useEffect(() => {
    listeners.push(setState)
    return () => {
      listeners = listeners.filter((fn) => fn !== setState)
    }
  }, [])
  return state
}
