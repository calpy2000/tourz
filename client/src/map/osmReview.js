import { useEffect, useState, useSyncExternalStore } from 'react'

// TEMPORARY (OSM migration, phase 2→3): Dev-menu "OSM review" mode. Each POI pin is coloured by how
// its saved (Google-placed) position compares with the same feature found in OpenStreetMap data,
// and found pins are drawn at their OSM position — a preview of auto-relocating them, nothing
// saved. Built from the matcher's CSV report (one osmReview.<tour>.json per tour):
//   blue  — not found in OSM, pin left where it is
//   green — found, same spot (0 m)
//   amber — found, 1–2 m away
//   red   — found, more than 2 m away
// Amber/red also draw the old position as a dot joined to the pin by a thin line. A pin moved by
// hand with Set GPS shows purple (the normal pin colour) at its new spot.
// Landmarks store only their shift, never their coordinates — those stay secret until solved.
// Remove with the rest of the review once every tour's pins are settled on OSM.
const KEY = 'tourz.osmReview'
let listeners = []

function read() {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

let current = read()

export function getOsmReview() {
  return current
}

export function setOsmReview(on) {
  current = Boolean(on)
  try { localStorage.setItem(KEY, current ? '1' : '0') } catch { /* storage blocked — this visit only */ }
  listeners.forEach((fn) => fn())
}

function subscribe(fn) {
  listeners.push(fn)
  return () => { listeners = listeners.filter((l) => l !== fn) }
}

export function useOsmReview() {
  return useSyncExternalStore(subscribe, () => current)
}

// Loaded only when review mode is on — its own small chunk, never in the main bundle.
const LOADERS = {
  edinburgh: () => import('./osmReview.edinburgh.json'),
}

export function useOsmReviewData(tourCode, enabled) {
  const [data, setData] = useState(null)
  useEffect(() => {
    const load = enabled && LOADERS[tourCode]
    if (!load) { setData(null); return }
    let cancelled = false
    load().then((m) => { if (!cancelled) setData(m.default) }).catch(() => {})
    return () => { cancelled = true }
  }, [tourCode, enabled])
  return data
}

export const REVIEW_COLORS = {
  blue: '#4169e1',
  green: '#16a34a',
  amber: '#f59e0b',
  red: '#dc2626',
  purple: '#a855f7',
}

// Verdicts given in chat for pins that can't be tapped (e.g. hidden under a landmark) — copied once
// into this device's saved corrections, exactly as if GPS OK had been tapped, so they export too.
const PRESET_VERDICTS = [
  { type: 'site', id: 3470, name: 'Bute House', enteredGps: '55.952504, -3.208054', confirmed: true },
]
const PRESET_KEY = 'tourz.osmReviewPresets'

export function seedPresetVerdicts(load, save) {
  try {
    const done = new Set(JSON.parse(localStorage.getItem(PRESET_KEY) || '[]'))
    const saved = load()
    for (const v of PRESET_VERDICTS) {
      const key = `${v.type}:${v.id ?? v.sequenceOrder}`
      if (done.has(key)) continue
      const already = saved.some((c) => c.type === v.type && (v.type === 'site' ? c.id === v.id : c.sequenceOrder === v.sequenceOrder))
      if (!already) save({ ...v, capturedAt: new Date().toISOString() })
      done.add(key)
    }
    localStorage.setItem(PRESET_KEY, JSON.stringify([...done]))
  } catch { /* storage blocked — nothing to seed */ }
}
