import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import GameHeader from '../components/GameHeader.jsx'

export default function InstructionsPage() {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [fetchedAt, setFetchedAt] = useState(null)
  const [, setTick] = useState(0)

  const loadHome = () => api.getHome().then((res) => { setData(res); setFetchedAt(Date.now()) })

  useEffect(() => {
    loadHome()
  }, [])

  // Same live-ticking pattern as HomePage — elapsedSeconds is a snapshot from the last fetch.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  if (!data) return <div className="screen center">Loading&hellip;</div>

  const liveElapsedSeconds = data.elapsedSeconds + Math.floor((Date.now() - fetchedAt) / 1000)

  return (
    <div className="home-shell">
      <GameHeader data={data} elapsedSeconds={liveElapsedSeconds} onReset={loadHome} />

      <div className="home-body">
        <div className="card">
          <h1>Instructions</h1>
        </div>
      </div>

      <div className="form-shell-footer">
        <button className="primary" onClick={() => navigate('/home')}>
          Start the tour
        </button>
      </div>
    </div>
  )
}
