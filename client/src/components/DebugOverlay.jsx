import { useEffect, useRef, useState } from 'react'
import { isDebugMode, useDebugLog, clearDebugLog } from '../debugLog.js'

// On-screen GPS-gate diagnostic log — see debugLog.js. Rendered by GpsGateScreen only, so it
// never sits over the map/play pages. Built to be screenshotted from a real phone.
export default function DebugOverlay() {
  const entries = useDebugLog()
  const [collapsed, setCollapsed] = useState(false)
  const [copied, setCopied] = useState(false)
  const bottomRef = useRef(null)

  useEffect(() => {
    if (!collapsed) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [entries, collapsed])

  if (!isDebugMode()) return null

  const fmt = (e) => `#${e.boot} ${e.time} +${e.t}ms ${e.label}${e.data !== undefined ? ' ' + JSON.stringify(e.data) : ''}`

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(entries.map(fmt).join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard API can be unavailable in some in-app browsers — screenshotting still works.
    }
  }

  return (
    <div className="debug-overlay">
      <div className="debug-overlay-header">
        <strong>gps debug ({entries.length})</strong>
        <button type="button" onClick={copyAll}>{copied ? 'copied' : 'copy'}</button>
        <button type="button" onClick={clearDebugLog}>clear</button>
        <button type="button" onClick={() => setCollapsed((c) => !c)}>{collapsed ? 'show' : 'hide'}</button>
      </div>
      {!collapsed && (
        <div className="debug-overlay-body">
          {entries.map((e, i) => (
            <div key={i} className="debug-overlay-entry">
              <span className="debug-overlay-time">#{e.boot} {e.time} +{e.t}ms</span>{' '}
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
