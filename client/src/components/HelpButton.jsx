import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { rectFromEvent } from '../rect.js'
import AnchoredPopup from './AnchoredPopup.jsx'
import HelpMenu from './HelpMenu.jsx'

// The "💡 Help" control shown on every in-game page except registration, instructions and the
// certificate (see App.jsx/pages for where this is and isn't wired in). Tapping it offers two
// options: reopen the same instructions page shown at tour start (in "help mode" — see
// InstructionsPage's helpMode branch: back button instead of the start-tour flow, chat panel
// still visible), or a per-page help popup. pageHelpText is per-page real copy to be written in
// later; until a page passes one, the popup shows a placeholder. returnState is whatever the
// calling page needs restored on the way back (e.g. HomePage's tile-vs-map view) — round-tripped
// through InstructionsPage's back button so the help detour doesn't reset it.
export default function HelpButton({ pageHelpText, returnState }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [menuAnchor, setMenuAnchor] = useState(null)
  const [pageHelpAnchor, setPageHelpAnchor] = useState(null)

  function handleShowInstructions() {
    setMenuAnchor(null)
    navigate('/instructions', { state: { helpMode: true, returnTo: location.pathname, returnState } })
  }

  function handlePageHelp() {
    setPageHelpAnchor(menuAnchor)
    setMenuAnchor(null)
  }

  return (
    <>
      <button className="help-btn" aria-label="Help" onClick={(e) => setMenuAnchor(rectFromEvent(e))}>
        💡 Help
      </button>

      {menuAnchor && (
        <HelpMenu
          anchorRect={menuAnchor}
          onShowInstructions={handleShowInstructions}
          onPageHelp={handlePageHelp}
          onClose={() => setMenuAnchor(null)}
        />
      )}

      {pageHelpAnchor && (
        <AnchoredPopup anchorRect={pageHelpAnchor} onClose={() => setPageHelpAnchor(null)} className="why-card">
          <div className="why-popup-text">{pageHelpText || <p>Help for this page hasn't been written yet.</p>}</div>
          <p className="why-popup-hint">Tap anywhere outside to close</p>
        </AnchoredPopup>
      )}
    </>
  )
}
