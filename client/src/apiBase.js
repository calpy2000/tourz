// Empty string in local dev — Vite's proxy (vite.config.js) forwards relative /api and
// /content-photos requests to the local server. In production, VITE_API_BASE_URL points
// at the deployed Render backend, since the built client is served from a different
// origin (Cloudflare Pages) with no such proxy.
export const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
