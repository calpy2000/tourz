import { useSyncExternalStore } from 'react'
import { api } from '../api.js'
import { getSession, saveSession } from '../localSession.js'
import { isOnline, onReconnect } from '../net/connection.js'
import { DEV_MODE } from '../devMode.js'
import { idbGet, idbSet } from './idb.js'
import { unsealJson } from './seal.js'
import { applyAction } from './engine.js'
import { logDebug } from '../debugLog.js'

// The phone's copy of the game, and the queue ("outbox") of actions waiting to reach the server.
//
// - serverState: the last GET /api/game/state (or POST /sync) response, landmark packages
//   unsealed. Saved to IndexedDB, so a reload in a dead spot still has the whole game.
// - outbox: every action the player has taken that the server hasn't confirmed yet, in order.
//   Also saved, so a closed tab or a reload never loses one.
// - state: serverState with the outbox re-applied on top (engine.applyAction) — what every screen
//   shows. An action takes effect on screen the instant it's tapped, signal or not.
//
// One loop keeps it fresh: every POLL_MS while there's signal and the page is visible, either send
// the outbox (POST /sync returns the new server state with it) or, with nothing queued, ask for the
// state with ?v=<version> (a tiny "unchanged" reply unless something moved). This one request
// replaces the three separate 4s polls the app used to run (current landmark, clock, narration).

const POLL_MS = 4000
const MAX_SERVER_ERROR_RETRIES = 5

let token = null
let serverState = null
let outbox = []
let state = null
let notices = []
let actionOutcomes = {} // { [actionId]: { status: 'done' | 'rejected', body } }
let snapshot = makeSnapshot()
let listeners = []
let started = false
let loadPromise = null
let syncing = null

let clockOffsetMs = 0 // server time minus this phone's clock

const stateKey = () => `game-state:${token}`
const outboxKey = () => `outbox:${token}`

function makeSnapshot() {
  return { state, ready: Boolean(state), pendingCount: outbox.length, notices, outcomes: actionOutcomes }
}

function emit() {
  snapshot = makeSnapshot()
  listeners.forEach((fn) => fn())
}

export function serverNow() {
  return Date.now() + clockOffsetMs
}

function newId() {
  try { return crypto.randomUUID() } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}` }
}

// Turns a /state response into the engine's state: landmarks keyed by sequence, sealed packages
// opened with this player's session token.
function toEngineState(raw) {
  const landmarks = {}
  for (const l of raw.landmarks) {
    if (l.sealed) {
      try {
        landmarks[l.seq] = { seq: l.seq, playable: l.playable, ...unsealJson(l.sealed, `${token}:${l.seq}`) }
      } catch {
        // Unreadable package — treat as not downloaded; the next refresh brings a fresh one.
      }
    } else {
      landmarks[l.seq] = l
    }
  }
  return { ...raw, landmarks }
}

function recompute() {
  if (!serverState) {
    state = null
    return
  }
  let s = serverState
  for (const action of outbox) {
    const out = applyAction(s, action)
    // Refused against the current server state (e.g. the server already applied it, or the
    // captaincy moved) — the server will refuse it too; it's simply not shown.
    if (!out.error) s = out.state
  }
  state = s
}

function logDevAnswers(prev, next) {
  if (!DEV_MODE || !next) return
  const seq = next.team.currentSequence
  if (prev && prev.team.currentSequence === seq) return
  const lm = next.landmarks[seq]
  if (!lm?.puzzle) return
  console.log(`%c[TOURZ DEV] Puzzle answer: ${lm.puzzle.readable}`, 'color:#b3261e;font-weight:bold')
  console.log('%c[TOURZ DEV] Quiz answers:', 'color:#b3261e;font-weight:bold')
  console.table(lm.quiz.map((q) => ({
    question: q.questionText,
    answer: q.type === 'five_right' ? q.payload.tiles.filter((t) => t.correct).map((t) => t.name).join(', ')
      : q.type === 'anagram' ? q.payload.solution : q.payload.correct,
  })))
}

// `live` = just arrived from the server (vs. loaded from the saved copy). The server-time offset is
// only measured on live responses — a saved copy's serverNow is however old the copy is, and
// measuring against it shifted every tap time made after an offline reopen into the past (caught
// by the 2026-10-18 end-to-end test). receivedAt is saved with the copy so the offset survives.
function setServerState(raw, { live = true } = {}) {
  const prev = state
  if (live) raw = { ...raw, receivedAt: Date.now() }
  clockOffsetMs = raw.serverNow - (raw.receivedAt ?? Date.now())
  serverState = toEngineState(raw)
  if (live) idbSet(stateKey(), raw)
  // The captain flag is also kept in the session (several screens read it from there) — keep the
  // two in step, so a captain handoff by a teammate takes effect on this phone too.
  const session = getSession()
  if (session && session.isCaptain !== raw.player.isCaptain) saveSession({ ...session, isCaptain: raw.player.isCaptain })
  recompute()
  logDevAnswers(prev, state)
  emit()
}

function saveOutbox() {
  idbSet(outboxKey(), outbox)
}

function addNotice(text) {
  const notice = { id: newId(), text }
  notices = [...notices, notice]
  emit()
  setTimeout(() => {
    notices = notices.filter((n) => n.id !== notice.id)
    emit()
  }, 8000)
}

// Loads the saved copy for the current session (once per token). Resolves once there's something
// to show, or once it's clear there's nothing saved and nothing reachable.
function load() {
  const session = getSession()
  const nextToken = session?.sessionToken || null
  if (nextToken !== token) {
    token = nextToken
    serverState = null
    state = null
    outbox = []
    actionOutcomes = {}
    loadPromise = null
    emit()
  }
  if (!token) return Promise.resolve(null)
  if (!loadPromise) {
    const forToken = token
    loadPromise = (async () => {
      const [savedState, savedOutbox] = await Promise.all([idbGet(stateKey()), idbGet(outboxKey())])
      if (forToken !== token) return state
      if (Array.isArray(savedOutbox)) outbox = savedOutbox
      if (savedState) {
        setServerState(savedState, { live: false })
        // Show the saved copy straight away; freshen it in the background.
        syncNow()
        return state
      }
      // Nothing saved yet (first open on this phone) — this one has to wait for the server.
      if (isOnline()) await syncNow()
      return state
    })()
  }
  return loadPromise
}

function applyResults(results) {
  const byId = Object.fromEntries(results.map((r) => [r.id, r]))
  const keep = []
  for (const action of outbox) {
    const r = byId[action.id]
    if (!r) { keep.push(action); continue }
    if (r.status >= 200 && r.status < 300) {
      actionOutcomes = { ...actionOutcomes, [action.id]: { status: 'done', body: r.body } }
      continue
    }
    // Still being processed (another copy of the same batch) — leave it for the next round.
    if (r.body?.retry) { keep.push(action); continue }
    if (r.status >= 500) {
      action.serverErrors = (action.serverErrors || 0) + 1
      if (action.serverErrors < MAX_SERVER_ERROR_RETRIES) { keep.push(action); continue }
    }
    // Refused for good. The screen snaps back to the server's version of events; say why.
    actionOutcomes = { ...actionOutcomes, [action.id]: { status: 'rejected', body: r.body } }
    if (action.wasOffline) addNotice(`Couldn't save something you did with no signal: ${r.body?.error || 'it was refused.'}`)
    else if (r.body?.error) addNotice(r.body.error)
  }
  outbox = keep
  saveOutbox()
}

// One round: send what's queued (and get the new state back with it), or just refresh.
export function syncNow() {
  if (!token || !isOnline()) return Promise.resolve()
  if (syncing) return syncing
  let sentIds = new Set()
  syncing = (async () => {
    try {
      if (outbox.length) {
        const batch = outbox.slice(0, 50)
        sentIds = new Set(batch.map((a) => a.id))
        logDebug('sync send', batch.map((a) => a.type).join(','))
        const res = await api.sync(batch.map(({ id, type, payload, clientTime }) => ({
          id, type, payload, clientTime: new Date(clientTime).toISOString(),
        })))
        logDebug('sync reply', res?.results ? res.results.map((r) => r.status + (r.duplicate ? 'd' : '')).join(',') : JSON.stringify(res).slice(0, 120))
        if (res?.results && res.state) {
          applyResults(res.results)
          setServerState(res.state)
        }
      } else {
        const res = await api.getState(serverState?.version)
        if (res?.unchanged) {
          clockOffsetMs = res.serverNow - Date.now()
        } else if (res?.team) {
          setServerState(res)
        }
      }
    } catch (err) {
      // No signal — net/connection.js has flipped to offline and will call us on the way back.
      logDebug('sync failed', String(err?.message || err))
    } finally {
      syncing = null
    }
    // Queued while that round was in flight (or more than one batch carries) — send it now rather
    // than on the next poll. Only for actions that weren't in the batch just sent, so a batch the
    // server asked to retry waits for the next poll instead of looping.
    if (isOnline() && outbox.some((a) => !sentIds.has(a.id))) setTimeout(syncNow, 0)
  })()
  return syncing
}

// Applies an action on the phone straight away and queues it for the server. Returns
// { id, result } (what the engine worked out — right/wrong, points, etc.) or { error } if the game
// rules refuse it, in which case nothing is queued.
export function enqueue(type, payload = {}) {
  if (!state) return { error: "The tour hasn't loaded on this phone yet." }
  const action = { id: newId(), type, payload, clientTime: serverNow(), wasOffline: !isOnline() }
  const out = applyAction(state, action)
  if (out.error) return { error: out.error, clockBlocked: out.clockBlocked }
  outbox = [...outbox, action]
  saveOutbox()
  state = out.state
  emit()
  syncNow()
  return { id: action.id, result: out.result }
}

function tick() {
  if (document.visibilityState === 'visible') syncNow()
}

// Starts (or re-points, after a login/logout) the store. Safe to call on every navigation.
export function startGameStore() {
  const p = load()
  if (!started) {
    started = true
    setInterval(tick, POLL_MS)
    onReconnect(() => syncNow())
    document.addEventListener('visibilitychange', tick)
  }
  return p
}

// Resolves with the state once the saved copy (and, with signal, a fresh one) has loaded.
export function gameStoreReady() {
  return load()
}

function subscribe(fn) {
  listeners.push(fn)
  return () => { listeners = listeners.filter((l) => l !== fn) }
}

// { state, ready, pendingCount, notices, outcomes } — re-renders the caller on any change.
export function useGameStore() {
  return useSyncExternalStore(subscribe, () => snapshot)
}

export function getGameState() {
  return state
}
