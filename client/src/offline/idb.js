// Minimal IndexedDB key/value store — just enough to keep the game state, the queue of actions
// waiting to sync, and the tour pack on the phone across reloads. localStorage was ruled out: it's
// synchronous, capped around 5MB, and the outbox can hold a certificate image. Every call degrades
// to a no-op/undefined if IndexedDB is unavailable (some private-browsing modes), so the app still
// works online, just without surviving a reload offline.

const DB_NAME = 'tourz'
const STORE = 'kv'
let dbPromise = null

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1)
        req.onupgradeneeded = () => req.result.createObjectStore(STORE)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
        req.onblocked = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }
  return dbPromise
}

function run(mode, fn) {
  return open().then((db) => new Promise((resolve) => {
    if (!db) return resolve(undefined)
    try {
      const tx = db.transaction(STORE, mode)
      const req = fn(tx.objectStore(STORE))
      tx.oncomplete = () => resolve(req?.result)
      tx.onerror = () => resolve(undefined)
      tx.onabort = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  }))
}

export const idbGet = (key) => run('readonly', (s) => s.get(key))
export const idbSet = (key, value) => run('readwrite', (s) => s.put(value, key))
export const idbDelete = (key) => run('readwrite', (s) => s.delete(key))
