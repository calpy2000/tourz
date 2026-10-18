import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { getSession } from './localSession.js'
import { useCoach } from './coach/CoachContext.jsx'
import { useGameStore, enqueue, syncNow, serverNow } from './offline/gameStore.js'
import { clockView } from './offline/engine.js'
import { useNarrationPlayer } from './components/NarrationPlayer.jsx'
import ResultPopup from './components/ResultPopup.jsx'
import { playClockRestartedPing, playClockStoppedPing, playTimeAlertPing } from './screenUpdatePing.js'

// The tour clock, client side. The server owns the real clock (see clockState in server/index.js:
// a per-tour limit, started when the captain finishes the walkthrough, stoppable twice by the
// captain). Since 2026-10-18 it's worked out on the phone from the game state's raw clock columns
// (offline/engine.js clockView — same maths as the server), so it keeps counting, stopping and
// restarting with no signal; the state itself is kept fresh by offline/gameStore.js. Drives
// everything that depends on it: the footer countdown (GameHeader's ClockPill), the Help menu's
// stop/restart items (HelpButton), and — via GameClockLayer below — the frozen screen, the
// stopped/waiting banners, the stop/restart pings, the last-30-minutes time alerts and the
// time's-up popup.

const IN_GAME_PATHS = ['/home', '/play', '/instructions']
const RECOMPUTE_MS = 1000
// Time alerts: one each time the remaining time drops past one of these (minutes left).
const ALERT_MINUTES = [30, 25, 20, 15, 10, 5]

// Remaining time as H:MM — no leading zero on the hour (the limit is a few hours at most) and no
// seconds. Rounded UP to the minute, the usual countdown convention: a fresh 3-hour clock reads
// 3:00, and 0:01 only turns into time's up when the time has actually run out.
export function formatClock(seconds) {
  const totalMinutes = Math.ceil(Math.max(0, seconds) / 60)
  return `${Math.floor(totalMinutes / 60)}:${String(totalMinutes % 60).padStart(2, '0')}`
}

// "3 hours", "1 hour", "2 hours 30 minutes", "45 minutes" — for copy that quotes the limit.
export function formatTimeLimit(minutes) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  const hours = h ? `${h} hour${h === 1 ? '' : 's'}` : ''
  const mins = m ? `${m} minute${m === 1 ? '' : 's'}` : ''
  return [hours, mins].filter(Boolean).join(' ') || '0 minutes'
}

function readStorage(key) {
  try { return localStorage.getItem(key) } catch { return null }
}
function writeStorage(key, value) {
  try { localStorage.setItem(key, String(value)) } catch { /* private mode etc — alerts may repeat, harmless */ }
}
function removeStorage(key) {
  try { localStorage.removeItem(key) } catch { /* see above */ }
}
const alertKey = (gameId) => `tourz-clock-alert-${gameId}`

function isRunning(c) {
  return Boolean(c && c.started && !c.paused && !c.timeUp && !c.tourComplete)
}

// Each recompute's remainingSeconds is converted to a local deadline (when running) so the
// countdown can tick on its own. A recompute only replaces state when something real changed —
// a second or two of jitter in the deadline would otherwise re-render the whole app every second.
function sameClock(a, b) {
  for (const key of Object.keys(b)) {
    if (key === 'remainingSeconds' || key === 'deadline') continue
    if (a[key] !== b[key]) return false
  }
  if ((a.deadline == null) !== (b.deadline == null)) return false
  if (a.deadline != null) return Math.abs(a.deadline - b.deadline) < 2000
  return a.remainingSeconds === b.remainingSeconds
}

const GameClockContext = createContext(null)

export function GameClockProvider({ children }) {
  const location = useLocation()
  const coach = useCoach()
  const { state } = useGameStore()
  const active = IN_GAME_PATHS.includes(location.pathname) && Boolean(getSession()) && Boolean(state)
  const [clock, setClock] = useState(null)
  const stateRef = useRef(state)
  stateRef.current = state

  const apply = useCallback((res) => {
    if (!res || res.error) return
    const next = { ...res, deadline: isRunning(res) ? Date.now() + res.remainingSeconds * 1000 : null }
    setClock((prev) => (prev && sameClock(prev, next) ? prev : next))
  }, [])

  // Also how the walkthrough finishing starts the clock straight away: CoachContext queues
  // coach_complete, which the engine applies to the state at once (signal or not).
  const recompute = useCallback(() => {
    if (stateRef.current) apply(clockView(stateRef.current, serverNow()))
  }, [apply])
  useEffect(() => { recompute() }, [state, recompute])
  useEffect(() => {
    if (!active) return
    const id = setInterval(recompute, RECOMPUTE_MS)
    return () => clearInterval(id)
  }, [active, recompute])

  const refresh = useCallback(() => syncNow(), [])

  // Applied on the phone at once (the whole team's screens freeze when the server hears of it).
  const stopClock = useCallback(async () => {
    const res = enqueue('clock_stop')
    return res.error ? { error: res.error } : res.result
  }, [])

  const restartClock = useCallback(async () => {
    const res = enqueue('clock_restart')
    return res.error ? { error: res.error } : res.result
  }, [])

  // Dev tools only: forget which time alerts this device has already shown for this game, so a
  // "jump to N minutes left" shortcut can show them again.
  const resetAlerts = useCallback(() => { if (clock) removeStorage(alertKey(clock.gameId)) }, [clock])

  // Why (if at all) the app is frozen right now. 'waiting' — this player has finished the
  // walkthrough but the captain hasn't yet, so the clock isn't running; doesn't apply on the
  // Instructions page (reading them before the clock starts is the whole point) or while the coach
  // is still running. 'paused' and 'timeUp' freeze every in-game page.
  let frozenReason = null
  if (active && clock && !clock.tourComplete) {
    if (clock.timeUp) frozenReason = 'timeUp'
    else if (clock.paused) frozenReason = 'paused'
    else if (!clock.started && clock.coachComplete && !coach.active && location.pathname !== '/instructions') frozenReason = 'waiting'
  }

  const value = { active, clock, frozenReason, refresh, apply, stopClock, restartClock, resetAlerts }
  return <GameClockContext.Provider value={value}>{children}</GameClockContext.Provider>
}

export function useGameClock() {
  const ctx = useContext(GameClockContext)
  if (!ctx) throw new Error('useGameClock must be used within GameClockProvider')
  return ctx
}

// Live seconds remaining, re-rendering only the calling component once a second while the clock
// runs (not the whole app). null until the first poll lands.
export function useLiveRemaining() {
  const { clock } = useGameClock()
  const [, setTick] = useState(0)
  const deadline = clock?.deadline ?? null
  useEffect(() => {
    if (deadline == null) return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [deadline])
  if (!clock) return null
  return deadline != null ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : clock.remainingSeconds
}

function PauseGlyph() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="5" height="16" rx="1.5" /><rect x="14" y="4" width="5" height="16" rx="1.5" /></svg>
}

// Everything on screen that the clock drives, apart from the footer pill and the Help menu items.
// Mounted once at the App root (inside GameClockProvider) so it works the same on every page.
export function GameClockLayer() {
  const { active, clock, frozenReason, restartClock, refresh } = useGameClock()
  const remaining = useLiveRemaining()
  const navigate = useNavigate()
  const narration = useNarrationPlayer()
  const narrationRef = useRef(narration)
  narrationRef.current = narration
  const [alertMinutes, setAlertMinutes] = useState(null)
  const [restartedNotice, setRestartedNotice] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const prevClockRef = useRef(null)
  const timeUpRefreshedRef = useRef(false)
  const alertTimerRef = useRef(null)
  const noticeTimerRef = useRef(null)

  // Freezing: greys the page out and blocks every tap except the footer and the banner (see
  // body.clock-frozen in index.css), and stops any narration that's playing.
  useEffect(() => {
    document.body.classList.toggle('clock-frozen', Boolean(frozenReason))
    if (frozenReason && narrationRef.current.track) narrationRef.current.close()
    return () => document.body.classList.remove('clock-frozen')
  }, [frozenReason])

  // Stop/restart pings for team members — the captain doesn't need one for their own tap.
  useEffect(() => {
    const prev = prevClockRef.current
    prevClockRef.current = clock
    if (!prev || !clock || prev.gameId !== clock.gameId || clock.isCaptain) return
    if (!prev.paused && clock.paused) {
      playClockStoppedPing()
      setRestartedNotice(false)
    } else if (prev.paused && !clock.paused && clock.started) {
      playClockRestartedPing()
      setRestartedNotice(true)
      clearTimeout(noticeTimerRef.current)
      noticeTimerRef.current = setTimeout(() => setRestartedNotice(false), 5000)
    }
  }, [clock])

  // Time alerts: once remaining time drops past 30, 25, ... 5 minutes left. Remembered per game on
  // this device, so a reload doesn't repeat one, and a phone woken after missing a few shows just
  // the latest (with the real minutes left, not the threshold it crossed).
  useEffect(() => {
    if (!active || !isRunning(clock) || remaining == null || remaining <= 0) return
    const crossed = ALERT_MINUTES.filter((m) => m * 60 < clock.limitSeconds && remaining <= m * 60)
    if (!crossed.length) return
    const threshold = Math.min(...crossed)
    const key = alertKey(clock.gameId)
    const lastShown = Number(readStorage(key)) || Infinity
    if (threshold >= lastShown) return
    writeStorage(key, threshold)
    playTimeAlertPing()
    setAlertMinutes(Math.ceil(remaining / 60))
    clearTimeout(alertTimerRef.current)
    alertTimerRef.current = setTimeout(() => setAlertMinutes(null), 10000)
  }, [active, clock, remaining])

  // The local countdown reaching zero — confirm with the server straight away rather than waiting
  // for the next poll, which then flips timeUp and shows the popup below.
  useEffect(() => {
    if (!isRunning(clock) || remaining == null) return
    if (remaining > 0) { timeUpRefreshedRef.current = false; return }
    if (!timeUpRefreshedRef.current) {
      timeUpRefreshedRef.current = true
      refresh()
    }
  }, [clock, remaining, refresh])

  useEffect(() => () => { clearTimeout(alertTimerRef.current); clearTimeout(noticeTimerRef.current) }, [])

  if (!active || !clock) return null

  async function handleRestart() {
    setRestarting(true)
    await restartClock()
    setRestarting(false)
  }

  const stopsLeft = clock.maxStops - clock.pausesUsed
  const limitText = formatTimeLimit(Math.round(clock.limitSeconds / 60))

  let banner = null
  if (frozenReason === 'paused') {
    banner = clock.isCaptain ? (
      <>
        <strong>You&rsquo;ve stopped the clock</strong>
        <span className="clock-banner-sub">
          The tour is paused for your whole team.{' '}
          {stopsLeft > 0 ? `You have ${stopsLeft} stop${stopsLeft === 1 ? '' : 's'} left.` : 'That was your last stop.'}
        </span>
        <button className="primary clock-banner-btn" onClick={handleRestart} disabled={restarting}>
          {restarting ? 'Restarting…' : 'Restart clock'}
        </button>
      </>
    ) : (
      <>
        <strong>Your captain has stopped the clock</strong>
        <span className="clock-banner-sub">The tour is paused until they restart it.</span>
      </>
    )
  } else if (frozenReason === 'waiting') {
    banner = (
      <>
        <strong>Waiting for your captain</strong>
        <span className="clock-banner-sub">
          {clock.captainName
            ? `Your ${limitText} start when ${clock.captainName} finishes the instructions and the app walkthrough — you can play as soon as the clock starts.`
            : `Your team captain hasn't registered yet. Your ${limitText} start once they've registered and finished the app walkthrough.`}
        </span>
      </>
    )
  }

  return (
    <>
      {frozenReason && <div className="clock-freeze-overlay" />}

      {banner && (
        <div className={`clock-banner${frozenReason === 'waiting' ? ' clock-banner-waiting' : ''}`} role="status">
          <span className="clock-banner-icon"><PauseGlyph /></span>
          <div className="clock-banner-text">{banner}</div>
        </div>
      )}

      {alertMinutes != null && !frozenReason && (
        <button className="clock-toast clock-toast-alert" onClick={() => setAlertMinutes(null)}>
          ⏰ <strong>Time alert</strong> &mdash; there {alertMinutes === 1 ? 'is' : 'are'} {alertMinutes} minute{alertMinutes === 1 ? '' : 's'} left
        </button>
      )}

      {restartedNotice && !frozenReason && (
        <button className="clock-toast clock-toast-ok" onClick={() => setRestartedNotice(false)}>
          ▶ Your captain has restarted the clock &mdash; the tour is back on!
        </button>
      )}

      {frozenReason === 'timeUp' && (
        <ResultPopup
          className="clock-timeup-popup"
          title="⏰ Time's up!"
          text={`Your ${limitText} are over. Your team completed ${clock.landmarksCompleted} of ${clock.totalLandmarks} landmarks and scored ${clock.totalScore} points.`}
          buttonLabel="See your certificate"
          onContinue={() => navigate('/certificate', { replace: true })}
        />
      )}
    </>
  )
}
