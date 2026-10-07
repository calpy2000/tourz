import { useEffect } from 'react'
import { runGpsPreflight, isIOS } from '../gpsPreflight.js'

// Hard-blocks the entire app (see App.jsx, rendered instead of <Routes>) once gpsPreflight.js
// gets back an explicit PERMISSION_DENIED at boot. There's no page worth showing without real
// GPS — every landmark/clue needs the player's live position — and no dismiss button, by design:
// the player has to actually fix the setting, not just acknowledge the message and get stuck
// later on Map view instead. Styled as a normal first page (same .form-shell shell as StartPage)
// rather than a dialog-style popup, since it's the very first thing a player sees, before
// registration. Re-checks automatically when they come back from the Settings app (there's no way
// to jump there directly from a web page), and again via the manual button.
export default function GpsBlockedScreen() {
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') runGpsPreflight()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

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
        <button className="primary" type="button" onClick={() => runGpsPreflight()}>
          I've changed it — check again
        </button>
      </div>
    </div>
  )
}
