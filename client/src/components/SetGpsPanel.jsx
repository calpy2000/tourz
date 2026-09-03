import { useState } from 'react'
import AnchoredPopup from './AnchoredPopup.jsx'

// Dev-only GPS-correction entry panel, opened from DetailPopup's "Set GPS" button. Freeform text
// rather than separate lat/lng fields — whatever gets pasted or typed while out on the walk
// (e.g. straight off a phone's Maps app "copy coordinates" action) is saved as-is; no need to
// parse or validate it here, that can happen later when the export is reviewed.
export default function SetGpsPanel({ anchorRect, onSubmit, onClose }) {
  const [value, setValue] = useState('')

  function handleSubmit(e) {
    e.preventDefault()
    if (!value.trim()) return
    onSubmit(value.trim())
  }

  return (
    <AnchoredPopup anchorRect={anchorRect} onClose={onClose} className="set-gps-panel">
      <h3>Set GPS</h3>
      <form onSubmit={handleSubmit}>
        <input
          className="field-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. 55.9531, -3.1889"
          autoFocus
        />
        <div className="modal-actions">
          <button type="button" className="primary" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary">Submit</button>
        </div>
      </form>
    </AnchoredPopup>
  )
}
