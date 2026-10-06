import { useEffect } from 'react'
import { runGpsPreflight } from '../gpsPreflight.js'

// Hard-blocks the entire app (see App.jsx, rendered instead of <Routes>) once gpsPreflight.js
// gets back an explicit PERMISSION_DENIED at boot. There's no page worth showing without real
// GPS — every landmark/clue needs the player's live position — and no dismiss button, by design:
// the player has to actually fix the setting, not just acknowledge the message and get stuck
// later on Map view instead. Re-checks automatically when they come back from the Settings app
// (there's no way to jump there directly from a web page), and again via the manual button.
export default function GpsBlockedScreen() {
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') runGpsPreflight()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  return (
    <div className="gps-blocked-screen">
      <div className="gps-blocked-card">
        <h1>Location access is off</h1>
        <p>This game shows your live position on the map, so it needs your location turned on.</p>
        <ol>
          <li>Open the <strong>Settings</strong> app</li>
          <li>Go to <strong>Privacy &amp; Security → Location Services</strong></li>
          <li>Make sure Location Services is switched <strong>On</strong></li>
          <li>Scroll down to <strong>Safari Websites</strong> and set it to <strong>Ask Next Time Or When I Share</strong> (not "Never")</li>
        </ol>
        <p>Then come back to this tab — we'll check again automatically.</p>
        <button type="button" onClick={() => runGpsPreflight()}>I've changed it — check again</button>
      </div>
    </div>
  )
}
