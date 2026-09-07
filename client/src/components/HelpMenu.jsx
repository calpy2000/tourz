import AnchoredPopup from './AnchoredPopup.jsx'

// Icon-chip menu style (see reference_design_artifacts memory — "TOURZ Help Menu Options" canvas,
// Option 1 chosen). Each row gets a colored icon chip so it reads as a distinct tappable action
// rather than a line of plain text. warn=true swaps the chip to the brick tint, reserved for the
// one destructive/report-style item.
function LightbulbIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.45 1.1 1.2 1.1 2.2h5c0-1 .5-1.75 1.1-2.2A6 6 0 0 0 12 3z" /></svg>
}

function QuestionIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 4.6-1.3c.4.6.4 1.4 0 2-.3.5-.8.8-1.3 1.1-.5.3-.8.7-.8 1.2v.4" /><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" /></svg>
}

function WarningIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3.5 21 19H3L12 3.5z" /><line x1="12" y1="9.5" x2="12" y2="13.5" /><circle cx="12" cy="16.2" r="0.9" fill="currentColor" stroke="none" /></svg>
}

function InfoIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><line x1="12" y1="11" x2="12" y2="16" /><circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none" /></svg>
}

function CrownIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 18h16M4.5 18 3 8l5 4 4-6 4 6 5-4-1.5 10" /></svg>
}

function PersonPlusIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" /><path d="M18.5 8v6M15.5 11h6" /></svg>
}

export default function HelpMenu({ anchorRect, onShowInstructions, onPageHelp, onReportProblem, onChangeCaptain, canChangeCaptain, onComingSoon, onClose }) {
  const items = [
    { label: 'Show instructions', icon: <LightbulbIcon />, onClick: onShowInstructions },
    { label: 'Help on this page', icon: <QuestionIcon />, onClick: onPageHelp },
    { label: 'Report a problem', icon: <WarningIcon />, warn: true, onClick: onReportProblem },
    { label: 'About this tour', icon: <InfoIcon />, onClick: () => onComingSoon('About this tour') },
    // Real action — only the current captain sees it, and only once there's someone to hand the
    // role to (see HelpButton.jsx's teamPlayers fetch).
    ...(canChangeCaptain ? [{ label: 'Change team captain', icon: <CrownIcon />, onClick: onChangeCaptain }] : []),
    { label: 'Add new player', icon: <PersonPlusIcon />, onClick: () => onComingSoon('Add new player') },
  ]

  return (
    <AnchoredPopup anchorRect={anchorRect} onClose={onClose} className="help-menu">
      <div className="help-menu-label">Help</div>
      {items.map((item) => (
        <button
          key={item.label}
          data-coach-id={item.label === 'Show instructions' ? 'help-menu-show-instructions' : undefined}
          className="help-menu-item"
          onClick={item.onClick}
        >
          <span className={`help-menu-icon-chip${item.warn ? ' warn' : ''}`}>{item.icon}</span>
          {item.label}
        </button>
      ))}
    </AnchoredPopup>
  )
}
