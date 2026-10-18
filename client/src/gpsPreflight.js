import { useEffect, useState } from 'react'
import { logDebug } from './debugLog.js'
import { startSharedWatch } from './geoWatch.js'

const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : ''
export const isIOS = /iPhone|iPad|iPod/.test(ua)
const isAndroid = /Android/.test(ua)

// Status model — rewritten 2026-10-07 after a confirmed live repro: a device-wide location
// block (iOS Settings > Privacy & Security > Location Services > Safari Websites: Never) called
// automatically at boot, with no tap behind it, just hangs forever — neither a fix nor an error
// ever arrives. The old model assumed any such call would reliably resolve one way or the other,
// and only treated an explicit PERMISSION_DENIED as blocking; that assumption is false for an
// automatic, gesture-less call specifically (per-site "Don't Allow" does still error reliably —
// it's the no-user-gesture case that's unreliable on iOS Safari). The fix is to never call
// getCurrentPosition automatically again — only from a real tap (see requestGpsPermission below,
// called from GpsGateScreen's button) — and to treat a stall *after* a real tap as a genuine
// block, since there's no good-faith reason left for it not to resolve.
//
// 'unchecked'/'checking': boot-time navigator.permissions.query() read in flight — fast (no OS
// prompt involved), just reading the already-decided state if there is one.
// 'ok': either not applicable (desktop — no OS Settings app to send a desktop user to — or no
// geolocation API), or permissions.query() already reported 'granted'. This is also where a
// successful requestGpsPermission() call ends up.
// 'needs-gesture': permissions.query() reported 'prompt'/'denied', or threw/is unsupported (its
// 'denied' state is itself documented as unreliable on iOS Safari — it can under-report, never
// over-report — so this is also the fallback for anything it can't confidently call 'granted').
// Nothing has asked the OS for anything yet; GpsGateScreen shows a single explanatory button.
// 'requesting': that button (or its "check again" twin in the blocked state) was just tapped —
// a real getCurrentPosition() call, with a real user gesture behind it, is in flight.
// 'blocked': requestGpsPermission() got back an explicit PERMISSION_DENIED, or its own call
// stalled past the tap-triggered timeout (a fix arriving after that still moves on to 'ok'). GpsGateScreen's instructions cover both causes, with
// separate wording for iOS vs Android (see its own isIOS branch — Android's Settings steps vary
// too much by phone maker to give exact ones, so that path is deliberately more generic).
let status = 'unchecked'
let listeners = []
let requesting = false

// Set once a tap-triggered request proves geolocation works in this tab, so a reload of the same
// tab skips the gate. Added 2026-10-18 after a live iPhone log: with Safari Websites on "Ask Next
// Time", permissions.query() never reports 'granted', so any reload (e.g. api.js's hard reload on
// a stale-session 401, fired ~0.4s after the gate had just passed) dropped the player straight
// back onto the ask screen, in a loop. sessionStorage, not localStorage: a new tab or a later
// visit still goes through the gate once.
const CONFIRMED_KEY = 'tourzGpsConfirmed'

function markConfirmed() {
  // Keep location continuously in use from this first Allow onwards — see geoWatch.js.
  startSharedWatch('gate pass')
  try {
    sessionStorage.setItem(CONFIRMED_KEY, '1')
  } catch {
    // unavailable — the gate just shows again after a reload, as before
  }
}

function isConfirmed() {
  try {
    return sessionStorage.getItem(CONFIRMED_KEY) === '1'
  } catch {
    return false
  }
}

function setStatus(next) {
  logDebug('status', `${status} -> ${next}`)
  status = next
  listeners.forEach((fn) => fn(status))
}

export function useGpsPreflightStatus() {
  const [s, setS] = useState(status)
  useEffect(() => {
    listeners.push(setS)
    // initGpsCheck() starts before React mounts, so its result can land between this hook's
    // first render (which captured the old status) and this effect subscribing — a fast
    // permissions.query() (e.g. a hard refresh of an already-granted tab) did exactly that and
    // left the app on the loading spinner forever. Re-read once now that we're listening.
    setS(status)
    return () => {
      listeners = listeners.filter((fn) => fn !== setS)
    }
  }, [])
  return s
}

// Runs once at app startup, right after the Safari-escape attempt (escapeInAppBrowser.js) gives
// up on a handoff — a read-only, promptless check, safe to run with no user gesture. Only ever
// used to shortcut the *good* case (skip GpsGateScreen's button entirely for a player who's
// already granted access, e.g. reopening the tab mid-tour) — never trusted to conclude "blocked"
// on its own, since iOS Safari's implementation of this API is documented as unreliable for that.
export function initGpsCheck() {
  if (!(isIOS || isAndroid) || !('geolocation' in navigator)) {
    setStatus('ok')
    return
  }

  if (isConfirmed()) {
    logDebug('gps already confirmed in this tab — skipping gate')
    setStatus('ok')
    return
  }

  setStatus('checking')

  if (!navigator.permissions?.query) {
    setStatus('needs-gesture')
    return
  }

  // This is documented above as a fast, promptless read — but that's only true when it actually
  // resolves. A device-wide location block can apparently wedge this query the same way it wedges
  // a gesture-less getCurrentPosition() call (see the big comment above), and unlike
  // requestGpsPermission()'s tap-triggered call, nothing here was guarding against that — so a
  // stall here used to hard-block the entire app (see App.jsx) forever, even for a player
  // mid-tour who'd already granted access before this gate existed. Falls back to the normal
  // "nothing's been decided yet" state so the player at least gets the tap-driven ask screen
  // instead of an infinite spinner.
  let settled = false
  const queryStart = performance.now()
  logDebug('permissions.query start')
  const stallTimer = setTimeout(() => {
    if (settled) return
    settled = true
    logDebug('permissions.query STALLED (4s)')
    console.log('[gps] boot-time permissions.query() stalled — falling back to needs-gesture')
    setStatus('needs-gesture')
  }, 4000)

  navigator.permissions.query({ name: 'geolocation' })
    .then((result) => {
      logDebug(`permissions.query result${settled ? ' (LATE, ignored)' : ''}`, { state: result.state, ms: Math.round(performance.now() - queryStart) })
      try {
        result.onchange = () => logDebug('permission state changed', result.state)
      } catch {
        // ignore
      }
      if (settled) return
      settled = true
      clearTimeout(stallTimer)
      setStatus(result.state === 'granted' ? 'ok' : 'needs-gesture')
    })
    .catch((err) => {
      logDebug('permissions.query threw', String(err?.message || err))
      if (settled) return
      settled = true
      clearTimeout(stallTimer)
      setStatus('needs-gesture')
    })
}

// The only thing in this file allowed to call getCurrentPosition — always from a real tap
// (GpsGateScreen's button, in either its "ask" or "blocked" state), never automatically. Safe to
// call repeatedly, it no-ops while already in flight.
export function requestGpsPermission(source = 'tap') {
  if (requesting) {
    logDebug('request ignored (already in flight)', source)
    return
  }
  const tapAt = performance.now()
  const since = () => Math.round(performance.now() - tapAt)
  logDebug('getCurrentPosition request', source)
  requesting = true
  setStatus('requesting')
  let settled = false

  // 30s, and the clock includes however long the player takes to read and answer the iOS
  // prompt(s) — with Safari Websites on "Ask Next Time" there can be two in a row. A 10s timer
  // here fired mid-prompt on a live iPhone (2026-10-18) and the real fix, at 38s, was thrown
  // away. Even now, a stall only switches the screen to the Settings instructions — a position
  // that arrives afterwards still lets the player through (see the success callback).
  const stallTimer = setTimeout(() => {
    if (settled) return
    settled = true
    requesting = false
    logDebug('request STALLED (30s) -> blocked (a late fix will still pass)', { ms: since() })
    console.log('[gps] tap-triggered request stalled — no fix, no error, within 30s — treating as blocked')
    setStatus('blocked')
  }, 30000)

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      logDebug(`got position${settled ? ' (late)' : ''}`, { ms: since(), accuracyM: Math.round(pos.coords.accuracy) })
      markConfirmed()
      // A late fix still wins — it's proof location works, whatever the stall timer decided.
      if (settled) {
        if (status !== 'ok') setStatus('ok')
        return
      }
      settled = true
      requesting = false
      clearTimeout(stallTimer)
      console.log('[gps] tap-triggered request got a fix — geolocation works here')
      setStatus('ok')
    },
    (err) => {
      logDebug(`position error${settled ? ' (LATE, ignored)' : ''}`, { ms: since(), code: err.code, message: err.message })
      if (settled) return
      settled = true
      requesting = false
      clearTimeout(stallTimer)
      const denied = err.code === err.PERMISSION_DENIED
      if (!denied) markConfirmed()
      console.log(`[gps] tap-triggered request failed: ${denied ? 'denied' : 'unavailable'}`)
      setStatus(denied ? 'blocked' : 'ok')
    },
    // Coarse and cache-friendly on purpose: this call only has to prove permission was granted,
    // not locate anyone precisely — useGeolocation's own watchPosition stays high-accuracy for
    // the map. A precise cold fix took 38s indoors in the 2026-10-18 log; a coarse one is near
    // instant.
    { enableHighAccuracy: false, timeout: 30000, maximumAge: 60000 },
  )
}
