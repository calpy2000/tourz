import { logDebug } from './debugLog.js'

// One app-wide watchPosition, started the moment the GPS gate's tap-triggered request succeeds
// and then left running for the rest of the page's life. Added 2026-10-18 after a live iPhone
// report (Safari Websites on "Ask Next Time"): the player tapped Allow on the gate, read through
// the instructions with nothing using location, then got a second native prompt when MapView
// started its own fresh watch. Keeping location continuously in use from that first Allow means
// there's never a new request for iOS to ask about. useGeolocation.js reads from here instead of
// owning a watch itself; its `enabled` flag now only pauses React updates, not the watch.
let watchId = null
let last = { location: null, error: null }
let subscribers = []

// kind: 'fix' | 'error' — an error keeps the last good location in `last`, but subscribers are
// told it was an error so they don't treat the old position as a fresh fix.
function publish(kind, next) {
  last = { ...last, ...next }
  subscribers.forEach((fn) => fn(kind, last))
}

export function startSharedWatch(source) {
  if (watchId !== null || !('geolocation' in navigator)) return
  logDebug('shared watch start', source)
  watchId = navigator.geolocation.watchPosition(
    (pos) => publish('fix', { location: { lat: pos.coords.latitude, lng: pos.coords.longitude }, error: null, at: Date.now() }),
    (err) => {
      logDebug('shared watch error', { code: err.code, message: err.message })
      publish('error', { error: err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable' })
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
  )
}

export function getSharedFix() {
  return last
}

export function subscribeSharedFix(fn) {
  subscribers.push(fn)
  return () => {
    subscribers = subscribers.filter((s) => s !== fn)
  }
}
