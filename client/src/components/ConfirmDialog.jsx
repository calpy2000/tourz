import AnchoredPopup from './AnchoredPopup.jsx'

export default function ConfirmDialog({ title, message, confirmLabel, cancelLabel, confirmClassName, anchorRect, onConfirm, onCancel }) {
  return (
    <AnchoredPopup anchorRect={anchorRect} onClose={onCancel}>
      <h3>{title}</h3>
      <p>{message}</p>
      <div className="modal-actions">
        <button className="primary" onClick={onCancel}>{cancelLabel}</button>
        <button className={`primary ${confirmClassName}`} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </AnchoredPopup>
  )
}
