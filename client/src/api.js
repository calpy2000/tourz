import { getSession } from './localSession.js';

const BASE = '/api/game';

function authHeaders() {
  const session = getSession();
  return session?.sessionToken ? { 'X-Session-Token': session.sessionToken } : {};
}

async function get(path) {
  const res = await fetch(path, { headers: authHeaders() });
  return res.json();
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

export const api = {
  register: (payload) => post('/api/register', payload),
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
  getNearbyPlaces: (category) => get(`/api/places/nearby?category=${category}`),
  devLogin: () => post('/api/dev/login'),
  devReset: () => post('/api/dev/reset'),
  devComplete: (count) => post(`/api/dev/complete/${count}`),
  getPoiDrafts: () => fetch('/api/dev/poi-drafts').then((r) => r.json()),
};
