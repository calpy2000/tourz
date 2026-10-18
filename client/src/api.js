import { getSession, clearSession } from './localSession.js';
import { API_BASE } from './apiBase.js';
import { request } from './net/connection.js';

const BASE = `${API_BASE}/api/game`;

// Hard timeouts on every request (see net/connection.js for why) — reads fail fast, the sync batch
// gets longer since it can carry a certificate image.
const GET_TIMEOUT_MS = 10000;
const POST_TIMEOUT_MS = 15000;
const SYNC_TIMEOUT_MS = 25000;

function authHeaders() {
  const session = getSession();
  return session?.sessionToken ? { 'X-Session-Token': session.sessionToken } : {};
}

// A 401 means the stored session token is no longer valid server-side (e.g. a DB reset since it
// was issued) — RequireSession only checks that *a* token exists, not that the server still
// honors it, so without this every page assumes the error body is real data and crashes trying
// to read fields that were never there. Clearing the session and hard-navigating to "/" (not
// react-router, since api.js has no router context) re-triggers registration/dev-login cleanly
// instead of a blank page. Unconditional on the 401 status alone (not gated on getSession()
// still being set) because several parts of the app fire their own authenticated requests
// independently — the first 401 to resolve already clears the session, so a gate would let every
// other in-flight request fall through and hand its raw error body to whatever called it.
// clearSession() and the redirect are both idempotent, so firing them again per concurrent 401 is
// harmless. The never-resolving promise is deliberate: navigation is about to unmount everything,
// so no caller should act on this response.
//
// Only when the request actually carried a token, though (sentToken) — a 401 for a request sent
// with no session at all isn't an expired login, just a call made before registration. Found
// 2026-10-18: NarrationPlayer's bonus poller fired straight after the GPS gate, before login, and
// this reload made every new iPhone player's map ask for location a second time (a reloaded
// page is a new document to Safari, so its earlier Allow no longer counts).
//
// A body that isn't JSON (e.g. a hosting provider's HTML error page) comes back as an ordinary
// { error } object rather than throwing, same as any other server-side failure.
async function handleResponse(res, sentToken) {
  if (res.status === 401 && sentToken) {
    clearSession();
    window.location.href = '/';
    return new Promise(() => {});
  }
  try {
    return await res.json();
  } catch {
    return { error: `Server error (${res.status}) — try again.`, status: res.status };
  }
}

async function get(path, timeoutMs = GET_TIMEOUT_MS) {
  const headers = authHeaders();
  const res = await request(path, { headers }, timeoutMs);
  return handleResponse(res, Boolean(headers['X-Session-Token']));
}

async function post(path, body, timeoutMs = POST_TIMEOUT_MS) {
  const auth = authHeaders();
  const res = await request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: body ? JSON.stringify(body) : undefined,
  }, timeoutMs);
  return handleResponse(res, Boolean(auth['X-Session-Token']));
}

// Every call can throw NetworkError (no signal / timed out). Gameplay itself no longer goes
// through the one-at-a-time action endpoints — it runs on the phone (offline/engine.js) and is
// sent in batches through sync() by offline/gameStore.js.
export const api = {
  register: (payload) => post(`${API_BASE}/api/register`, payload),
  getSession: () => get(`${BASE}/session`),
  setTeamName: (name) => post(`${BASE}/team/name`, { name }),
  getTeamPlayers: () => get(`${BASE}/team/players`),
  changeCaptain: (newCaptainId) => post(`${BASE}/team/captain`, { newCaptainId }),
  getCertificateStatus: () => get(`${BASE}/certificate`),
  getLandmarkDetail: (sequenceOrder) => get(`${BASE}/landmark/${sequenceOrder}`),
  getSiteDetail: (id) => get(`${BASE}/site/${id}`),
  getMap: () => get(`${BASE}/map`),
  getState: (version) => get(`${BASE}/state${version ? `?v=${encodeURIComponent(version)}` : ''}`),
  sync: (actions) => post(`${BASE}/sync`, { actions }, SYNC_TIMEOUT_MS),
  getTourPack: () => get(`${BASE}/tour-pack`),
  devLogin: () => post(`${API_BASE}/api/dev/login`),
  devReset: () => post(`${API_BASE}/api/dev/reset`),
  devComplete: (count) => post(`${API_BASE}/api/dev/complete/${count}`),
  devClock: (action, minutes) => post(`${API_BASE}/api/dev/clock`, { action, minutes }),
};
