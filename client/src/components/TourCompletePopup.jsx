import { useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { fireConfetti } from '../confetti.js'
import ResultPopup from './ResultPopup.jsx'
import { useGameStore, serverNow } from '../offline/gameStore.js'
import { certificateView } from '../offline/engine.js'

function formatElapsed(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.round((totalSeconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

// Rendered once by PlayPage's tourComplete branch — built from the same certificate data the
// certificate page itself uses (offline/engine.js certificateView, the phone's mirror of
// GET /api/game/certificate), so the celebration text and the certificate never drift apart, and
// finishing the last landmark in a dead spot still celebrates on the spot.
// "Top 10% of teams" is hard-coded flavor text (no real percentile calculation exists yet).
export default function TourCompletePopup() {
  const navigate = useNavigate()
  const { state } = useGameStore()
  const data = useMemo(() => {
    const view = state ? certificateView(state, serverNow()) : null
    return view?.tourComplete ? view : null
  }, [state])

  useEffect(() => {
    fireConfetti()
    const id = setTimeout(fireConfetti, 600) // two bursts — a whole-tour finish deserves more than one landmark's worth
    return () => clearTimeout(id)
  }, [])

  if (!data) return null

  return (
    <ResultPopup
      title={`${data.playerName} · ${data.teamName}`}
      text={`Congratulations! You completed the ${data.tourName} in ${formatElapsed(data.elapsedSeconds)} and scored ${data.totalScore} points — that puts you in the top 10% of teams! 🎉`}
      buttonLabel="Get your certificate"
      onContinue={() => navigate('/certificate')}
    />
  )
}
