import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Lets a temporary tunnel URL (e.g. *.trycloudflare.com) reach the dev server — Vite
    // otherwise rejects requests whose Host header it doesn't recognize. Fine for a throwaway
    // local test; a real deployment would list specific hosts instead of allowing all.
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:3001',
      '/content-photos': 'http://localhost:3001',
    },
  },
})
