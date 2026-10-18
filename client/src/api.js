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
// still being set) because HomePage/GameHeader/PlayPage all fire their own authenticated
// requests independently on mount — the first 401 to resolve already clears the session, so a
// gate would let every other in-flight request fall through and hand its raw error body to
// whatever called it. clearSession() and the redirect are both idempotent, so firing them again
// per concurrent 401 is harmless. The never-resolving promise is deliberate: navigation is about
// to unmount everything, so no caller should act on this response.
//
// Only when the request actually carried a token, though (sentToken) — a 401 for a request sent
// with no session at all isn't an expired login, just a call made before registration. Found
// 2026-10-18: NarrationPlayer's bonus poller fired straight after the GPS gate, before login, and
// this reload made every new iPhone player's map ask for location a second time (a reloaded
// page is a new document to Safari, so its earlier Allow no longer counts).
function handleResponse(res, sentToken) {
  if (res.status === 401 && sentToken) {
    clearSession();
    window.location.href = '/';
    return new Promise(() => {});
  }
  return res.json();
}

async function get(path) {
  const headers = authHeaders();
  const res = await fetch(path, { headers });
  return handleResponse(res, Boolean(headers['X-Session-Token']));
}

async function post(path, body) {
  const auth = authHeaders();
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  return handleResponse(res, Boolean(auth['X-Session-Token']));
}

export const api = {
  register: (payload) => post(`${API_BASE}/api/register`, payload),
  getSession: () => get(`${BASE}/session`),
  setTeamName: (name) => post(`${BASE}/team/name`, { name }),
  getTeamPlayers: () => get(`${BASE}/team/players`),
  changeCaptain: (newCaptainId) => post(`${BASE}/team/captain`, { newCaptainId }),
  sendProblemReport: (message) => post(`${BASE}/problem-report`, { message }),
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
  getCertificateStatus: () => get(`${BASE}/certificate`),
  markInstructionsComplete: () => post(`${BASE}/instructions-complete`),
  markCoachComplete: () => post(`${BASE}/coach-complete`),
  sendCertificate: (email, imageDataUrl) => post(`${BASE}/certificate/send`, { email, imageDataUrl }),
  getLandmarkDetail: (sequenceOrder) => get(`${BASE}/landmark/${sequenceOrder}`),
  getSiteDetail: (id) => get(`${BASE}/site/${id}`),
  completeNarrationListen: (payload) => post(`${BASE}/narration/complete`, payload),
  getLatestNarrationBonus: () => get(`${BASE}/narration/latest`),
  getClock: () => get(`${BASE}/clock`),
  stopClock: () => post(`${BASE}/clock/stop`),
  restartClock: () => post(`${BASE}/clock/restart`),
  getMap: () => get(`${BASE}/map`),
  getRoute: () => get(`${BASE}/route`),
  devLogin: () => post(`${API_BASE}/api/dev/login`),
  devReset: () => post(`${API_BASE}/api/dev/reset`),
  devComplete: (count) => post(`${API_BASE}/api/dev/complete/${count}`),
  devClock: (action, minutes) => post(`${API_BASE}/api/dev/clock`, { action, minutes }),
};
