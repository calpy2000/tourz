import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { ChevronUp, ChevronDown } from 'lucide-react'
import { api } from '../api.js'
import GameHeader from '../components/GameHeader.jsx'
import LoadingScreen from '../components/LoadingScreen.jsx'
import ChatPanel from '../components/ChatPanel.jsx'

// Same star mark as MapView's site pins (StarIcon there isn't exported) — shown inline here so
// the "points-of-interest" callout in the instructions text matches the real map marker.
function PoiMarkerIcon() {
  return (
    <span className="instructions-poi-marker">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2 15 9 22 9.5 16.8 14.2 18.3 21 12 17.3 5.7 21 7.2 14.2 2 9.5 9 9Z" />
      </svg>
    </span>
  )
}

function BackArrowVisual() {
  return <span className="instructions-back-visual">&larr; back</span>
}

export default function InstructionsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  // Reached two different ways: the required onboarding step before /home (no state — full
  // GameHeader, "start the tour" footer, no chat), or opened later from HelpButton's "Show
  // instructions" option (helpMode — simple back button instead, no footer, chat panel visible so
  // the team feed stays reachable). returnTo is wherever the help button was tapped from.
  const helpMode = Boolean(location.state?.helpMode)
  const returnTo = location.state?.returnTo || '/home'
  const returnState = location.state?.returnState
  const [data, setData] = useState(null)
  const [fetchedAt, setFetchedAt] = useState(null)
  const [, setTick] = useState(0)

  const loadHome = () => api.getHome().then((res) => { setData(res); setFetchedAt(Date.now()) })

  useEffect(() => {
    if (!helpMode) loadHome()
  }, [helpMode])

  // Same live-ticking pattern as HomePage — elapsedSeconds is a snapshot from the last fetch.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  if (!helpMode && !data) return <LoadingScreen />

  const liveElapsedSeconds = data ? data.elapsedSeconds + Math.floor((Date.now() - fetchedAt) / 1000) : 0

  return (
    <div className="home-shell instructions-shell">
      {helpMode ? (
        <header className="landmark-header">
          <button className="ghost back-link" onClick={() => navigate(returnTo, { state: returnState })}>&larr; back</button>
        </header>
      ) : (
        <GameHeader data={data} elapsedSeconds={liveElapsedSeconds} onReset={loadHome} />
      )}

      <div className="home-body">
        <div className="instructions-text">
          <h1>Instructions</h1>

          <p>
            Welcome to your Edinburgh walking tour. To complete the tour you will need to find{' '}
            <strong>14 landmarks</strong> across this great city &mdash; some are big, and some
            are small. For each landmark you find you can earn up to <strong>10 points</strong>.
            You&rsquo;ll have <strong>6 hours</strong> from the moment you start to complete the
            tour, so keep an eye on the timer at the top of the screen.
          </p>

          <p>
            Your starting landmark is the Royal Bank of Scotland headquarters on St Andrew&rsquo;s
            Square.
          </p>

          <p>
            The app is pretty simple &mdash; if in doubt, <strong>always</strong> go back to the
            home page by tapping the <strong>back arrow</strong> <BackArrowVisual /> at the top
            left of the screen. The home page has <strong>two options:</strong>
          </p>

          <p>
            <strong className="instructions-red">Tile view</strong> shows a tile for each
            landmark you have found so far, plus the current landmark you are trying to find.
          </p>

          <p>
            <strong className="instructions-red">Map view</strong> shows a marker for each
            landmark you have found so far, plus lots of <strong>points-of-interest</strong>{' '}
            markers <PoiMarkerIcon />. These markers are{' '}
            <strong>key to your education</strong>, providing rich detail and background 😎{' '}
            &mdash; just tap one to enter a world of things you never knew you never knew. The
            map also shows where you are &mdash; for this to work, make sure you{' '}
            <strong>allow location access</strong> when your browser asks.
          </p>

          <p>
            You will need to <strong>find and solve</strong> 🔎 each landmark. This will start with
            a <strong>clue</strong> to help you. If you need help you can ask for a{' '}
            <strong>hint</strong> or two. If the hints don&rsquo;t work you can{' '}
            <strong>reveal</strong> the landmark &mdash; but be warned, taking hints or revealing
            reduces the points you will earn. When you think you have found the landmark, you
            will be asked a <strong>&ldquo;solve it&rdquo;</strong> question to make sure you
            really have &mdash; take care, as you only get one chance at this.
          </p>

          <p>
            Once a landmark has been solved, there is a <strong>quiz</strong> which will test
            your observation skills on the route you just took. So{' '}
            <strong>keep your eyes peeled</strong> 👀 along the way, take notes and take in the
            points of interest as you go &mdash; by tapping on them in map view.
          </p>

          <p>
            Then move onto the next landmark. Note that until a landmark has been found, it will{' '}
            <strong className="instructions-red">NOT</strong> be shown in map view, for obvious
            reasons. So remember to <strong>use tile view</strong> when you want to check
            progress on the landmark you are currently trying to find.
          </p>

          <p>
            You will be <strong>working as a team</strong>, and each team member will have the
            app on their phone, so you can work independently if you want to. You can also{' '}
            <strong>chat</strong> to each other in the <strong>CHAT</strong> that is always
            at the bottom of the screen &mdash; tap the chevron{' '}
            <span className="instructions-chevron-pair">
              <ChevronUp size={14} strokeWidth={3} />
              <ChevronDown size={14} strokeWidth={3} />
            </span>{' '}
            to expand or collapse it.
          </p>

          <p>
            Note that <strong>only the team captain</strong> can ask for a hint, ask to reveal a
            landmark, solve a landmark, or enter answers in the quiz &mdash; but all team members
            can see what is going on, wherever they are. So working out how you are going to work
            as a team is key to solving the tour.
          </p>

          <p>
            Good luck &mdash; the clock is ticking, so you had better get on with it. Don&rsquo;t
            forget, if in doubt, tap the <strong>back arrow</strong> <BackArrowVisual /> and head
            to <strong>tile view</strong>.
          </p>
        </div>
      </div>

      {!helpMode && (
        <button className="primary instructions-start-btn" onClick={() => navigate('/home')}>
          start the tour
        </button>
      )}

      {helpMode && <ChatPanel />}
    </div>
  )
}
