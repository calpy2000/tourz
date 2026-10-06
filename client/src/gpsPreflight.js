import { useEffect, useState } from 'react'
import { logDebug } from './debugLog.js'

const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : ''
const isIOS = /iPhone|iPad|iPod/.test(ua)
const isInAppBrowser = /WhatsApp|FBAN|FBAV|Instagram|Line\//.test(ua)

// 'skipped': not an in-app browser, nothing to check (the vast majority of visits).
// 'checking': probe in flight.
// 'ok': got a real fix — geolocation works here.
// 'blocked': denied, or stalled with neither a fix nor an error (the WhatsApp symptom).
let status = 'skipped'
let listeners = []

function setStatus(next) {
  status = next
  listeners.forEach((fn) => fn(status))
}

export function useGpsPreflightStatus() {
  const [s, setS] = useState(status)
  useEffect(() => {
    listeners.push(setS)
    return () => {
      listeners = listeners.filter((fn) => fn !== setS)
    }
  }, [])
  return s
}

// Runs once at app startup, right after the Safari-escape attempt (escapeInAppBrowser.js)
// gives up on a handoff — so the player finds out whether live GPS is going to work *before*
// registration/onboarding, instead of 5+ screens and up to 10s later at Home > Map view (see
// the "stalled" state in useGeolocation.js, which stays as a second, independent fallback in
// case this preflight is skipped or wrong for some reason).
//
// Uses a manual stall timer rather than trusting getCurrentPosition's own `timeout` option,
// because that option doesn't reliably fire either when the permission request itself never
// resolves inside a broken in-app browser — same reason useGeolocation.js can't trust it.
export function runGpsPreflight() {
  logDebug('preflight:detect', { ua, isIOS, isInAppBrowser, hasGeolocation: 'geolocation' in navigator })

  if (!isIOS || !isInAppBrowser || !('geolocation' in navigator)) {
    setStatus('skipped')
    logDebug('preflight:skip', { reason: 'not applicable (not iOS/in-app-browser, or no geolocation API)' })
    return
  }

  setStatus('checking')
  logDebug('preflight:checking')
  let settled = false

  const stallTimer = setTimeout(() => {
    if (settled) return
    settled = true
    console.log('[gps] preflight stalled — no fix, no error, within 6s')
    logDebug('preflight:stalled')
    setStatus('blocked')
  }, 6000)

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (settled) return
      settled = true
      clearTimeout(stallTimer)
      console.log('[gps] preflight got a fix — geolocation works here')
      logDebug('preflight:ok', { lat: pos.coords.latitude, lng: pos.coords.longitude })
      setStatus('ok')
    },
    (err) => {
      if (settled) return
      settled = true
      clearTimeout(stallTimer)
      console.log(`[gps] preflight failed: ${err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable'}`)
      logDebug('preflight:failed', { code: err.code, message: err.message })
      setStatus('blocked')
    },
    { enableHighAccuracy: true, timeout: 6000, maximumAge: 0 },
  )
}
