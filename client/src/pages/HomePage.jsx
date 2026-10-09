import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { api } from '../api.js'
import GameHeader from '../components/GameHeader.jsx'
import MapView from '../components/MapView.jsx'
import LoadingScreen from '../components/LoadingScreen.jsx'
import { useRefreshOnResume } from '../useRefreshOnResume.js'
import { useWakeLock } from '../useWakeLock.js'
import { useCoach } from '../coach/CoachContext.jsx'

// Bootstrap Icons' "house-fill" (bi-house-fill) — picked over a hand-drawn shape so the switcher
// icon matches a real icon library exactly. Shown before both segment labels, not just one, since
// both are ways of viewing the same home page.
function HouseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8.707 1.5a1 1 0 0 0-1.414 0L.646 8.146a.5.5 0 0 0 .708.708L8 2.207l6.646 6.647a.5.5 0 0 0 .708-.708L13 5.793V2.5a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5v1.293z" />
      <path d="m8 3.293 6 6V13.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5V9.293z" />
    </svg>
  )
}

export default function HomePage() {
  const location = useLocation()
  const [data, setData] = useState(null)
  const [view, setView] = useState(location.state?.view || 'map')
  const [fetchedAt, setFetchedAt] = useState(null)
  const [, setTick] = useState(0)
  const navigate = useNavigate()
  const coach = useCoach()

  const loadHome = () => api.getHome().then((res) => { setData(res); setFetchedAt(Date.now()) })

  useEffect(() => {
    loadHome()
  }, [])

  // Set by StartPage's ResumeRedirect (fresh from finishing instructions, or reopening the app
  // with the coach walkthrough still unfinished) — see CoachContext's markCoachComplete call for
  // where that "unfinished" state gets cleared for good once the player actually finishes it.
  useEffect(() => {
    if (location.state?.startCoach) coach.start()
  }, [])

  useRefreshOnResume(loadHome)
  useWakeLock()

  // NarrationPlayerProvider (mounted at the App root, so it's present regardless of which page
  // is showing) fires this when its own poll detects a teammate just earned the narration bonus
  // — refetch here so this page's score pill updates without waiting for the next mount/resume.
  useEffect(() => {
    const onScoreChanged = () => loadHome()
    window.addEventListener('tourz:score-changed', onScoreChanged)
    return () => window.removeEventListener('tourz:score-changed', onScoreChanged)
  }, [])

  // elapsedSeconds is a snapshot from whenever we last fetched — tick locally so the clock
  // keeps moving between fetches instead of looking frozen.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  if (!data) return <LoadingScreen />

  const liveElapsedSeconds = data.elapsedSeconds + Math.floor((Date.now() - fetchedAt) / 1000)

  return (
    <div className="home-shell">
      <div className="home-body">
        <div className="view-switch">
          <button data-coach-id="home-map-view-btn" className={view === 'map' ? 'view-seg view-seg-active' : 'view-seg'} onClick={() => setView('map')}><HouseIcon /><strong>MAP</strong> view</button>
          <button data-coach-id="home-current-landmark-btn" className="view-seg" onClick={() => navigate('/play')}><HouseIcon /><strong>CURRENT</strong> landmark</button>
        </div>

        {view === 'map' && <MapView />}
      </div>

      <GameHeader
        data={data}
        elapsedSeconds={liveElapsedSeconds}
        onReset={loadHome}
        showHelp
        helpReturnState={{ view }}
        pageHelpText={
          <>
            <p><strong>Map view</strong> shows solved landmarks and points-of-interest markers on the map, plus your live location — tap any marker to open it.</p>
            <p><strong>Current landmark</strong> jumps straight to the landmark you're working on now — the find it/solve it page if you haven't cracked it yet, or the quiz if you have.</p>
          </>
        }
      />
    </div>
  )
}
