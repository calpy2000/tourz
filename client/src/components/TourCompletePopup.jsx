import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { fireConfetti } from '../confetti.js'
import ResultPopup from './ResultPopup.jsx'

function formatElapsed(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.round((totalSeconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

// Rendered once by PlayPage's tourComplete branch — fetches the same /api/game/certificate data
// the certificate page itself uses, so the celebration text and the certificate never drift apart.
// "Top 10% of teams" is hard-coded flavor text (no real percentile calculation exists yet).
export default function TourCompletePopup() {
  const navigate = useNavigate()
  const [data, setData] = useState(null)

  useEffect(() => {
    fireConfetti()
    const id = setTimeout(fireConfetti, 600) // two bursts — a whole-tour finish deserves more than one landmark's worth
    return () => clearTimeout(id)
  }, [])

  useEffect(() => {
    api.getCertificateStatus().then((res) => { if (res?.tourComplete) setData(res) })
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
