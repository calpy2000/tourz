import { useState } from 'react'
import AnchoredPopup from './AnchoredPopup.jsx'
import { api } from '../api.js'

// Free-text bug/problem report. The server attaches team/player/progress context itself (see
// POST /api/game/problem-report) — this popup only collects the description. On success it swaps
// its own body for a "sent" confirmation and auto-closes after 2s, per spec, rather than making
// the caller manage that timing.
export default function ReportProblemPopup({ anchorRect, onClose }) {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit() {
    if (!text.trim() || submitting) return
    setSubmitting(true)
    setError('')
    const res = await api.sendProblemReport(text.trim())
    if (res?.error) {
      setSubmitting(false)
      setError(res.error)
      return
    }
    setSent(true)
    setTimeout(onClose, 2000)
  }

  if (sent) {
    return (
      <AnchoredPopup anchorRect={anchorRect} onClose={onClose} className="why-card">
        <div className="why-popup-text"><p>Problem report sent</p></div>
      </AnchoredPopup>
    )
  }

  return (
    <AnchoredPopup anchorRect={anchorRect} onClose={onClose} className="report-problem-card">
      <div className="help-menu-label">Report a problem</div>
      <textarea
        className="report-problem-textarea"
        placeholder="Share the problem here"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        autoFocus
      />
      {error && <p className="captain-only-note">{error}</p>}
      <button
        className="primary captain-picker-submit"
        disabled={!text.trim() || submitting}
        onClick={handleSubmit}
      >
        {submitting ? 'Sending…' : 'Submit'}
      </button>
    </AnchoredPopup>
  )
}
