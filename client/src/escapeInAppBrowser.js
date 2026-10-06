import { logDebug } from './debugLog.js'

// Best-effort attempt to bounce a player out of an iOS in-app browser (WhatsApp,
// Facebook/Messenger, Instagram, Line) and into real Safari before the app even mounts.
// These embedded webviews scope the geolocation permission prompt to the host app, not the
// page, so if the host app was never granted location access, watchPosition's callbacks
// silently never fire — see the "stalled" state in useGeolocation.js. There is no documented,
// reliable fix for this: a JS-triggered navigation isn't a user-initiated tap, so iOS won't
// let a Universal Link intercept it either. x-safari-https:// is an undocumented private
// scheme some WebKit-based in-app browsers honor anyway, forcing the handoff to Safari
// specifically. It can stop working on any iOS update without notice — the gps-help-banner
// in MapView.jsx (triggered by the "stalled" state) and the gpsPreflight check (see
// gpsPreflight.js) are the real fallbacks if this does nothing.
//
// Invoking an unregistered/private URL scheme via location.href doesn't unload the current
// page the way a normal navigation does — if iOS doesn't recognize it, nothing visibly
// happens and this tab just keeps running. That's what lets us detect success: a *successful*
// handoff backgrounds this tab (Safari opens on top of it), which fires 'visibilitychange'.
// Resolves true if that happened within the check window, false otherwise (including when no
// attempt was relevant/needed at all) — callers use this to decide whether it's worth running
// any further checks in a tab that's likely about to be abandoned.
export function tryEscapeToSafari() {
  const ua = navigator.userAgent || ''
  const isIOS = /iPhone|iPad|iPod/.test(ua)
  const isInAppBrowser = /WhatsApp|FBAN|FBAV|Instagram|Line\//.test(ua)

  logDebug('escape:detect', { ua, isIOS, isInAppBrowser, protocol: window.location.protocol })

  if (window.location.protocol !== 'https:' || !isIOS || !isInAppBrowser) {
    logDebug('escape:skip', { reason: 'not applicable (not https/iOS/in-app-browser)' })
    return Promise.resolve(false)
  }

  // Only try once per tab so a failed attempt (we're still here, in the same in-app
  // browser) doesn't retry on every reload.
  if (sessionStorage.getItem('triedSafariEscape')) {
    console.log('[gps] Safari escape already attempted this tab — skipping re-attempt')
    logDebug('escape:skip', { reason: 'already attempted this tab' })
    return Promise.resolve(false)
  }
  sessionStorage.setItem('triedSafariEscape', '1')

  return new Promise((resolve) => {
    let handedOff = false
    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') handedOff = true
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    console.log('[gps] attempting x-safari-https:// handoff')
    logDebug('escape:attempting')
    window.location.href = window.location.href.replace(/^https:/, 'x-safari-https:')

    setTimeout(() => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      console.log(`[gps] handoff ${handedOff ? 'appears to have succeeded (tab went hidden)' : 'did not happen — still in the in-app browser'}`)
      logDebug('escape:result', { handedOff })
      resolve(handedOff)
    }, 1500)
  })
}
