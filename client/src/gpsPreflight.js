import { useEffect, useState } from 'react'

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
// stalled past the tap-triggered timeout. GpsGateScreen's instructions cover both causes, with
// separate wording for iOS vs Android (see its own isIOS branch — Android's Settings steps vary
// too much by phone maker to give exact ones, so that path is deliberately more generic).
let status = 'unchecked'
let listeners = []
let requesting = false

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
  const stallTimer = setTimeout(() => {
    if (settled) return
    settled = true
    console.log('[gps] boot-time permissions.query() stalled — falling back to needs-gesture')
    setStatus('needs-gesture')
  }, 4000)

  navigator.permissions.query({ name: 'geolocation' })
    .then((result) => {
      if (settled) return
      settled = true
      clearTimeout(stallTimer)
      setStatus(result.state === 'granted' ? 'ok' : 'needs-gesture')
    })
    .catch(() => {
      if (settled) return
      settled = true
      clearTimeout(stallTimer)
      setStatus('needs-gesture')
    })
}

// The only thing in this file allowed to call getCurrentPosition — always from a real tap
// (GpsGateScreen's button, in either its "ask" or "blocked" state), never automatically. Safe to
// call repeatedly, it no-ops while already in flight.
export function requestGpsPermission() {
  if (requesting) return
  requesting = true
  setStatus('requesting')
  let settled = false

  // 10s, not 6s — this is a real tap now, with a real OS prompt either already answered or about
  // to appear, so there's no good-faith "might just be a slow cold fix" reading of a stall left;
  // it just needs enough slack for a genuinely slow GPS chip, not a snap decision.
  const stallTimer = setTimeout(() => {
    if (settled) return
    settled = true
    requesting = false
    console.log('[gps] tap-triggered request stalled — no fix, no error, within 10s — treating as blocked')
    setStatus('blocked')
  }, 10000)

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (settled) return
      settled = true
      requesting = false
      clearTimeout(stallTimer)
      console.log('[gps] tap-triggered request got a fix — geolocation works here')
      setStatus('ok')
    },
    (err) => {
      if (settled) return
      settled = true
      requesting = false
      clearTimeout(stallTimer)
      const denied = err.code === err.PERMISSION_DENIED
      console.log(`[gps] tap-triggered request failed: ${denied ? 'denied' : 'unavailable'}`)
      setStatus(denied ? 'blocked' : 'ok')
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
  )
}
