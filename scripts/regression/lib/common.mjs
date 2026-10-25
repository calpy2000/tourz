// Shared bits for the regression suite (see ../run-all.mjs): result recording, the local DB, a
// small API client, and the throwaway game codes every phase plays with.
//
// LOCAL ONLY. Every phase talks to the local Postgres `tourz` database and to a server on
// localhost — nothing here can reach production (no connection strings are read from anywhere).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const OUT = process.env.REGRESSION_OUT || path.join(os.tmpdir(), 'tourz-regression')
fs.mkdirSync(OUT, { recursive: true })

// Throwaway game codes all start with this, so a crashed run's leftovers are easy to find and the
// cleanup can never touch a real code.
export const CODE_PREFIX = 'ZZ-REG-'

// ---- results --------------------------------------------------------------------------------
// One recorder per phase. `check` never throws — a failed check is recorded and the phase carries
// on, so one broken feature doesn't hide every other result.
export function makeRecorder(phase) {
  const results = []
  const rec = (name, ok, detail = '') => {
    results.push({ phase, name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) })
    console.log(`${ok ? 'PASS' : 'FAIL'}  [${phase}] ${name}${detail ? ` — ${detail}` : ''}`)
    return Boolean(ok)
  }
  rec.warn = (name, detail = '') => {
    results.push({ phase, name, ok: true, warn: true, detail: String(detail) })
    console.log(`WARN  [${phase}] ${name}${detail ? ` — ${detail}` : ''}`)
  }
  rec.results = results
  // Runs a block; an exception inside it becomes one FAIL instead of ending the whole phase.
  rec.section = async (name, fn) => {
    try { await fn() } catch (err) { rec(`${name} (section crashed)`, false, err?.stack?.split('\n').slice(0, 3).join(' | ') || err) }
  }
  return rec
}

// ---- local database ---------------------------------------------------------------------------
export async function localDb() {
  const client = new pg.Client({ host: 'localhost', port: 5432, user: 'postgres', database: 'tourz' })
  await client.connect()
  return client
}

export async function createTestCode(db, { tourCode, maxPlayers = 4, status = 'unused', label = '' }) {
  const code = `${CODE_PREFIX}${label ? `${label}-` : ''}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase()
  const { rows: [tour] } = await db.query('SELECT id FROM tours WHERE tour_code = $1', [tourCode])
  if (!tour) throw new Error(`no tour "${tourCode}" in the local database`)
  await db.query(
    `INSERT INTO game_codes (code, tour_id, max_players, status, expires_at) VALUES ($1, $2, $3, $4, now() + interval '30 days')`,
    [code, tour.id, maxPlayers, status]
  )
  return code
}

// Removes every ZZ-REG-* code and everything played with it. Same order as
// scripts/game-codes/delete-game-codes.js, plus narration_listens.
export async function deleteTestCodes(db) {
  const { rows: codes } = await db.query(`SELECT id FROM game_codes WHERE code LIKE $1`, [`${CODE_PREFIX}%`])
  for (const { id } of codes) {
    const { rows: games } = await db.query('SELECT id FROM games WHERE game_code_id = $1', [id])
    for (const game of games) {
      const { rows: teams } = await db.query('SELECT id FROM teams WHERE game_id = $1', [game.id])
      for (const team of teams) {
        await db.query('DELETE FROM location_pings WHERE player_id IN (SELECT id FROM players WHERE team_id = $1)', [team.id])
        await db.query('DELETE FROM client_actions WHERE team_id = $1', [team.id])
        await db.query('DELETE FROM narration_listens WHERE team_id = $1', [team.id])
        await db.query('DELETE FROM progress_events WHERE team_id = $1', [team.id])
        await db.query('DELETE FROM players WHERE team_id = $1', [team.id])
        await db.query('DELETE FROM teams WHERE id = $1', [team.id])
      }
      await db.query('DELETE FROM games WHERE id = $1', [game.id])
    }
    await db.query('DELETE FROM game_codes WHERE id = $1', [id])
  }
  return codes.length
}

// ---- API client --------------------------------------------------------------------------------
export function apiClient(base) {
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error(`Refusing to test ${base} — local servers only.`)
  return async function call(method, p, { token, body, headers = {} } = {}) {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Session-Token': token } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers }
  }
}

// The phone's copy of upcoming landmarks comes sealed (see server sealJson); unsealed here exactly
// as the app does it, to know the right answers without reading the DB directly.
const { unsealJson } = await import(pathToFileURL(path.join(root, 'client/src/offline/seal.js')).href)
export function unsealLandmark(state, token, seq) {
  const l = state.landmarks.find((x) => x.seq === seq)
  if (!l) return null
  return l.sealed ? unsealJson(l.sealed, `${token}:${seq}`) : l
}

export function readableAnswer(puzzle) {
  return puzzle.type === 'exact_numeric' ? String(puzzle.answer.answer) : puzzle.answer.accepted[0]
}
