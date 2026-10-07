import { useEffect, useState } from 'react'
import { useGpsPreflightStatus, requestGpsPermission, isIOS } from '../gpsPreflight.js'
import LoadingScreen from './LoadingScreen.jsx'

// Hard-blocks the entire app (see App.jsx, rendered instead of <Routes>) for as long as
// gpsPreflight.js hasn't confirmed GPS actually works — no page here is worth showing without
// real GPS, every landmark/clue needs the player's live position. Two distinct screens, picked
// by status:
//   - "ask": location hasn't been decided yet. A single button, tapped deliberately by the
//     player — that real tap is what lets the OS geolocation prompt (if one's needed at all)
//     behave reliably; see gpsPreflight.js's big comment on why an automatic, gesture-less call
//     just silently hangs on some phones instead of resolving either way.
//   - "blocked": that tap came back an explicit denial, or stalled too long to be anything else.
//     Settings instructions, by platform, plus a "check again" button — also a real tap. Once
//     this has been shown, it stays showing through any transient re-check (see shownBlocked
//     below) rather than flicking back to the single-button "ask" screen.
// No dismiss button on either, by design: the player has to actually fix it, not just
// acknowledge the message and get stuck later on Map view instead. Re-checks automatically when
// they come back from the Settings app (there's no way to jump there directly from a web page),
// as a bonus best-effort nicety — it's still just another requestGpsPermission() call, so even
// if iOS declines to resolve it cleanly, its own stall timer recovers to "blocked" again rather
// than hanging.
export default function GpsGateScreen() {
  const status = useGpsPreflightStatus()
  const [shownBlocked, setShownBlocked] = useState(status === 'blocked')

  useEffect(() => {
    if (status === 'blocked') setShownBlocked(true)
  }, [status])

  useEffect(() => {
    if (!shownBlocked) return
    function onVisible() {
      if (document.visibilityState === 'visible') requestGpsPermission()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [shownBlocked])

  if (status === 'unchecked' || status === 'checking') return <LoadingScreen />

  const working = status === 'requesting'

  if (!shownBlocked) {
    return (
      <div className="form-shell">
        <div className="form-shell-body">
          <p className="eyebrow">TOURZ &middot; Walking Tour</p>
          <h1 className="start-heading">Welcome to the tour</h1>
          <p className="subtitle">
            In a second we'll get you registered, but before we start we need to turn on GPS
            location, because the tour tracks your live position on the map, so that we can point
            out landmarks and points of interest as you progress.
          </p>
          <p className="subtitle">Tap below and allow location access when your phone asks.</p>
          <button className="primary" type="button" disabled={working} onClick={() => requestGpsPermission()}>
            {working ? 'Checking…' : 'Enable location'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="form-shell">
      <div className="form-shell-body">
        <p className="eyebrow">TOURZ &middot; Walking Tour</p>
        <h1 className="start-heading">Welcome to the tour</h1>
        <p className="subtitle">
          In a second we'll get you registered, but before we start we need to set up GPS
          location services, because the tour tracks your live position on the map, so that we
          can point out landmarks and points of interest as you progress.
        </p>
        <p className="subtitle">
          It looks like this is turned off on your phone right now, and your walk won't be as
          enjoyable. Here's what you need to do:
        </p>
        {isIOS ? (
          <ol className="gps-blocked-steps">
            <li>Open the <strong>Settings</strong> app</li>
            <li>Go to <strong>Privacy &amp; Security</strong> then <strong>Location Services</strong></li>
            <li>Make sure the Location Services toggle is switched <strong>On</strong></li>
            <li>Scroll down to <strong>Safari Websites</strong></li>
            <li>Set it to <strong>Always</strong> or <strong>Ask Next Time Or When I Share</strong></li>
          </ol>
        ) : (
          // Android's exact Settings wording/layout varies too much by phone maker (Samsung,
          // Pixel, etc.) to give precise steps the way the iOS ones above do — this stays
          // deliberately generic rather than risk sending someone down a path their phone
          // doesn't actually have.
          <ol className="gps-blocked-steps">
            <li>Open your phone's <strong>Settings</strong> app</li>
            <li>Find <strong>Location</strong> (sometimes under Privacy or Security) and make sure it's switched <strong>On</strong></li>
            <li>Find the browser or app you opened this link in in the app permissions list</li>
            <li>Set its <strong>Location</strong> permission to <strong>Allow</strong></li>
          </ol>
        )}
        <p className="subtitle">Then come back here to this tab — we'll check again automatically.</p>
        <button className="primary" type="button" disabled={working} onClick={() => requestGpsPermission()}>
          {working ? 'Checking…' : "I've changed it — check again"}
        </button>
      </div>
    </div>
  )
}
