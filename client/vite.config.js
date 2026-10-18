import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const here = path.dirname(fileURLToPath(import.meta.url))

// Builds dist/sw.js from sw-template.js with the full list of this build's files, so the service
// worker can save the whole app on the phone at install (see sw-template.js). Build only — the dev
// server never registers a service worker (see main.jsx), so `npm run dev` behaves as before.
function tourzServiceWorker() {
  return {
    name: 'tourz-service-worker',
    apply: 'build',
    generateBundle(_, bundle) {
      const publicFiles = fs.readdirSync(path.join(here, 'public')).map((f) => `/${f}`)
      const built = Object.keys(bundle).filter((f) => !f.endsWith('.map')).map((f) => `/${f}`)
      const shell = [...new Set(['/', ...built, ...publicFiles])]
      const source = fs.readFileSync(path.join(here, 'sw-template.js'), 'utf8')
        .replaceAll('__BUILD_ID__', Date.now().toString(36))
        .replaceAll('__SHELL_FILES__', JSON.stringify(shell))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tourzServiceWorker()],
  server: {
    // Lets a temporary tunnel URL (e.g. *.trycloudflare.com) reach the dev server — Vite
    // otherwise rejects requests whose Host header it doesn't recognize. Fine for a throwaway
    // local test; a real deployment would list specific hosts instead of allowing all.
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:3001',
      '/content-photos': 'http://localhost:3001',
      '/content-audio': 'http://localhost:3001',
    },
  },
})
