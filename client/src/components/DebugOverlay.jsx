import { useEffect, useRef, useState } from 'react'
import { isDebugMode, useDebugLog, clearDebugLog } from '../debugLog.js'

// On-screen GPS diagnostic log — see debugLog.js. Built to be screenshotted from a real phone.
// DEV_MODE only (see debugLog.js). `appWide`: the copy App.jsx renders over every page after the
// gate — starts collapsed so it doesn't cover the map until opened.
export default function DebugOverlay({ appWide = false }) {
  const entries = useDebugLog()
  const [collapsed, setCollapsed] = useState(appWide)
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
    // Collapsed = a compact chip sitting just above the footer (it used to span the bottom of the
    // screen and hide the footer — score, clock, Help and Dev buttons — reported 2026-10-19).
    <div className={collapsed ? 'debug-overlay debug-overlay-collapsed' : 'debug-overlay'}>
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
