import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { rectFromEvent } from '../rect.js'
import { loadGpsCorrections } from '../gpsCorrections.js'
import DevMenu from './DevMenu.jsx'

// The "Dev" button + menu shared by every page that needs quick test shortcuts. `onReset` lets
// each page decide what "reset" means for it (re-fetch in place vs. refresh current state) —
// the fast-forward actions always jump to Home, since that's the useful place to land after
// skipping straight to a "N landmarks found" state.
export default function DevTools({ onReset }) {
  const navigate = useNavigate()
  const [menuAnchor, setMenuAnchor] = useState(null)

  async function completeThrough(count) {
    await api.devComplete(count)
    navigate('/home')
  }

  async function handleReset() {
    await api.devReset()
    if (onReset) onReset()
  }

  // Dumps every locally-saved GPS correction (from the POI popup's Set GPS button) to a
  // downloadable .json — the handoff step; corrections themselves are already saved to
  // localStorage the moment each one is submitted. Same local-save-then-export split as
  // tools/poi-field-review's own export button.
  function handleExportGps() {
    const corrections = loadGpsCorrections()
    if (corrections.length === 0) {
      alert('No GPS corrections saved yet.')
      return
    }
    const exportData = { exportedAt: new Date().toISOString(), corrections }
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `tourz-gps-corrections-${Date.now()}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const actions = [
    { label: 'Reset', onClick: handleReset },
    { label: 'Landmark 1 complete', onClick: () => completeThrough(1) },
    { label: 'Landmark 2 complete', onClick: () => completeThrough(2) },
    { label: 'All landmarks + POIs complete', onClick: () => completeThrough(999) },
    { label: 'Export GPS updates', onClick: handleExportGps },
  ]

  return (
    <>
      <button className="ghost dev-reset" onClick={(e) => setMenuAnchor(rectFromEvent(e))}>
        Dev
      </button>
      {menuAnchor && <DevMenu anchorRect={menuAnchor} actions={actions} onClose={() => setMenuAnchor(null)} />}
    </>
  )
}
