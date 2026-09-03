import AnchoredPopup from './AnchoredPopup.jsx'

export default function WhyPopup({ text, anchorRect, onClose }) {
  return (
    <AnchoredPopup anchorRect={anchorRect} onClose={onClose} className="why-card">
      <p className="why-popup-text">{text}</p>
      <p className="why-popup-hint">Tap anywhere outside to close</p>
    </AnchoredPopup>
  )
}
