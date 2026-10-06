import { useEffect, useState } from 'react'
import { logDebug } from './debugLog.js'

const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : ''
const isIOS = /iPhone|iPad|iPod/.test(ua)

// 'unchecked': the probe hasn't run yet (or isn't applicable — not iOS, or no geolocation API).
// 'checking': probe in flight.
// 'ok': got a real fix, or merely stalled with no error — not evidence of a permission block
// (see useGeolocation.js's own stall-kick, which recovers that case once the player reaches Map
// view) — so this never blocks the app on a stall alone.
// 'denied': an explicit PERMISSION_DENIED from the OS. This is the only signal available for a
// phone-wide "Settings > Privacy & Security > Location Services > Safari Websites: Never" block
// — an ordinary per-site "Don't Allow" produces the exact same error code, with no way to tell
// the two apart from JS. GpsBlockedScreen's instructions cover both causes.
let status = 'unchecked'
let listeners = []
let checking = false

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

// Runs at app startup, right after the Safari-escape attempt (escapeInAppBrowser.js) gives up on
// a handoff — so the player finds out whether location is actually going to work *before*
// registration/onboarding, instead of several screens and up to 10s later at Home > Map view.
// Also re-run (same function) when the player comes back from the Settings app, or taps "check
// again" on GpsBlockedScreen — safe to call repeatedly, it no-ops while already in flight.
//
// Uses a manual stall timer rather than trusting getCurrentPosition's own `timeout` option,
// because that option doesn't reliably fire either when the permission request itself never
// resolves inside a broken in-app browser — same reason useGeolocation.js can't trust it.
export function runGpsPreflight() {
  if (checking) return
  logDebug('preflight:detect', { ua, isIOS, hasGeolocation: 'geolocation' in navigator })

  if (!isIOS || !('geolocation' in navigator)) {
    setStatus('ok')
    logDebug('preflight:skip', { reason: 'not applicable (not iOS, or no geolocation API)' })
    return
  }

  checking = true
  setStatus('checking')
  logDebug('preflight:checking')
  let settled = false

  const stallTimer = setTimeout(() => {
    if (settled) return
    settled = true
    checking = false
    console.log('[gps] preflight stalled — no fix, no error, within 6s (not treated as blocked)')
    logDebug('preflight:stalled')
    setStatus('ok')
  }, 6000)

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (settled) return
      settled = true
      checking = false
      clearTimeout(stallTimer)
      console.log('[gps] preflight got a fix — geolocation works here')
      logDebug('preflight:ok', { lat: pos.coords.latitude, lng: pos.coords.longitude })
      setStatus('ok')
    },
    (err) => {
      if (settled) return
      settled = true
      checking = false
      clearTimeout(stallTimer)
      const denied = err.code === err.PERMISSION_DENIED
      console.log(`[gps] preflight failed: ${denied ? 'denied' : 'unavailable'}`)
      logDebug('preflight:failed', { code: err.code, message: err.message })
      setStatus(denied ? 'denied' : 'ok')
    },
    { enableHighAccuracy: true, timeout: 6000, maximumAge: 0 },
  )
}
