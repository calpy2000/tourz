import DevTools from './DevTools.jsx'
import { DEV_MODE } from '../devMode.js'

function formatHms(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// Team name / tour name / found-count / score / clock — the standard in-game header, shared by
// HomePage and InstructionsPage (which shows it before the tile grid even exists).
export default function GameHeader({ data, elapsedSeconds, onReset }) {
  return (
    <header className="home-header">
      <div className="home-header-line1">
        <span className="team-name">{data.teamName}</span>
        <span className="sep"> &middot; </span>
        <span className="tour-name">{data.tourName}</span>
      </div>
      <div className="home-pills">
        <div className="home-pill">
          <span className="stat-line">Found {data.foundCount}/{data.totalLandmarks}</span>
        </div>
        <div className="home-pill home-pill-brass">
          <span className="stat-line">{data.totalScore} / {data.maxScore} pts</span>
        </div>
        <div className="home-pill">
          <span className="icon-clock" />
          <span className="stat-line">{formatHms(elapsedSeconds)}</span>
        </div>
        {DEV_MODE && <DevTools onReset={onReset} />}
      </div>
    </header>
  )
}
