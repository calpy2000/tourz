import DevTools from './DevTools.jsx'
import HelpButton from './HelpButton.jsx'
import { DEV_MODE } from '../devMode.js'
import { formatClock, useGameClock, useLiveRemaining } from '../gameClock.jsx'

// Time LEFT on the tour clock (see gameClock.jsx), counting down as H:MM. Before the captain has
// started the clock it just shows the full limit (e.g. 3:00), not moving. While the captain has it
// stopped it turns solid red and pulses, with a pause glyph in place of the clock icon. Its own
// component so only this pill re-renders every second, not the whole footer/page.
function ClockPill() {
  const { clock } = useGameClock()
  const remaining = useLiveRemaining()
  const stopped = Boolean(clock?.paused)
  return (
    <div className={`home-pill home-pill-brick${stopped ? ' home-pill-clock-stopped' : ''}`}>
      {stopped ? (
        <svg className="clock-pill-pause" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="5" height="16" rx="1.5" /><rect x="14" y="4" width="5" height="16" rx="1.5" /></svg>
      ) : (
        <span className="icon-clock" />
      )}
      <span className="stat-line">{remaining == null ? '–:––' : formatClock(remaining)}</span>
    </div>
  )
}

// Found-count / score / clock — the standard in-game footer, shared by HomePage, PlayPage, and
// InstructionsPage's onboarding flow. Sits at the bottom of .home-shell as a footer, not a
// header — see each page's JSX for where it's placed in the flex-column order. showHelp is
// opt-in, passed by all three (InstructionsPage's help-mode detour doesn't carry a GameHeader
// at all, so it never shows one regardless).
export default function GameHeader({ data, onReset, showHelp = false, pageHelpText, helpReturnState }) {
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
        <ClockPill />
        {DEV_MODE && <DevTools onReset={onReset} />}
        {showHelp && <HelpButton pageHelpText={pageHelpText} returnState={helpReturnState} />}
      </div>
    </footer>
  )
}
