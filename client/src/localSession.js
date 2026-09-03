// Per-device player identity, persisted so reopening the URL later skips registration — see
// project memory on registration. Not shared across browsers/devices by design (each teammate
// registers on their own phone).
const KEY = 'tourz.session';

export function getSession() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  localStorage.setItem(KEY, JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem(KEY);
}
