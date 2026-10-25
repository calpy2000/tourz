// Starts and stops the regression suite's own private copy of the app, so a run never touches
// whatever you already have running on :3001 / :4173 / :5173:
//
//   API     http://localhost:3101  — server/index.js against the local DB, with MAIL_TRANSPORT=json
//                                    (emails are built in full but never sent)
//   client  http://localhost:4180  — a fresh PRODUCTION-style build (dev mode OFF, so the real
//                                    registration screens show), built into a temp folder outside
//                                    the repo and pointed at the API above
//
// Both are child processes of this script and are killed when it finishes.

import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { root, OUT, sleep } from './common.mjs'

export const API_PORT = 3101
export const APP_PORT = 4180
export const API = `http://localhost:${API_PORT}`
export const APP = `http://localhost:${APP_PORT}`
const BUILD_DIR = path.join(OUT, 'client-build')

const children = []

export function pidOnPort(port) {
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8' })
    const line = out.split('\n').find((l) => l.includes(`:${port} `) && l.includes('LISTENING'))
    return line ? Number(line.trim().split(/\s+/).pop()) : null
  } catch { return null }
}

async function waitHttp(url, ms = 30000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true } catch { /* not up yet */ }
    await sleep(300)
  }
  return false
}

function logStream(name) {
  return fs.openSync(path.join(OUT, `${name}.log`), 'w')
}

export async function startApi() {
  // Belt and braces: the server picks its database from DATABASE_URL (local Postgres when unset).
  // Never start the test server if anything could point it at another database.
  const envFile = fs.readFileSync(path.join(root, 'server/.env'), 'utf8')
  if (/^\s*DATABASE_URL\s*=/m.test(envFile)) throw new Error('server/.env sets DATABASE_URL — refusing to run tests against a non-local database')
  if (pidOnPort(API_PORT)) throw new Error(`port ${API_PORT} is already in use — is another regression run going?`)
  const env = { ...process.env, PORT: String(API_PORT), MAIL_TRANSPORT: 'json' }
  delete env.DATABASE_URL
  delete env.EXPOSE_DEV_ANSWERS
  const log = logStream('api-server')
  const child = spawn(process.execPath, ['index.js'], { cwd: path.join(root, 'server'), env, stdio: ['ignore', log, log] })
  children.push(child)
  if (!(await waitHttp(`${API}/api/health`))) throw new Error(`test API did not start — see ${path.join(OUT, 'api-server.log')}`)
}

export function buildClient() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true })
  // Real env vars win over client/.env.local and .env.production in Vite, so this build has dev
  // mode off and talks to the test API, whatever those files say.
  execSync(`node node_modules/vite/bin/vite.js build --outDir "${BUILD_DIR}" --emptyOutDir`, {
    cwd: path.join(root, 'client'),
    env: { ...process.env, VITE_DEV_MODE: 'false', VITE_API_BASE_URL: API },
    stdio: ['ignore', fs.openSync(path.join(OUT, 'client-build.log'), 'w'), fs.openSync(path.join(OUT, 'client-build.log'), 'a')],
  })
  return BUILD_DIR
}

export async function startClient() {
  if (pidOnPort(APP_PORT)) throw new Error(`port ${APP_PORT} is already in use — is another regression run going?`)
  const log = logStream('client-preview')
  const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--outDir', BUILD_DIR, '--port', String(APP_PORT), '--strictPort'], {
    cwd: path.join(root, 'client'), stdio: ['ignore', log, log],
  })
  children.push(child)
  if (!(await waitHttp(APP))) throw new Error(`test client did not start — see ${path.join(OUT, 'client-preview.log')}`)
}

export function stopAll() {
  for (const child of children.splice(0)) {
    try { execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' }) } catch { /* already gone */ }
  }
}
