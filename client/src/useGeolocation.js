import { useEffect, useState } from 'react'

// Tracks the browser's live GPS position so the map's "here" marker can follow the player as
// they actually walk, instead of the old fixed-offset placeholder. Needs HTTPS (the deployed
// Cloudflare domain has it) and the player granting the location permission prompt. Returns
// location: null until the first fix arrives, or permanently if unsupported/denied — callers
// fall back to something else (see placeholderHereLocation in MapView.jsx) rather than this hook
// making that call itself.
export function useGeolocation() {
  const [location, setLocation] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setError('unsupported')
      return
    }

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        setError(null)
      },
      (err) => setError(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    )

    return () => navigator.geolocation.clearWatch(watchId)
  }, [])

  return { location, error }
}
