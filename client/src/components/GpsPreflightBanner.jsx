import { useState } from 'react'
import { useGpsPreflightStatus } from '../gpsPreflight.js'

// Renders above every route (see App.jsx) so a blocked result surfaces immediately, wherever
// the player currently is in registration/onboarding — not just later on the map. Dismissible
// rather than a hard block: the detection is a heuristic (see gpsPreflight.js), and a false
// positive shouldn't be able to actually stop someone from playing.
export default function GpsPreflightBanner() {
  const status = useGpsPreflightStatus()
  const [dismissed, setDismissed] = useState(false)

  if (status !== 'blocked' || dismissed) return null

  return (
    <div className="gps-preflight-banner">
      This game needs your location, and the app you opened this link in won't let the phone
      ask for it properly. Tap <strong>&bull;&bull;&bull;</strong> or the Safari icon above and
      choose <strong>Open in Safari</strong>, then open the link again there.
      <button type="button" className="ghost" onClick={() => setDismissed(true)}>Continue anyway</button>
    </div>
  )
}
