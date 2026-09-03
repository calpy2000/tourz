export default function ResultPopup({ title, text, buttonLabel, onContinue, secondaryLabel, onSecondary, disabled, disabledNote }) {
  return (
    <div className="result-popup">
      {title && <p className="result-popup-title">{title}</p>}
      <p className="result-popup-text">{text}</p>
      <div className="result-popup-actions">
        {secondaryLabel && (
          <button className="primary" onClick={onSecondary}>{secondaryLabel}</button>
        )}
        <button className="primary" onClick={onContinue} disabled={disabled}>{buttonLabel}</button>
      </div>
      {disabled && disabledNote && <p className="captain-only-note">{disabledNote}</p>}
    </div>
  )
}
