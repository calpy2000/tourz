import { useSyncExternalStore } from 'react'
import { API_BASE } from '../apiBase.js'

// Whether the app can currently reach the server — judged from real requests, not
// navigator.onLine. A phone in a mobile-signal dead spot usually still reports itself "online"
// (it has a network interface, just no data getting through — "lie-fi"), and a plain fetch() then
// hangs for a minute or more. That's what froze the whole app on a live tour (2026-10-18): every
// tap awaited a request that never came back. So every request here has a hard timeout; the first
// one that times out or fails marks the app offline, after which requests fail instantly (instead
// of piling up more hung requests) while a small /api/health probe checks every few seconds for
// the way back.

export class NetworkError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NetworkError'
    this.offline = true
  }
}

const PROBE_EVERY_MS = 5000
const PROBE_TIMEOUT_MS = 4000

let status = typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'online'
let listeners = []
let reconnectHandlers = []
let probeTimer = null

// Dev Tools "Simulate dead signal": every request hangs until its timeout, exactly like a real dead
// spot (Chrome's own "Offline" switch fails requests instantly, which isn't the case that froze the
// app). Per tab, survives in-app navigation and reloads.
const SIMULATE_KEY = 'tourzSimulateDeadSignal'
function readSimulate() {
  try { return sessionStorage.getItem(SIMULATE_KEY) === '1' } catch { return false }
}
let simulateDeadSignal = readSimulate()

function notify() {
  listeners.forEach((fn) => fn())
}

function markOffline() {
  if (status === 'offline') return
  status = 'offline'
  notify()
  scheduleProbe()
}

function markOnline() {
  if (probeTimer) { clearTimeout(probeTimer); probeTimer = null }
  if (status === 'online') return
  status = 'online'
  notify()
  reconnectHandlers.forEach((fn) => { try { fn() } catch { /* a handler's own problem */ } })
}

function scheduleProbe(delay = PROBE_EVERY_MS) {
  if (probeTimer) clearTimeout(probeTimer)
  probeTimer = setTimeout(probe, delay)
}

async function probe() {
  probeTimer = null
  try {
    await request(`${API_BASE}/api/health`, { cache: 'no-store' }, PROBE_TIMEOUT_MS, { probe: true })
  } catch {
    if (status === 'offline') scheduleProbe()
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('offline', markOffline)
  // The OS saying it's back is only a hint — confirm with a real request straight away.
  window.addEventListener('online', () => { if (status === 'offline') scheduleProbe(0) })
  if (status === 'offline') scheduleProbe()
}

// fetch() with a hard timeout and connection tracking. Throws NetworkError on timeout/failure, or
// straight away while offline (except for the recovery probe itself). Any HTTP response at all —
// even an error status — proves the server is reachable, so it counts as online.
export async function request(url, options = {}, timeoutMs = 10000, { probe: isProbe = false } = {}) {
  if (status === 'offline' && !isProbe) throw new NetworkError('No signal')
  if (simulateDeadSignal) {
    await new Promise((resolve) => setTimeout(resolve, isProbe ? PROBE_TIMEOUT_MS : timeoutMs))
    markOffline()
    throw new NetworkError('Simulated dead signal')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    markOnline()
    return res
  } catch {
    markOffline()
    throw new NetworkError('No signal')
  } finally {
    clearTimeout(timer)
  }
}

export function isOnline() {
  return status === 'online'
}

export function onReconnect(fn) {
  reconnectHandlers.push(fn)
  return () => { reconnectHandlers = reconnectHandlers.filter((h) => h !== fn) }
}

function subscribe(fn) {
  listeners.push(fn)
  return () => { listeners = listeners.filter((l) => l !== fn) }
}

// 'online' | 'offline', re-rendering the caller when it changes.
export function useConnection() {
  return useSyncExternalStore(subscribe, () => status)
}

export function isSimulatingDeadSignal() {
  return simulateDeadSignal
}

export function setSimulateDeadSignal(on) {
  simulateDeadSignal = on
  try {
    if (on) sessionStorage.setItem(SIMULATE_KEY, '1')
    else sessionStorage.removeItem(SIMULATE_KEY)
  } catch { /* unavailable — lasts until reload */ }
  if (!on && status === 'offline') scheduleProbe(0)
  notify()
}
