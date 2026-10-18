import { getSession } from './localSession.js'

// In-memory "last thing we fetched" per endpoint, so switching MAP view <-> CURRENT landmark can
// draw straight away from the previous response instead of a loading screen, then quietly refresh
// in the background (stale-while-revalidate). Module-level like MapView's lastCamera, so it lives
// for this page visit only — a full reload starts empty. Keyed by session token so a different
// team signing in on the same device never sees the previous team's data, even for a frame.
const store = new Map()

export function getLastFetched(name) {
  const entry = store.get(name)
  return entry && entry.token === getSession()?.sessionToken ? entry.value : null
}

export function setLastFetched(name, value) {
  if (!value || value.error) return
  store.set(name, { token: getSession()?.sessionToken, value })
}
