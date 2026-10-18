import { useSyncExternalStore } from 'react'
import { api } from '../api.js'
import { API_BASE } from '../apiBase.js'
import { isOnline, onReconnect } from '../net/connection.js'
import { idbGet, idbSet } from './idb.js'

// Saves the tour onto the phone for offline use, while there's signal (normally during the
// instructions at the start):
//   1. the tour pack — every POI's full card (GET /api/game/tour-pack), kept in IndexedDB;
//   2. every photo and narration MP3 those cards and the landmarks this phone holds refer to, kept
//      in Cache Storage ('tourz-content-v1'), which the service worker (sw-template.js) serves
//      them from when they're requested with no signal.
// Order: landmark files first (the ones needed next), then POI photos, then POI audio (biggest).
// Already-saved files are skipped, so this is cheap to re-run — it runs again whenever the phone
// gets new landmarks (the rolling look-ahead) and whenever signal returns.

export const CONTENT_CACHE = 'tourz-content-v1'
const CONCURRENCY = 4

let pack = null
let packTourId = null
let progress = { total: 0, done: 0, failed: 0, running: false, complete: false }
let snapshot = { pack, progress }
let listeners = []
let queued = null // { urls } waiting for the current run to finish
let running = false
let persistAsked = false

function emit() {
  snapshot = { pack, progress }
  listeners.forEach((fn) => fn())
}

const packKey = (tourId) => `tour-pack:${tourId}`
export const contentUrl = (kind, file) => `${API_BASE}/content-${kind}/${file}`

// Loads the saved pack for this tour, then (with signal) refreshes it if the server's has changed.
export async function loadTourPack(tourId) {
  if (packTourId !== tourId) {
    packTourId = tourId
    pack = (await idbGet(packKey(tourId))) || null
    emit()
  }
  if (isOnline()) {
    try {
      const fresh = await api.getTourPack()
      if (fresh?.sites && fresh.version !== pack?.version) {
        pack = fresh
        idbSet(packKey(tourId), fresh)
        emit()
      }
    } catch {
      // No signal — keep whatever was saved.
    }
  }
  return pack
}

export function getTourPack() {
  return pack
}

export function siteDetailFromPack(id) {
  return pack?.sites.find((s) => String(s.id) === String(id)) || null
}

// Every file the phone should hold for this game state + tour pack, most-needed first.
export function assetUrlsFor(state, tourPack) {
  const urls = []
  if (state) {
    const seqs = Object.keys(state.landmarks).map(Number).sort((a, b) => {
      // The current landmark and the ones just ahead first, then the ones already passed.
      const cur = state.team.currentSequence
      return (a >= cur ? a - cur : 1000 + a) - (b >= cur ? b - cur : 1000 + b)
    })
    for (const seq of seqs) {
      const l = state.landmarks[seq]
      if (l.tileImage) urls.push(contentUrl('photos', l.tileImage))
      if (l.heroImage) urls.push(contentUrl('photos', l.heroImage))
      for (const q of l.quiz || []) {
        for (const t of q.payload?.tiles || []) if (t.imagePath) urls.push(contentUrl('photos', t.imagePath))
      }
      if (l.detail?.audioPath) urls.push(contentUrl('audio', l.detail.audioPath))
    }
  }
  if (tourPack) {
    for (const s of tourPack.sites) if (s.imagePath) urls.push(contentUrl('photos', s.imagePath))
    for (const s of tourPack.sites) if (s.audioPath) urls.push(contentUrl('audio', s.audioPath))
  }
  return [...new Set(urls)]
}

async function askPersistentStorage() {
  if (persistAsked) return
  persistAsked = true
  try {
    // Asks the browser not to clear this storage under pressure. Granted silently or not at all —
    // no prompt on any current browser.
    if (navigator.storage?.persist) await navigator.storage.persist()
  } catch { /* not supported */ }
}

async function runDownload(urls) {
  running = true
  let cache
  try {
    cache = await caches.open(CONTENT_CACHE)
  } catch {
    running = false
    return // Cache Storage unavailable (e.g. not a secure context) — nothing to do.
  }
  const missing = []
  for (const url of urls) {
    if (!(await cache.match(url))) missing.push(url)
  }
  progress = { total: urls.length, done: urls.length - missing.length, failed: 0, running: missing.length > 0, complete: missing.length === 0 }
  emit()
  if (missing.length) askPersistentStorage()

  let next = 0
  async function worker() {
    while (next < missing.length) {
      if (!isOnline()) return // resumes from onReconnect
      const url = missing[next++]
      try {
        const res = await fetch(url, { mode: 'cors' })
        if (res.ok) {
          await cache.put(url, res)
          progress = { ...progress, done: progress.done + 1 }
        } else {
          progress = { ...progress, failed: progress.failed + 1 }
        }
      } catch {
        progress = { ...progress, failed: progress.failed + 1 }
      }
      emit()
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  progress = { ...progress, running: false, complete: progress.done >= progress.total }
  emit()
  running = false
  if (queued) {
    const again = queued
    queued = null
    runDownload(again)
  }
}

// Saves any of these files not already on the phone. Calls while a run is going are folded into
// one follow-up run.
export function saveForOffline(urls) {
  if (!urls.length || typeof caches === 'undefined') return
  if (running) { queued = urls; return }
  runDownload(urls)
}

let lastUrls = []
onReconnect(() => { if (lastUrls.length) saveForOffline(lastUrls) })
export function rememberUrls(urls) {
  lastUrls = urls
}

function subscribe(fn) {
  listeners.push(fn)
  return () => { listeners = listeners.filter((l) => l !== fn) }
}

// { pack, progress: { total, done, failed, running, complete } }
export function useContentCache() {
  return useSyncExternalStore(subscribe, () => snapshot)
}
