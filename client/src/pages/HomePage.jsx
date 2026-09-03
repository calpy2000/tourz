import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { API_BASE } from '../apiBase.js'
import GameHeader from '../components/GameHeader.jsx'
import MapView from '../components/MapView.jsx'
import DetailPopup from '../components/DetailPopup.jsx'
import ChatPanel from '../components/ChatPanel.jsx'
import { isStartLandmark, landmarkDisplayNumber } from '../landmarkNumber.js'

function formatMs(totalSeconds) {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function HomePage() {
  const [data, setData] = useState(null)
  const [view, setView] = useState('tile')
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

  // elapsedSeconds is a snapshot from whenever we last fetched — tick locally so the clock
  // keeps moving between fetches instead of looking frozen.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  if (!data) return <div className="screen center">Loading&hellip;</div>

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
      <GameHeader data={data} elapsedSeconds={liveElapsedSeconds} onReset={loadHome} />

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
