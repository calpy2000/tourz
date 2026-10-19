import { useSyncExternalStore } from 'react'

// Which engine draws Map view: 'osm' (default — self-hosted OpenStreetMap, works with no signal)
// or 'google' (the original Google map, kept behind the Dev menu until OSM is proven on a real
// walk, then removed). Per device, remembered across reloads.
const KEY = 'tourz.mapProvider'
let listeners = []

function read() {
  try { return localStorage.getItem(KEY) === 'google' ? 'google' : 'osm' } catch { return 'osm' }
}

let current = read()

export function getMapProvider() {
  return current
}

export function setMapProvider(provider) {
  current = provider === 'google' ? 'google' : 'osm'
  try { localStorage.setItem(KEY, current) } catch { /* storage blocked — this visit only */ }
  listeners.forEach((fn) => fn())
}

function subscribe(fn) {
  listeners.push(fn)
  return () => { listeners = listeners.filter((l) => l !== fn) }
}

export function useMapProvider() {
  return useSyncExternalStore(subscribe, () => current)
}
