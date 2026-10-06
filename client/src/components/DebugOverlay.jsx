import { useEffect, useRef, useState } from 'react'
import { isDebugMode, useDebugLog } from '../debugLog.js'

// TEMPORARY diagnostic panel — see debugLog.js. Renders above every route, only when the page
// was reached via a `?debug=1` link, so it doesn't show on-screen GPS coordinates to ordinary
// players.
export default function DebugOverlay() {
  const entries = useDebugLog()
  const [collapsed, setCollapsed] = useState(false)
  const [copied, setCopied] = useState(false)
  const bottomRef = useRef(null)

  useEffect(() => {
    if (!collapsed) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [entries, collapsed])

  if (!isDebugMode()) return null

  const text = entries.map((e) => `${e.time} ${e.label} ${e.data ? JSON.stringify(e.data) : ''}`).join('\n')

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard API can be unavailable in some in-app browsers — screenshotting still works.
    }
  }

  return (
    <div className="debug-overlay">
      <div className="debug-overlay-header">
        <strong>debug ({entries.length})</strong>
        <button type="button" onClick={copyAll}>{copied ? 'copied' : 'copy'}</button>
        <button type="button" onClick={() => setCollapsed((c) => !c)}>{collapsed ? 'show' : 'hide'}</button>
      </div>
      {!collapsed && (
        <div className="debug-overlay-body">
          {entries.map((e, i) => (
            <div key={i} className="debug-overlay-entry">
              <span className="debug-overlay-time">{e.time}</span>{' '}
              <span className="debug-overlay-label">{e.label}</span>
              {e.data !== undefined && <span className="debug-overlay-data"> {JSON.stringify(e.data)}</span>}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  )
}
