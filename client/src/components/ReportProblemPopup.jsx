import { useEffect, useState } from 'react'
import AnchoredPopup from './AnchoredPopup.jsx'
import { enqueue, useGameStore } from '../offline/gameStore.js'
import { useConnection } from '../net/connection.js'

// Free-text bug/problem report. The server attaches team/player/progress context itself (see
// actProblemReport in server/index.js) — this popup only collects the description. Queued like
// every other action (offline/gameStore.js), so it can be written with no signal: with signal it
// waits for the server's confirmation and shows "sent"; without, it says it'll go when signal's
// back. Either way the popup closes itself after a couple of seconds.
export default function ReportProblemPopup({ anchorRect, onClose }) {
  const [text, setText] = useState('')
  const [actionId, setActionId] = useState(null)
  const [error, setError] = useState('')
  const { outcomes } = useGameStore()
  const connection = useConnection()
  const outcome = actionId ? outcomes[actionId] : null
  const queuedOffline = Boolean(actionId) && !outcome && connection === 'offline'
  const sent = outcome?.status === 'done'

  useEffect(() => {
    if (outcome?.status === 'rejected') {
      setActionId(null)
      setError(outcome.body?.error || 'Could not send the report — try again.')
    }
  }, [outcome])

  useEffect(() => {
    if (!sent && !queuedOffline) return
    const id = setTimeout(onClose, sent ? 2000 : 3000)
    return () => clearTimeout(id)
  }, [sent, queuedOffline, onClose])

  function handleSubmit() {
    if (!text.trim() || actionId) return
    setError('')
    const res = enqueue('problem_report', { message: text.trim() })
    if (res.error) {
      setError(res.error)
      return
    }
    setActionId(res.id)
  }

  if (sent || queuedOffline) {
    return (
      <AnchoredPopup anchorRect={anchorRect} onClose={onClose} className="why-card">
        <div className="why-popup-text">
          <p>{sent ? 'Problem report sent' : "Saved — your report will send as soon as you're back in signal"}</p>
        </div>
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
        disabled={!text.trim() || Boolean(actionId)}
        onClick={handleSubmit}
      >
        {actionId ? 'Sending…' : 'Submit'}
      </button>
    </AnchoredPopup>
  )
}
