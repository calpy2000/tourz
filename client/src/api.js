import { getSession, clearSession } from './localSession.js';
import { API_BASE } from './apiBase.js';

const BASE = `${API_BASE}/api/game`;

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
// still being set) because HomePage/ChatPanel/GameHeader all fire their own authenticated
// requests independently on mount — the first 401 to resolve already clears the session, so a
// gate would let every other in-flight request fall through and hand its raw error body to
// whatever called it. clearSession() and the redirect are both idempotent, so firing them again
// per concurrent 401 is harmless. The never-resolving promise is deliberate: navigation is about
// to unmount everything, so no caller should act on this response.
function handleResponse(res) {
  if (res.status === 401) {
    clearSession();
    window.location.href = '/';
    return new Promise(() => {});
  }
  return res.json();
}

async function get(path) {
  const res = await fetch(path, { headers: authHeaders() });
  return handleResponse(res);
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  return handleResponse(res);
}

export const api = {
  register: (payload) => post(`${API_BASE}/api/register`, payload),
  getSession: () => get(`${BASE}/session`),
  setTeamName: (name) => post(`${BASE}/team/name`, { name }),
  getHome: () => get(`${BASE}/home`),
  getCurrent: () =>
    get(`${BASE}/current`).then((data) => {
      if (data._dev) {
        console.log(`%c[TOURZ DEV] Puzzle answer: ${data._dev.puzzleAnswer}`, 'color:#b3261e;font-weight:bold');
        console.log('%c[TOURZ DEV] Quiz answers:', 'color:#b3261e;font-weight:bold');
        console.table(data._dev.quizAnswers);
      }
      return data;
    }),
  requestHint: () => post(`${BASE}/clue/hint`),
  requestReveal: () => post(`${BASE}/clue/reveal`),
  submitPuzzleAnswer: (answer) => post(`${BASE}/puzzle/answer`, { answer }),
  submitQuizAnswer: (questionId, answer) => post(`${BASE}/quiz/answer`, { questionId, answer }),
  advance: () => post(`${BASE}/advance`),
  getMessages: (after) => get(`${BASE}/messages${after ? `?after=${after}` : ''}`),
  sendMessage: (text) => post(`${BASE}/messages`, { text }),
  getLandmarkDetail: (sequenceOrder) => get(`${BASE}/landmark/${sequenceOrder}`),
  getSiteDetail: (id) => get(`${BASE}/site/${id}`),
  getMap: () => get(`${BASE}/map`),
  getRoute: () => get(`${BASE}/route`),
  getNearbyPlaces: (category) => get(`${API_BASE}/api/places/nearby?category=${category}`),
  devLogin: () => post(`${API_BASE}/api/dev/login`),
  devReset: () => post(`${API_BASE}/api/dev/reset`),
  devComplete: (count) => post(`${API_BASE}/api/dev/complete/${count}`),
  getPoiDrafts: () => fetch(`${API_BASE}/api/dev/poi-drafts`).then((r) => r.json()),
};
