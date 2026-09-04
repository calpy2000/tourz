import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { ChevronUp, ChevronDown } from 'lucide-react'
import { api } from '../api.js'
import { API_BASE } from '../apiBase.js'
import GameHeader from '../components/GameHeader.jsx'
import MapView from '../components/MapView.jsx'
import DetailPopup from '../components/DetailPopup.jsx'
import ChatPanel from '../components/ChatPanel.jsx'
import LoadingScreen from '../components/LoadingScreen.jsx'
import { isStartLandmark, landmarkDisplayNumber } from '../landmarkNumber.js'
import { useRefreshOnResume } from '../useRefreshOnResume.js'
import { useWakeLock } from '../useWakeLock.js'

function formatMs(totalSeconds) {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function HomePage() {
  const location = useLocation()
  const [data, setData] = useState(null)
  // Restored from the help detour (see HelpButton's returnState / InstructionsPage's back
  // button) so tapping "back" from help-mode instructions doesn't silently drop you into tile
  // view even if you'd been looking at the map.
  const [view, setView] = useState(location.state?.view || 'tile')
  const [fetchedAt, setFetchedAt] = useState(null)
  const [, setTick] = useState(0)
  const [landmarkPopup, setLandmarkPopup] = useState(null)
  const navigate = useNavigate()

  const loadHome = () => api.getHome().then((res) => { setData(res); setFetchedAt(Date.now()) })

  function openLandmark(sequenceOrder) {
    api.getLandmarkDetail(sequenceOrder).then((res) => { if (!res.error) setLandmarkPopup(res) })
  }

  useEffect(() => {
    loadHome()
  }, [])

  useRefreshOnResume(loadHome)
  useWakeLock()

  // elapsedSeconds is a snapshot from whenever we last fetched — tick locally so the clock
  // keeps moving between fetches instead of looking frozen.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  if (!data) return <LoadingScreen />

  const liveElapsedSeconds = data.elapsedSeconds + Math.floor((Date.now() - fetchedAt) / 1000)

  // Build one tile per planned landmark slot (1..totalLandmarks), not just the ones actually
  // authored/solved yet — future landmarks render as "?" placeholders. Sequence 1 is always the
  // start landmark, already "found" from the beginning, labeled "start" instead of a number.
  const solvedBySeq = Object.fromEntries(data.landmarks.map((l) => [l.sequenceOrder, l]))
  const tiles = []
  for (let seq = 1; seq <= data.totalLandmarks; seq++) {
    if (solvedBySeq[seq]) tiles.push({ type: 'solved', seq, ...solvedBySeq[seq] })
    else if (seq === data.currentSequence && data.currentRevealed) tiles.push({ type: 'current-revealed', seq, ...data.currentRevealed })
    else if (seq === data.currentSequence) tiles.push({ type: 'current', seq })
    else tiles.push({ type: 'future', seq })
  }

  return (
    <div className="home-shell">
      <GameHeader
        data={data}
        elapsedSeconds={liveElapsedSeconds}
        onReset={loadHome}
        showHelp
        helpReturnState={{ view }}
        pageHelpText={
          <>
            <p><strong>Tile view</strong> shows every landmark — solved ones as photos, your current landmark marked "in progress", and landmarks you haven't reached yet as "?". Tap a solved tile to see details about the landmark.</p>
            <p><strong>Map view</strong> shows solved landmarks and points-of-interest markers on the map, plus your live location — tap any marker to open it.</p>
            <p>Switch between the two with the buttons above the grid.</p>
            <p>
              You can chat with your team in the <strong>Team feed</strong> at the bottom of the
              screen — tap the chevron{' '}
              <span className="instructions-chevron-pair">
                <ChevronUp size={14} strokeWidth={3} />
                <ChevronDown size={14} strokeWidth={3} />
              </span>{' '}
              to expand or collapse it.
            </p>
          </>
        }
      />

      <div className="home-body">
        <div className="view-switch">
          <button className={view === 'tile' ? 'view-seg view-seg-active' : 'view-seg'} onClick={() => setView('tile')}>Tile view</button>
          <button className={view === 'map' ? 'view-seg view-seg-active' : 'view-seg'} onClick={() => setView('map')}>Map view</button>
        </div>

        {view === 'tile' && (
          <div className="tile-grid">
            {tiles.map((t) => {
              const numberLabel = isStartLandmark(t.seq) ? 'start' : String(landmarkDisplayNumber(t.seq))

              if (t.type === 'solved') {
                return (
                  <button key={t.seq} className="landmark-tile" onClick={() => openLandmark(t.seq)}>
                    <img src={`${API_BASE}/content-photos/${t.imagePath}`} alt="" />
                    <span className="tile-number">{numberLabel}</span>
                    <div className="tile-scrim">
                      <span className="tile-name">{t.title}</span>
                      {!isStartLandmark(t.seq) && (
                        <span className="stat-line tile-stats">{t.points} pts &middot; {formatMs(t.secondsTaken)}</span>
                      )}
                    </div>
                  </button>
                )
              }

              // Puzzle solved, quiz not finished yet — the landmark's identity is known (same
              // gate the "See landmark" button already uses), but it's still "In progress", not
              // a completed tile: no points/time shown yet, and tapping still resumes the quiz
              // rather than opening the detail popup.
              if (t.type === 'current-revealed') {
                return (
                  <button key={t.seq} className="landmark-tile landmark-tile-current" onClick={() => navigate('/play')}>
                    <img src={`${API_BASE}/content-photos/${t.imagePath}`} alt="" />
                    <span className="tile-number">{numberLabel}</span>
                    <div className="tile-scrim tile-scrim-current">
                      <span className="tile-name">{t.title}</span>
                      <span className="stat-line tile-stats">In progress</span>
                    </div>
                  </button>
                )
              }

              if (t.type === 'current') {
                return (
                  <button key={t.seq} className="landmark-tile landmark-tile-current" onClick={() => navigate('/play')}>
                    <span className="tile-number">{numberLabel}</span>
                    <div className="tile-scrim tile-scrim-current"><span className="tile-name">In progress</span></div>
                  </button>
                )
              }

              return (
                <div key={t.seq} className="landmark-tile landmark-tile-future">
                  <span className="tile-number">{numberLabel}</span>
                  <span className="tile-unknown">?</span>
                </div>
              )
            })}
          </div>
        )}

        {view === 'map' && <MapView />}
      </div>

      <ChatPanel />

      {landmarkPopup && (
        <DetailPopup
          eyebrow={isStartLandmark(landmarkPopup.sequenceOrder) ? 'Starting landmark' : `Landmark ${landmarkDisplayNumber(landmarkPopup.sequenceOrder)}`}
          title={landmarkPopup.title}
          address={landmarkPopup.address}
          imagePath={landmarkPopup.imagePath}
          sections={[
            { label: landmarkPopup.aboutLandmarkLabel, text: landmarkPopup.aboutLandmarkText },
            { label: landmarkPopup.aboutSubjectLabel, text: landmarkPopup.aboutSubjectText },
          ]}
          interestingFact={landmarkPopup.interestingFact}
          externalLink={landmarkPopup.externalLink}
          gpsRef={{ type: 'landmark', sequenceOrder: landmarkPopup.sequenceOrder }}
          onClose={() => setLandmarkPopup(null)}
        />
      )}
    </div>
  )
}
