import AnchoredPopup from './AnchoredPopup.jsx'

export default function HelpMenu({ anchorRect, onShowInstructions, onPageHelp, onClose }) {
  return (
    <AnchoredPopup anchorRect={anchorRect} onClose={onClose} className="dev-menu">
      <div className="dev-menu-label">Help</div>
      <button className="dev-menu-item" onClick={onShowInstructions}>Show instructions</button>
      <button className="dev-menu-item" onClick={onPageHelp}>Help on this page</button>
    </AnchoredPopup>
  )
}
