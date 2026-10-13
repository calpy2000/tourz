import AnchoredPopup from './AnchoredPopup.jsx'

// children: optional extra content rendered under the message (e.g. a warning line).
export default function ConfirmDialog({ title, message, confirmLabel, cancelLabel, confirmClassName = '', anchorRect, onConfirm, onCancel, children }) {
  return (
    <AnchoredPopup anchorRect={anchorRect} onClose={onCancel}>
      <h3>{title}</h3>
      <p>{message}</p>
      {children}
      <div className="modal-actions">
        <button className="primary" onClick={onCancel}>{cancelLabel}</button>
        <button className={`primary ${confirmClassName}`} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </AnchoredPopup>
  )
}
