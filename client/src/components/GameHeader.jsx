import DevTools from './DevTools.jsx'
import HelpButton from './HelpButton.jsx'
import { DEV_MODE } from '../devMode.js'

function formatHm(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// Found-count / score / clock — the standard in-game footer, shared by HomePage, PlayPage, and
// InstructionsPage's onboarding flow. Sits at the bottom of .home-shell as a footer, not a
// header — see each page's JSX for where it's placed in the flex-column order. showHelp is
// opt-in, passed by all three (InstructionsPage's help-mode detour doesn't carry a GameHeader
// at all, so it never shows one regardless).
export default function GameHeader({ data, elapsedSeconds, onReset, showHelp = false, pageHelpText, helpReturnState }) {
  return (
    <footer className="home-header">
      <div className="home-pills">
        <div className="home-pill home-pill-oat">
          {/* foundCount/totalLandmarks include the start landmark (sequence_order 1), which
              isn't something a team "finds" — subtract it so the pill reads e.g. 0/14, not 1/15. */}
          <span className="stat-line">Found {data.foundCount - 1}/{data.totalLandmarks - 1}</span>
        </div>
        <div className="home-pill home-pill-brass">
          <span className="stat-line">{data.totalScore} pts</span>
        </div>
        <div className="home-pill home-pill-brick">
          <span className="icon-clock" />
          <span className="stat-line">{formatHm(elapsedSeconds)}</span>
        </div>
        {DEV_MODE && <DevTools onReset={onReset} />}
        {showHelp && <HelpButton pageHelpText={pageHelpText} returnState={helpReturnState} />}
      </div>
    </footer>
  )
}
