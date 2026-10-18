import { useEffect, useRef, useState } from 'react'
import { useConnection } from '../net/connection.js'
import { useGameStore } from '../offline/gameStore.js'
import { useContentCache } from '../offline/contentCache.js'

// Everything on screen about signal and offline saving, mounted once at the App root:
// - a slim strip while there's no signal, so a player knows the app is still working (it used to
//   just freeze), with a note for team members that the captain's moves can't reach them now;
// - "Back in signal — syncing…" while queued actions are being sent;
// - short notices when the server refused something done offline (the screen has already snapped
//   back to the server's version by then);
// - a small "Saving tour for offline use… N%" pill while photos/narration download, then a tick.
// All pointer-events: none except the notices, so none of it can swallow a tap meant for the page.
export default function ConnectionStatus({ inGame }) {
  const connection = useConnection()
  const { state, pendingCount, notices } = useGameStore()
  const { progress } = useContentCache()
  const isCaptain = Boolean(state?.player?.isCaptain)
  const [dismissed, setDismissed] = useState([])
  const [showSaved, setShowSaved] = useState(false)
  const wasRunning = useRef(false)

  useEffect(() => {
    if (progress.running) wasRunning.current = true
    else if (wasRunning.current && progress.complete) {
      wasRunning.current = false
      setShowSaved(true)
      const id = setTimeout(() => setShowSaved(false), 4000)
      return () => clearTimeout(id)
    }
  }, [progress.running, progress.complete])

  // "Syncing…" only once something has been waiting a couple of seconds (typically right after
  // signal returns) — every online tap queues an action for a moment, and the strip flashing on
  // each one would jolt the page.
  const [slowSync, setSlowSync] = useState(false)
  useEffect(() => {
    if (pendingCount === 0 || connection === 'offline') {
      setSlowSync(false)
      return
    }
    const id = setTimeout(() => setSlowSync(true), 2000)
    return () => clearTimeout(id)
  }, [pendingCount > 0, connection]) // eslint-disable-line react-hooks/exhaustive-deps

  // The strip pushes the page down rather than covering it (it used to hide the MAP/CURRENT switch):
  // its live height goes into --conn-strip-h, which .home-shell reserves at the top (index.css).
  const stripRef = useRef(null)
  const stripShown = inGame && (connection === 'offline' || slowSync)
  useEffect(() => {
    const root = document.documentElement
    const el = stripRef.current
    if (!stripShown || !el) {
      root.style.setProperty('--conn-strip-h', '0px')
      return
    }
    const update = () => root.style.setProperty('--conn-strip-h', `${el.offsetHeight}px`)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => {
      observer.disconnect()
      root.style.setProperty('--conn-strip-h', '0px')
    }
  }, [stripShown, connection, isCaptain])

  if (!inGame) return null
  const offline = connection === 'offline'
  const visibleNotices = notices.filter((n) => !dismissed.includes(n.id))
  const percent = progress.total ? Math.floor((progress.done / progress.total) * 100) : 0

  return (
    <>
      {offline && (
        <div ref={stripRef} className="conn-strip conn-strip-offline" role="status">
          <strong>No signal</strong> &mdash; keep playing, it&rsquo;s all saved on this phone
          {pendingCount > 0 ? ` and will sync when you're back in signal.` : '.'}
          {!isCaptain && <span className="conn-strip-sub">Your captain&rsquo;s moves will show up once you both have signal.</span>}
        </div>
      )}
      {!offline && slowSync && pendingCount > 0 && (
        <div ref={stripRef} className="conn-strip conn-strip-syncing" role="status">Syncing&hellip;</div>
      )}

      {visibleNotices.length > 0 && (
        <div className="conn-notices">
          {visibleNotices.map((n) => (
            <button key={n.id} className="conn-notice" onClick={() => setDismissed((d) => [...d, n.id])}>
              {n.text}
            </button>
          ))}
        </div>
      )}

      {!offline && progress.running && progress.total > 0 && (
        <div className="offline-save-pill" role="status">Saving tour for offline use&hellip; {percent}%</div>
      )}
      {showSaved && <div className="offline-save-pill offline-save-pill-done" role="status">&#10003; Tour saved for offline use</div>}
    </>
  )
}
