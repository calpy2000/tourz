import { useState } from 'react'
import AnchoredPopup from './AnchoredPopup.jsx'
import { api } from '../api.js'

// The captain picks whoever they're handing the role to from their teammates (players is the
// roster HelpButton already fetched to decide whether to show this menu item at all — self is
// excluded server-side). Submitting calls the real captain-swap endpoint; the server posts the
// "X is now the team captain" chat message itself, so this popup only needs to report success
// back up to HelpButton (which updates this device's own isCaptain) and close.
export default function ChangeCaptainPopup({ anchorRect, players, onClose, onChanged }) {
  const [selectedId, setSelectedId] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit() {
    if (!selectedId || submitting) return
    setSubmitting(true)
    setError('')
    const res = await api.changeCaptain(selectedId)
    if (res?.error) {
      setSubmitting(false)
      setError(res.error)
      return
    }
    onChanged()
  }

  return (
    <AnchoredPopup anchorRect={anchorRect} onClose={onClose} className="captain-picker">
      <div className="help-menu-label">Change team captain</div>
      {players.map((p) => (
        <button
          key={p.id}
          className={`captain-pick-item${selectedId === p.id ? ' selected' : ''}`}
          onClick={() => setSelectedId(p.id)}
        >
          <span className="help-menu-icon-chip">{p.avatar}</span>
          {p.name}
        </button>
      ))}
      {error && <p className="captain-only-note">{error}</p>}
      <button
        className="primary captain-picker-submit"
        disabled={!selectedId || submitting}
        onClick={handleSubmit}
      >
        {submitting ? 'Submitting…' : 'Submit'}
      </button>
    </AnchoredPopup>
  )
}
