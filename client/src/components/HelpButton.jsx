import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { rectFromEvent } from '../rect.js'
import { api } from '../api.js'
import { getSession, saveSession } from '../localSession.js'
import AnchoredPopup from './AnchoredPopup.jsx'
import HelpMenu from './HelpMenu.jsx'
import ChangeCaptainPopup from './ChangeCaptainPopup.jsx'
import ReportProblemPopup from './ReportProblemPopup.jsx'

// The "💡 Help" control shown on every in-game page except registration, instructions and the
// certificate (see App.jsx/pages for where this is and isn't wired in). Tapping it opens a menu:
// reopen the same instructions page shown at tour start (in "help mode" — see InstructionsPage's
// helpMode branch: back button instead of the start-tour flow, chat panel still visible), a
// per-page help popup, the real "change team captain" flow (below), or one of several
// not-yet-built items (report a problem, about this tour, add player) that land on a generic "to
// be built" placeholder for now. pageHelpText is per-page real copy to be written in later; until
// a page passes one, the popup shows a placeholder. returnState is whatever the calling page needs
// restored on the way back (e.g. HomePage's tile-vs-map view) — round-tripped through
// InstructionsPage's back button so the help detour doesn't reset it.
export default function HelpButton({ pageHelpText, returnState }) {
  const navigate = useNavigate()
  const location = useLocation()
  const isCaptain = getSession()?.isCaptain ?? false
  const [menuAnchor, setMenuAnchor] = useState(null)
  const [pageHelpAnchor, setPageHelpAnchor] = useState(null)
  const [comingSoonAnchor, setComingSoonAnchor] = useState(null)
  const [comingSoonLabel, setComingSoonLabel] = useState('')
  // Teammates the captain could hand the role to (self already excluded server-side) — only ever
  // fetched for the captain, since only the captain can see or use the "Change team captain" item.
  // Refetched on mount so it stays roughly current for the life of the page without needing a
  // dedicated poll — good enough for a menu-item visibility gate.
  const [teamPlayers, setTeamPlayers] = useState(null)
  const [captainPickerAnchor, setCaptainPickerAnchor] = useState(null)
  const [reportProblemAnchor, setReportProblemAnchor] = useState(null)

  useEffect(() => {
    if (!isCaptain) return
    let cancelled = false
    api.getTeamPlayers().then((res) => { if (!cancelled) setTeamPlayers(res?.players || []) })
    return () => { cancelled = true }
  }, [isCaptain])

  function handleShowInstructions() {
    setMenuAnchor(null)
    navigate('/instructions', { state: { helpMode: true, returnTo: location.pathname, returnState } })
  }

  function handlePageHelp() {
    setPageHelpAnchor(menuAnchor)
    setMenuAnchor(null)
  }

  function handleComingSoon(label) {
    setComingSoonLabel(label)
    setComingSoonAnchor(menuAnchor)
    setMenuAnchor(null)
  }

  function handleReportProblem() {
    setReportProblemAnchor(menuAnchor)
    setMenuAnchor(null)
  }

  async function handleOpenCaptainPicker() {
    const anchor = menuAnchor
    setMenuAnchor(null)
    // Refetch right before showing the picker — the background copy above only needs to be
    // roughly right to gate the menu item, but the list the captain actually submits from should
    // be current (e.g. a player who joined moments ago).
    const res = await api.getTeamPlayers()
    setTeamPlayers(res?.players || [])
    setCaptainPickerAnchor(anchor)
  }

  function handleCaptainChanged() {
    // The old captain (this device — only the captain can trigger this) loses the role
    // immediately, rather than waiting for ChatPanel's next poll to pick up the system message.
    const session = getSession()
    if (session) saveSession({ ...session, isCaptain: false })
    setCaptainPickerAnchor(null)
  }

  return (
    <>
      <button data-coach-id="help-btn" className="help-btn" aria-label="Help" onClick={(e) => setMenuAnchor(rectFromEvent(e))}>
        💡 Help
      </button>

      {menuAnchor && (
        <HelpMenu
          anchorRect={menuAnchor}
          onShowInstructions={handleShowInstructions}
          onPageHelp={handlePageHelp}
          onReportProblem={handleReportProblem}
          onChangeCaptain={handleOpenCaptainPicker}
          canChangeCaptain={isCaptain && (teamPlayers?.length ?? 0) > 0}
          onComingSoon={handleComingSoon}
          onClose={() => setMenuAnchor(null)}
        />
      )}

      {captainPickerAnchor && (
        <ChangeCaptainPopup
          anchorRect={captainPickerAnchor}
          players={teamPlayers || []}
          onClose={() => setCaptainPickerAnchor(null)}
          onChanged={handleCaptainChanged}
        />
      )}

      {reportProblemAnchor && (
        <ReportProblemPopup anchorRect={reportProblemAnchor} onClose={() => setReportProblemAnchor(null)} />
      )}

      {pageHelpAnchor && (
        <AnchoredPopup anchorRect={pageHelpAnchor} onClose={() => setPageHelpAnchor(null)} className="why-card">
          <div className="why-popup-text">{pageHelpText || <p>Help for this page hasn't been written yet.</p>}</div>
          <p className="why-popup-hint">Tap anywhere outside to close</p>
        </AnchoredPopup>
      )}

      {comingSoonAnchor && (
        <AnchoredPopup anchorRect={comingSoonAnchor} onClose={() => setComingSoonAnchor(null)} className="why-card">
          <div className="why-popup-text"><p>"{comingSoonLabel}" hasn't been built yet — coming soon.</p></div>
          <p className="why-popup-hint">Tap anywhere outside to close</p>
        </AnchoredPopup>
      )}
    </>
  )
}
