import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toPng } from 'html-to-image'
import { useGameStore, enqueue, serverNow } from '../offline/gameStore.js'
import { certificateView } from '../offline/engine.js'
import { useConnection } from '../net/connection.js'
import { rectFromEvent } from '../rect.js'
import { clearSession } from '../localSession.js'
import AnchoredPopup from '../components/AnchoredPopup.jsx'
import LoadingScreen from '../components/LoadingScreen.jsx'
import DevTools from '../components/DevTools.jsx'
import { DEV_MODE } from '../devMode.js'

function formatElapsed(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.round((totalSeconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

// A team lands here once its tour is over, either way it can end: every landmark completed, or
// the tour clock running out (timeUp — the certificate then records how far they got, e.g.
// "12/14 landmarks completed", and drops the "completion" wording). Any session that resolves
// here while its tour is still going is bounced to /home — the actual "always land here once
// finished, even after the game code has expired" behavior lives in StartPage's ResumeRedirect,
// which checks the same /api/game/certificate endpoint on every fresh app open.
export default function CertificatePage() {
  const navigate = useNavigate()
  // Built on the phone from the game state (offline/engine.js certificateView — the mirror of
  // GET /api/game/certificate), so a tour that ends in a dead spot still gets its certificate.
  const { state, outcomes } = useGameStore()
  const connection = useConnection()
  const data = useMemo(() => {
    const view = state ? certificateView(state, serverNow()) : null
    return view && (view.tourComplete || view.timeUp) ? view : null
  }, [state])
  const [emailAnchor, setEmailAnchor] = useState(null)
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  // The queued send (see handleSend) and who it's going to.
  const [pendingSend, setPendingSend] = useState(null) // { id, to } | null
  const [sentTo, setSentTo] = useState('')
  const [newTourAnchor, setNewTourAnchor] = useState(null)
  const cardRef = useRef(null)

  useEffect(() => {
    if (state && !data) navigate('/home', { replace: true })
  }, [state, data, navigate])

  // The emailed certificate is queued like any other action: sent as soon as there's signal.
  const sendOutcome = pendingSend ? outcomes[pendingSend.id] : null
  useEffect(() => {
    if (!sendOutcome) return
    if (sendOutcome.status === 'done') setSentTo(pendingSend.to)
    else setSendError(sendOutcome.body?.error || 'Could not send — try again.')
    setPendingSend(null)
  }, [sendOutcome, pendingSend])

  async function handleSend(e) {
    e.preventDefault()
    if (!email.trim() || sending) return
    setSending(true)
    setSendError('')
    try {
      const imageDataUrl = await toPng(cardRef.current, { pixelRatio: 2 })
      const res = enqueue('certificate_send', { email: email.trim(), imageDataUrl })
      if (res.error) {
        setSendError(res.error)
      } else {
        setPendingSend({ id: res.id, to: email.trim() })
        setEmailAnchor(null)
        setEmail('')
      }
    } catch {
      setSendError('Could not send — try again.')
    } finally {
      setSending(false)
    }
  }

  // Clearing the session is a one-way door: StartPage's ResumeRedirect decides where to send a
  // device purely from the current session token, so once this one is gone there's no way back
  // to this certificate (this team's progress still exists server-side, but nothing on the device
  // points at it any more) — hence the confirmation before doing it.
  function handleStartAnotherTour() {
    clearSession()
    navigate('/', { replace: true })
  }

  if (!data) return <LoadingScreen />

  return (
    <div className="screen center certificate-page">
      <div className="certificate-card" ref={cardRef}>
        <span className="certificate-corner certificate-corner-tl" />
        <span className="certificate-corner certificate-corner-tr" />
        <span className="certificate-corner certificate-corner-bl" />
        <span className="certificate-corner certificate-corner-br" />

        <div className="certificate-seal">🏆</div>
        <p className="certificate-eyebrow">{data.timeUp ? 'Certificate of Achievement' : 'Certificate of Completion'}</p>
        <h1 className="certificate-brand">TOURZ</h1>

        <p className="certificate-name">{data.playerName}</p>
        <p className="certificate-team">{data.teamName}</p>

        <div className="certificate-rule" />

        <p className="certificate-tour">{data.tourName}</p>

        <div className="certificate-stats">
          <div className="certificate-stat">
            <span className="certificate-stat-value">{formatElapsed(data.elapsedSeconds)}</span>
            <span className="certificate-stat-label">Time</span>
          </div>
          <div className="certificate-stat">
            <span className="certificate-stat-value">{data.totalScore}</span>
            <span className="certificate-stat-label">Points</span>
          </div>
        </div>

        <p className="certificate-landmarks">{data.landmarksCompleted}/{data.totalLandmarks} landmarks completed</p>

        {!data.timeUp && <span className="certificate-rank">Top 10% of teams</span>}
        <p className="certificate-date">{data.timeUp ? 'Finished' : 'Completed'} {formatDate(data.completedAt)}</p>
      </div>

      {sentTo ? (
        <p className="certificate-sent-note">Sent to {sentTo} ✓</p>
      ) : pendingSend ? (
        <p className="certificate-sent-note">
          {connection === 'offline' ? `Saved — it will send to ${pendingSend.to} as soon as you're back in signal` : `Sending to ${pendingSend.to}…`}
        </p>
      ) : (
        <button className="primary" onClick={(e) => setEmailAnchor(rectFromEvent(e))}>
          Save and send
        </button>
      )}

      <button className="certificate-new-tour-button" onClick={(e) => setNewTourAnchor(rectFromEvent(e))}>
        Start another tour
      </button>

      {emailAnchor && (
        <AnchoredPopup anchorRect={emailAnchor} onClose={() => !sending && setEmailAnchor(null)}>
          <h3>Email your certificate</h3>
          <form onSubmit={handleSend} className="certificate-email-form">
            <input
              type="email"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@email.com"
            />
            {sendError && <p className="form-error">{sendError}</p>}
            <button className="primary" type="submit" disabled={sending}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </form>
        </AnchoredPopup>
      )}

      {newTourAnchor && (
        <AnchoredPopup anchorRect={newTourAnchor} onClose={() => setNewTourAnchor(null)}>
          <h3>Start another tour?</h3>
          <p>
            Once you do this, you won't be able to get back to this certificate on this device
            &mdash; save or send it first if you want to keep it.
          </p>
          <button className="primary" onClick={handleStartAnotherTour}>
            Yes, start another tour
          </button>
        </AnchoredPopup>
      )}

      {DEV_MODE && <div className="certificate-dev-tools"><DevTools onReset={() => {}} /></div>}
    </div>
  )
}
