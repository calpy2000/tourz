import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import LoadingScreen from '../components/LoadingScreen.jsx'

function ordinal(n) {
  const suffixes = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]}`
}

export default function WelcomePage() {
  const navigate = useNavigate()
  const [status, setStatus] = useState(null)
  const [teamNameInput, setTeamNameInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.getSession().then(setStatus)
  }, [])

  if (!status) return <LoadingScreen />

  const { player, team, registrationNumber, maxPlayers, captainName } = status
  const remaining = Math.max(0, maxPlayers - registrationNumber)
  const isFirst = registrationNumber === 1

  async function handleSaveTeamName(e) {
    e.preventDefault()
    if (!teamNameInput.trim()) return
    setSaving(true)
    const result = await api.setTeamName(teamNameInput.trim())
    setSaving(false)
    if (result.error) {
      setError(result.error)
      return
    }
    setError('')
    setStatus((prev) => ({ ...prev, team: { ...prev.team, name: result.name } }))
  }

  const canContinue = !(isFirst && !team.name)

  return (
    <div className="form-shell">
      <div className="form-shell-body">
        <h1 className="welcome-heading">
          <span className="welcome-avatar">{player.avatar}</span>
          Welcome {player.name}
        </h1>

        <section className="card">
          {team.name ? (
            <p>
              You are the {isFirst ? 'first' : ordinal(registrationNumber)} member of your team to
              register, there {remaining === 1 ? 'is' : 'are'} {remaining} more member{remaining === 1 ? '' : 's'} yet
              to register. Your team name is <strong>{team.name}</strong>.
            </p>
          ) : isFirst ? (
            <>
              <p>
                You are the first member of your team to register, there {remaining === 1 ? 'is' : 'are'} {remaining} more
                member{remaining === 1 ? '' : 's'} yet to register.
              </p>
              <p>As the first team member to register you have the pleasure of picking your team name. Please enter this below.</p>
              <form onSubmit={handleSaveTeamName} className="answer-form">
                <input
                  value={teamNameInput}
                  onChange={(e) => setTeamNameInput(e.target.value)}
                  placeholder="Your team name"
                />
                <button className="primary" type="submit" disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </form>
              {error && <p className="form-error">{error}</p>}
            </>
          ) : (
            <p>
              You are the {ordinal(registrationNumber)} member of your team to register, there {remaining === 1 ? 'is' : 'are'} {remaining} more
              member{remaining === 1 ? '' : 's'} yet to register. Your team hasn't chosen a team name yet.
            </p>
          )}
        </section>

        <section className="card">
          {player.isCaptain ? (
            <p>
              You have registered as the team captain &mdash; this is a special role. Each team
              member has their own version of the app on their phone and each can use it
              independently &mdash; however you, and only you, can submit answers into the app to
              solve the walk. So work out how you and the team are going to work together &mdash;
              you can exchange messages on the app itself using the chat function at the bottom of
              the screen.
            </p>
          ) : (
            <p>
              You have registered as a team member, your team captain is{' '}
              <strong>{captainName || 'yet to register'}</strong>. As a team member you have your
              own version of the app and can use it independently &mdash; however only the team
              captain can submit answers into the app to solve the walk, so work out how you and
              the team are going to work together &mdash; you can exchange messages on the app
              itself using the chat function at the bottom of the screen.
            </p>
          )}
        </section>
      </div>

      <button className="primary instructions-start-btn" disabled={!canContinue} onClick={() => navigate('/instructions')}>
        See instructions
      </button>
    </div>
  )
}
