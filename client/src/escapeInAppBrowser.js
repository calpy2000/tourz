// Best-effort attempt to bounce a player out of an iOS in-app browser (WhatsApp,
// Facebook/Messenger, Instagram, Line) and into real Safari before the app even mounts.
// These embedded webviews scope the geolocation permission prompt to the host app, not the
// page, so if the host app was never granted location access, watchPosition's callbacks
// silently never fire — see the "stalled" state in useGeolocation.js. There is no documented,
// reliable fix for this: a JS-triggered navigation isn't a user-initiated tap, so iOS won't
// let a Universal Link intercept it either. x-safari-https:// is an undocumented private
// scheme some WebKit-based in-app browsers honor anyway, forcing the handoff to Safari
// specifically. It can stop working on any iOS update without notice — the gps-help-banner
// in MapView.jsx (triggered by the "stalled" state) is the real fallback if this does nothing.
export function tryEscapeToSafari() {
  if (window.location.protocol !== 'https:') return

  const ua = navigator.userAgent || ''
  const isIOS = /iPhone|iPad|iPod/.test(ua)
  const isInAppBrowser = /WhatsApp|FBAN|FBAV|Instagram|Line\//.test(ua)
  if (!isIOS || !isInAppBrowser) return

  // Only try once per tab so a failed attempt (we're still here, in the same in-app
  // browser) doesn't retry on every reload.
  if (sessionStorage.getItem('triedSafariEscape')) return
  sessionStorage.setItem('triedSafariEscape', '1')

  window.location.href = window.location.href.replace(/^https:/, 'x-safari-https:')
}
