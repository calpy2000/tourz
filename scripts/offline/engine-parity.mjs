// Checks that the phone's game engine (client/src/offline/engine.js) gives exactly the same
// answers as the server — the whole offline design depends on the two never disagreeing.
//
// Plays the LOCAL dev team (DEV-LOCAL) through several landmarks: every action is applied both by
// the engine on its own copy of the state AND by the real server (POST /api/game/sync), and after
// each step the engine's screens are compared field by field with the server's own endpoints
// (/current, /home, /map, /landmark/:n, /certificate, /clock). Mix of right/wrong answers, hints,
// a reveal and a clock stop/restart, across every quiz type the route reaches.
//
// LOCAL ONLY: refuses to run against anything but localhost. Resets the dev team's progress at the
// start and again at the end.
//
//   node scripts/offline/engine-parity.mjs [landmarkCount=5]

import { randomUUID } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

const BASE = process.env.TOURZ_API || 'http://localhost:3001'
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error(`Refusing to run against ${BASE} — local server only.`)
  process.exit(1)
}
const LANDMARKS = Number(process.argv[2]) || 5

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const engine = await import(pathToFileURL(path.join(root, 'client/src/offline/engine.js')).href)
const { unsealJson } = await import(pathToFileURL(path.join(root, 'client/src/offline/seal.js')).href)

const login = await (await fetch(`${BASE}/api/dev/login`, { method: 'POST' })).json()
const token = login.sessionToken
const H = { 'X-Session-Token': token, 'Content-Type': 'application/json' }
const get = async (p) => (await fetch(BASE + p, { headers: H })).json()
const post = async (p, b) => (await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(b || {}) })).json()

function toEngineState(raw) {
  const landmarks = {}
  for (const l of raw.landmarks) {
    landmarks[l.seq] = l.sealed ? { seq: l.seq, playable: l.playable, ...unsealJson(l.sealed, `${token}:${l.seq}`) } : l
  }
  return { ...raw, landmarks }
}

let failures = 0
let checks = 0
// Compares two values, treating number-vs-numeric-string as equal (pg returns bigint as string) and
// ignoring keys listed in `skip`.
function same(a, b) {
  if (a === b) return true
  if (a == null || b == null) return a == b
  if (typeof a !== 'object' || typeof b !== 'object') return String(a) === String(b)
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if (!same(a[k], b[k])) return false
  return true
}
function diffPaths(a, b, at = '') {
  if (same(a, b)) return []
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return [`${at || '(root)'}: engine=${JSON.stringify(a)} server=${JSON.stringify(b)}`]
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].flatMap((k) => diffPaths(a[k], b[k], at ? `${at}.${k}` : k))
}
function check(label, engineValue, serverValue, skip = []) {
  checks++
  const strip = (o) => {
    if (!o || typeof o !== 'object') return o
    const c = { ...o }
    for (const k of skip) delete c[k]
    return c
  }
  const diffs = diffPaths(strip(engineValue), strip(serverValue))
  if (diffs.length) {
    failures++
    console.log(`  ✗ ${label}`)
    diffs.slice(0, 8).forEach((d) => console.log(`      ${d}`))
  }
}

async function compareAll(local, step) {
  const now = Date.now()
  const [current, home, map, cert, clock] = await Promise.all([
    get('/api/game/current'), get('/api/game/home'), get('/api/game/map'), get('/api/game/certificate'), get('/api/game/clock'),
  ])
  check(`${step} /current`, engine.currentView(local), current, ['_dev'])
  check(`${step} /home`, engine.homeView(local), home)
  const m = engine.mapLandmarksView(local)
  check(`${step} /map landmarks`, { solvedLandmarks: m.solvedLandmarks, currentRevealed: m.currentRevealed }, { solvedLandmarks: map.solvedLandmarks, currentRevealed: map.currentRevealed })
  check(`${step} /certificate`, engine.certificateView(local, now), cert, ['elapsedSeconds', 'completedAt'])
  const cv = engine.clockView(local, now)
  check(`${step} /clock`, cv, clock, ['remainingSeconds'])
  if (Math.abs(cv.remainingSeconds - clock.remainingSeconds) > 2) {
    failures++
    console.log(`  ✗ ${step} /clock remainingSeconds engine=${cv.remainingSeconds} server=${clock.remainingSeconds}`)
  }
  for (let seq = 1; seq <= local.team.currentSequence; seq++) {
    const serverDetail = await get(`/api/game/landmark/${seq}`)
    const engineDetail = engine.landmarkDetailView(local, seq)
    if (serverDetail.error) {
      checks++
      if (engineDetail) { failures++; console.log(`  ✗ ${step} /landmark/${seq}: server refuses, engine shows it`) }
    } else {
      check(`${step} /landmark/${seq}`, engineDetail, serverDetail)
    }
  }
}

// Applies one action both ways: engine on `local`, server via sync. Returns the new local state
// and the fresh server state (engine-unsealed), and checks both agreed it was allowed.
let local
async function both(type, payload) {
  const action = { id: randomUUID(), type, payload, clientTime: Date.now() }
  const out = engine.applyAction(local, action)
  const res = await post('/api/game/sync', { actions: [{ ...action, clientTime: new Date(action.clientTime).toISOString() }] })
  const r = res.results[0]
  checks++
  const serverOk = r.status >= 200 && r.status < 300
  if (Boolean(out.error) === serverOk) {
    failures++
    console.log(`  ✗ ${type} ${JSON.stringify(payload)}: engine ${out.error ? `refused (${out.error})` : 'allowed'}, server ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`)
  }
  if (!out.error) local = out.state
  // Re-base on the server's state so later steps start from truth, like the real store does.
  const fresh = toEngineState(res.state)
  check(`${type} -> team`, local.team, fresh.team)
  check(`${type} -> clock`, { ...local.clock }, fresh.clock)
  local = fresh
  return r
}

console.log(`Parity check against ${BASE}, ${LANDMARKS} landmarks`)
await post('/api/dev/reset')
await post('/api/dev/clock', { action: 'minutes-left', minutes: 150 })
local = toEngineState(await get('/api/game/state'))
await compareAll(local, 'start')

for (let i = 0; i < LANDMARKS; i++) {
  const seq = local.team.currentSequence
  const lm = local.landmarks[seq]
  if (!lm?.clue) { console.log(`  (no package for landmark ${seq}, stopping)`); break }
  const step = `L${seq}`
  console.log(`- landmark ${seq}: ${lm.title} (${lm.quiz[0]?.type || 'no quiz'})`)

  if (i % 3 === 1) await both('hint', { hintNumber: 1 })
  if (i % 3 === 1) await both('hint', { hintNumber: 1 }) // double tap — must not spend hint 2
  if (i % 4 === 2) await both('reveal', {})
  if (i === 1) { await both('clock_stop', {}); await both('puzzle', { answer: 'x' }); await both('clock_restart', {}) }
  await compareAll(local, `${step} before answer`)

  const answer = i === 3 ? 'definitely wrong' : lm.puzzle.type === 'exact_numeric' ? lm.puzzle.answer.answer : lm.puzzle.answer.accepted[0]
  await both('puzzle', { answer })
  await both('puzzle', { answer }) // second attempt must be refused both ways
  await compareAll(local, `${step} after puzzle`)

  for (const [qi, q] of lm.quiz.entries()) {
    let ans
    if (q.type === 'five_right') ans = q.payload.tiles.filter((t, ti) => (ti % 2 ? t.correct : !t.correct)).map((t) => t.id)
    else if (q.type === 'anagram') ans = qi % 2 ? q.payload.solution : q.payload.scrambled
    else ans = qi % 2 ? q.payload.correct : q.payload.options.find((o) => o !== q.payload.correct)
    await both('quiz', { questionId: q.id, answer: ans })
    await compareAll(local, `${step} after quiz q${qi + 1}`)
  }
  await both('advance', {})
  await both('advance', {}) // must be refused: next landmark isn't complete
  await compareAll(local, `${step} after advance`)
}

await both('narration', { siteId: (await get('/api/game/tour-pack')).sites.find((s) => s.audioPath).id })
await post('/api/dev/reset')
console.log(`\n${checks} checks, ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
