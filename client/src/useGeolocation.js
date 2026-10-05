import { useEffect, useRef, useState } from 'react'

// Tracks the browser's live GPS position so the map's "here" marker can follow the player as
// they actually walk, instead of the old fixed-offset placeholder. Needs HTTPS (the deployed
// Cloudflare domain has it) and the player granting the location permission prompt. Returns
// location: null until the first fix arrives, or permanently if unsupported/denied — callers
// fall back to something else (see placeholderHereLocation in MapView.jsx) rather than this hook
// making that call itself.
export function useGeolocation() {
  const [location, setLocation] = useState(null)
  const [error, setError] = useState(null)
  // True right after the tab comes back to the foreground, until a fresh fix lands — mobile
  // browsers suspend watchPosition callbacks while backgrounded/screen-locked (see feedback
  // memory on the 10-min-idle stall), so without this the marker would keep confidently showing
  // wherever the player was several minutes ago. Callers can use it to grey the marker out
  // instead of trusting a fix that's actually gone stale.
  const [reacquiring, setReacquiring] = useState(false)
  // True once 10s have passed with no fix and no explicit error either. Covers a real case the
  // plain `error` state can't: some in-app browsers (e.g. links opened inside WhatsApp's embedded
  // viewer rather than full Safari) scope the permission prompt to the host app, and if the host
  // app itself was never granted location access, watchPosition's callbacks just never fire at
  // all — neither onFix nor onFail — instead of erroring out with PERMISSION_DENIED.
  const [stalled, setStalled] = useState(false)
  const watchIdRef = useRef(null)

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setError('unsupported')
      return
    }

    const stallTimer = setTimeout(() => setStalled(true), 10000)

    function onFix(pos) {
      setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude })
      setError(null)
      setReacquiring(false)
      setStalled(false)
      clearTimeout(stallTimer)
    }
    function onFail(err) {
      setError(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable')
      clearTimeout(stallTimer)
    }

    watchIdRef.current = navigator.geolocation.watchPosition(onFix, onFail, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15000,
    })

    // On resume, force a one-shot fix (maximumAge: 0, so the OS can't just hand back the same
    // stale cached position) rather than waiting for the watch's next natural callback, which can
    // be a while if the GPS chip needs to reacquire from cold.
    function onVisible() {
      if (document.visibilityState !== 'visible') return
      setReacquiring(true)
      navigator.geolocation.getCurrentPosition(onFix, () => setReacquiring(false), {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 15000,
      })
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      navigator.geolocation.clearWatch(watchIdRef.current)
      document.removeEventListener('visibilitychange', onVisible)
      clearTimeout(stallTimer)
    }
  }, [])

  return { location, error, reacquiring, stalled }
}
