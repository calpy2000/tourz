import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { api } from '../api.js'
import { rectFromEvent } from '../rect.js'
import { loadGpsCorrections, clearGpsCorrections } from '../gpsCorrections.js'
import { useCoach } from '../coach/CoachContext.jsx'
import DevMenu from './DevMenu.jsx'
import { useGameClock } from '../gameClock.jsx'

// The "Dev" button + menu shared by every page that needs quick test shortcuts. `onReset` lets
// each page decide what "reset" means for it (re-fetch in place vs. refresh current state) —
// the fast-forward actions always jump to Home, since that's the useful place to land after
// skipping straight to a "N landmarks found" state.
export default function DevTools({ onReset }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [menuAnchor, setMenuAnchor] = useState(null)
  const coach = useCoach()
  const gameClock = useGameClock()

  async function completeThrough(count) {
    await api.devComplete(count)
    navigate('/home')
  }

  async function handleReset() {
    await api.devReset()
    if (onReset) onReset()
    // Land back on "/" so the app's own dev-mode redirect logic (StartPage's ResumeRedirect)
    // sends us to /instructions — a fresh reset means tourComplete is false, so this always
    // lands on instructions section 1, matching what a real fresh team would see.
    navigate('/')
  }

  // Dumps every locally-saved GPS correction (from the POI popup's Set GPS button) to a
  // downloadable .json — the handoff step; corrections themselves are already saved to
  // localStorage the moment each one is submitted. Same local-save-then-export split as
  // tools/poi-field-review's own export button.
  function handleExportGps() {
    const corrections = loadGpsCorrections()
    if (corrections.length === 0) {
      alert('No GPS corrections saved yet.')
      return
    }
    const exportData = { exportedAt: new Date().toISOString(), corrections }
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `tourz-gps-corrections-${Date.now()}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  function handleClearGps() {
    clearGpsCorrections()
  }

  // Tour clock shortcuts (see POST /api/dev/clock) — for testing stop/restart, the last-30-minute
  // time alerts and time's up without waiting hours. Jumping the clock also forgets which alerts
  // this device has already shown, so they fire again. From the certificate page (reached via
  // time's up) the clock poll isn't running, so these hop back to /home to see the result.
  async function devClock(action, minutes) {
    const res = await api.devClock(action, minutes)
    if (res?.error) { alert(res.error); return }
    gameClock.resetAlerts()
    gameClock.apply(res)
    if (location.pathname === '/certificate') navigate('/home')
  }

  // Back to a never-started clock with this player's walkthrough marked unfinished, then run the
  // walkthrough — finishing it as captain is what starts the clock for real.
  async function devReplayClockStart() {
    await devClock('not-started')
    navigate('/home')
    coach.start()
  }

  const actions = [
    { label: 'Reset', onClick: handleReset },
    { label: 'Landmark 1 complete', onClick: () => completeThrough(1) },
    { label: 'Landmark 2 complete', onClick: () => completeThrough(2) },
    { label: 'Up to landmark 10 (unsolved)', onClick: () => completeThrough(10) },
    { label: 'All landmarks complete', onClick: () => completeThrough(999) },
    { label: 'Export GPS updates', onClick: handleExportGps },
    { label: 'Clear GPS corrections', onClick: handleClearGps },
    { label: 'Start coach (test)', onClick: coach.start },
    { label: 'Clock: start now', onClick: () => devClock('start') },
    { label: 'Clock: 31 min left', onClick: () => devClock('minutes-left', 31) },
    { label: 'Clock: 6 min left', onClick: () => devClock('minutes-left', 6) },
    { label: 'Clock: 1 min left', onClick: () => devClock('minutes-left', 1) },
    { label: 'Clock: give back both stops', onClick: () => devClock('reset-stops') },
    { label: 'Clock: not started (redo coach)', onClick: devReplayClockStart },
  ]

  return (
    <>
      <button className="ghost dev-reset" onClick={(e) => setMenuAnchor(rectFromEvent(e))}>
        Dev
      </button>
      {menuAnchor && <DevMenu anchorRect={menuAnchor} actions={actions} onClose={() => setMenuAnchor(null)} />}
    </>
  )
}
