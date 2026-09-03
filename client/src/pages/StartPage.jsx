import { useState, useEffect } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { getSession, saveSession } from '../localSession.js'
import { DEV_MODE } from '../devMode.js'
import AvatarPicker from '../components/AvatarPicker.jsx'

export default function StartPage() {
  const navigate = useNavigate()
  // Captured once, at mount, via a lazy initializer — NOT a plain `getSession()` call in the
  // render body. This page itself writes a session (in handleSubmit) and then re-renders before
  // navigating away (setSubmitting(false) fires first) — a live getSession() check would see its
  // own just-written session on that re-render and redirect to /home, racing past the intended
  // navigate('/welcome'). Freezing the pre-existing value at mount means only "already registered
  // before this visit" triggers the resume redirect, never a registration that just happened here.
  const [hadExistingSession] = useState(() => Boolean(getSession()))
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState('')
  const [role, setRole] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Dev mode skips registration entirely and lands straight on the tile-view Home page as a
  // fixed local identity ("Calvin" captaining "The Eggheads") — see devMode.js. Re-checks on
  // every mount (not once-only) so flipping dev mode on for a device that already holds a normal
  // registered session still switches over to the dev identity instead of resuming the old one.
  const [devSessionReady, setDevSessionReady] = useState(false)
  useEffect(() => {
    if (!DEV_MODE) return
    if (getSession()?.name === 'Calvin') {
      setDevSessionReady(true)
      return
    }
    api.devLogin().then((result) => {
      if (result.error) return
      saveSession({
        sessionToken: result.sessionToken,
        playerId: result.player.id,
        teamId: result.team.id,
        name: result.player.name,
        avatar: result.player.avatar,
        isCaptain: result.player.isCaptain,
      })
      setDevSessionReady(true)
    })
  }, [])

  if (DEV_MODE) {
    return devSessionReady ? <Navigate to="/home" replace /> : <div className="screen center">Loading&hellip;</div>
  }

  // Already registered on this device — no need to go through this again.
  if (hadExistingSession) return <Navigate to="/home" replace />

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim() || !avatar || !role || !code.trim()) {
      setError('Please fill in your name, an avatar, your role and the game code.')
      return
    }
    setError('')
    setSubmitting(true)
    const result = await api.register({ code: code.trim(), name: name.trim(), avatar, role })
    setSubmitting(false)
    if (result.error) {
      setError(result.error)
      return
    }
    saveSession({
      sessionToken: result.sessionToken,
      playerId: result.player.id,
      teamId: result.team.id,
      name: result.player.name,
      avatar: result.player.avatar,
      isCaptain: result.player.isCaptain,
    })
    navigate('/welcome')
  }

  return (
    <div className="form-shell">
      <div className="form-shell-body">
        <p className="eyebrow">TOURZ &middot; Edinburgh Old Town Walk</p>
        <h1 className="start-heading">Welcome to the tour</h1>
        <p className="subtitle">
          To activate the tour you will need to enter your game play code. Once you start, the
          game timer starts and you will have exactly six hours to complete the tour. When you
          enter the code, you will be asked if you are the team captain or a team member &mdash;
          note that while all team players can use the app on their phone independently, only the
          team captain can submit answers to solve the walk.
        </p>

        <form onSubmit={handleSubmit}>
          <div className="field-row">
            <label className="field-row-label" htmlFor="reg-name">Name:</label>
            <input
              id="reg-name"
              className="field-input field-row-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sarah"
            />
          </div>

          <AvatarPicker value={avatar} onChange={setAvatar} label="Pick an avatar:" />

          <div className="field-row">
            <span className="field-row-label">Your role:</span>
            <div className="radio-row">
              <label className="radio-option">
                <input type="radio" name="role" value="captain" checked={role === 'captain'} onChange={() => setRole('captain')} />
                Team captain
              </label>
              <label className="radio-option">
                <input type="radio" name="role" value="member" checked={role === 'member'} onChange={() => setRole('member')} />
                Team member
              </label>
            </div>
          </div>

          <div className="field-row">
            <label className="field-row-label" htmlFor="reg-code">Game code:</label>
            <input
              id="reg-code"
              className="field-input field-row-input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Your game play code"
              autoCapitalize="characters"
            />
          </div>

          {error && <p className="form-error">{error}</p>}

          <button className="primary" type="submit" disabled={submitting}>
            {submitting ? 'Checking code…' : 'Submit'}
          </button>
        </form>
      </div>
    </div>
  )
}
