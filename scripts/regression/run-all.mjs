// TOURZ full regression test — run any time, on this PC, against the LOCAL app and database.
//
//   node scripts/regression/run-all.mjs                 everything (~10–15 min)
//   node scripts/regression/run-all.mjs --quick         skip the slow browser phases (ui + offline)
//   node scripts/regression/run-all.mjs --only=api,ui   just those phases
//   node scripts/regression/run-all.mjs --skip=offline  everything but those
//
// Phases (in order):
//   deps      npm security audit of the website, server and scripts
//   build     the website builds (a production-style build, dev mode off)
//   content   tour content in the DB + files on disk (photos, MP3s, quizzes, map pins, narration
//             text vs audio) — scripts/regression/content.mjs
//   api       every API endpoint and game rule, playing every tour start to finish —
//             scripts/regression/api.mjs
//   ui        the real app in headless Chrome: two phones, registration → certificate —
//             scripts/regression/ui.mjs
//   parity    the phone's offline game engine agrees with the server, every landmark —
//             scripts/offline/engine-parity.mjs
//   offline   the two offline-play browser tests — scripts/offline/e2e-offline*.mjs (these use
//             :3001 + :4173 and the DEV-LOCAL team, and restart those two servers as they go)
//
// Everything except `offline` runs on the suite's own private servers (API :3101 with emails
// switched to a no-send transport, website :4180), so it doesn't disturb what you have running.
// Test teams use throwaway ZZ-REG-* game codes, deleted at the end (and at the start, in case a
// previous run crashed). Never touches production: no production connection string is read.
//
// Output: PASS/FAIL lines as it goes, a summary at the end, and a full report (markdown + JSON)
// plus screenshots in %TEMP%\tourz-regression\. Exit code 1 if anything failed.

import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { root, OUT, localDb, deleteTestCodes, makeRecorder, sleep } from './lib/common.mjs'
import * as stack from './lib/stack.mjs'
import { runContentPhase } from './content.mjs'
import { runApiPhase } from './api.mjs'
import { runUiPhase } from './ui.mjs'

const ALL = ['deps', 'build', 'content', 'api', 'ui', 'parity', 'offline']
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]?.split(',')
let phases = arg('only') || ALL
if (process.argv.includes('--quick')) phases = phases.filter((p) => !['ui', 'offline'].includes(p))
const skip = arg('skip') || []
phases = phases.filter((p) => !skip.includes(p))
const unknown = phases.filter((p) => !ALL.includes(p))
if (unknown.length) { console.error(`Unknown phase(s): ${unknown.join(', ')}. Phases: ${ALL.join(', ')}`); process.exit(2) }

const started = Date.now()
const results = []
const timings = {}
const add = (rs) => results.push(...rs)

// Runs one of the project's existing test scripts and turns its output into results.
function runScript(phase, label, file, args = [], env = {}) {
  return new Promise((resolve) => {
    const rec = makeRecorder(phase)
    const lines = []
    const child = spawn(process.execPath, [file, ...args], { cwd: root, env: { ...process.env, ...env } })
    const onData = (d) => d.toString().split('\n').forEach((l) => { if (l.trim()) { lines.push(l); console.log(`    ${l}`) } })
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('close', (code) => {
      // e2e scripts print PASS/FAIL lines; engine-parity prints "  ✗" lines per mismatch.
      let any = false
      for (const l of lines) {
        const m = l.match(/^(PASS|FAIL)\s+(.*)$/)
        if (m) { any = true; rec(`${label}: ${m[2]}`, m[1] === 'PASS') }
        const x = l.match(/^\s+✗\s+(.*)$/)
        if (x) { any = true; rec(`${label}: ${x[1]}`, false) }
      }
      const summary = lines.filter((l) => /passed|checks,/.test(l)).pop() || ''
      rec(`${label} finished cleanly`, code === 0, `${summary.trim()}${code ? ` (exit ${code})` : ''}${any ? '' : ` | last output: ${lines.slice(-2).join(' / ')}`}`)
      resolve(rec.results)
    })
  })
}

async function phase(name, fn) {
  if (!phases.includes(name)) return
  console.log(`\n=== ${name} ${'='.repeat(60 - name.length)}`)
  const t = Date.now()
  try {
    add(await fn())
  } catch (err) {
    const rec = makeRecorder(name)
    rec(`${name} phase could not run`, false, err.message)
    add(rec.results)
  }
  timings[name] = Math.round((Date.now() - t) / 1000)
}

const db = await localDb()
try {
  const leftovers = await deleteTestCodes(db)
  if (leftovers) console.log(`(removed ${leftovers} leftover test code(s) from an earlier run)`)

  await phase('deps', async () => {
    const rec = makeRecorder('deps')
    for (const dir of ['.', 'client', 'server']) {
      let out
      try { out = execSync('npm audit --json', { cwd: path.join(root, dir), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch (e) { out = e.stdout }
      const v = JSON.parse(out).metadata?.vulnerabilities || {}
      const bad = (v.high || 0) + (v.critical || 0)
      const where = dir === '.' ? 'scripts (root)' : dir === 'client' ? 'website (client)' : 'server'
      rec(`${where}: no high/critical security vulnerabilities`, bad === 0, `critical ${v.critical || 0}, high ${v.high || 0}, moderate ${v.moderate || 0}, low ${v.low || 0}`)
    }
    return rec.results
  })

  const needStack = phases.some((p) => ['api', 'ui', 'parity'].includes(p))
  if (needStack) {
    await stack.startApi()
    console.log(`(test API up on ${stack.API})`)
  }

  await phase('build', async () => {
    const rec = makeRecorder('build')
    const t = Date.now()
    try {
      const dir = stack.buildClient()
      const files = fs.readdirSync(path.join(dir, 'assets'))
      rec('website builds (production-style, dev mode off)', true, `${Math.round((Date.now() - t) / 1000)}s`)
      rec('build includes the map library\'s worker file', files.some((f) => /^maplibre-gl-worker-.*\.mjs$/.test(f)))
      const sw = fs.readFileSync(path.join(dir, 'sw.js'), 'utf8')
      rec('offline service worker lists the map worker for saving to the phone', /maplibre-gl-worker-/.test(sw))
    } catch (err) {
      rec('website builds (production-style, dev mode off)', false, `see ${path.join(OUT, 'client-build.log')}`)
    }
    return rec.results
  })

  await phase('content', () => runContentPhase({ db }))
  await phase('api', () => runApiPhase({ api: stack.API, db }))

  if (phases.includes('ui')) {
    if (!phases.includes('build')) stack.buildClient()
    await stack.startClient()
    console.log(`(test website up on ${stack.APP})`)
  }
  await phase('ui', () => runUiPhase({ api: stack.API, app: stack.APP, db, tourCode: arg('tour')?.[0] || 'edinburgh' }))

  await phase('parity', () => runScript('parity', 'engine parity', 'scripts/offline/engine-parity.mjs', ['20'], { TOURZ_API: stack.API }))

  await phase('offline', async () => {
    // These two use the normal dev ports and a normal (dev-mode) build in client/dist.
    console.log('(building client/dist for the offline tests and starting :3001 / :4173 if needed)')
    execSync('node node_modules/vite/bin/vite.js build', { cwd: path.join(root, 'client'), stdio: 'ignore' })
    if (!stack.pidOnPort(3001)) spawn(process.execPath, ['index.js'], { cwd: path.join(root, 'server'), detached: true, stdio: 'ignore' }).unref()
    if (!stack.pidOnPort(4173)) spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', '4173', '--strictPort'], { cwd: path.join(root, 'client'), detached: true, stdio: 'ignore' }).unref()
    for (let i = 0; i < 60 && !(stack.pidOnPort(3001) && stack.pidOnPort(4173)); i++) await sleep(500)
    await sleep(1500)
    const a = await runScript('offline', 'offline main', 'scripts/offline/e2e-offline.mjs')
    const b = await runScript('offline', 'offline extra', 'scripts/offline/e2e-offline-extra.mjs')
    return [...a, ...b]
  })
} finally {
  try { await deleteTestCodes(db) } catch { /* reported below if it matters */ }
  await db.end()
  stack.stopAll()
}

// ---- report ----
const failed = results.filter((r) => !r.ok)
const warns = results.filter((r) => r.warn)
const byPhase = {}
for (const r of results) {
  byPhase[r.phase] ||= { pass: 0, fail: 0, warn: 0 }
  byPhase[r.phase][r.warn ? 'warn' : r.ok ? 'pass' : 'fail']++
}
const mins = ((Date.now() - started) / 60000).toFixed(1)
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const lines = [
  `# TOURZ regression report — ${new Date().toLocaleString('en-GB')}`,
  '',
  `**${failed.length ? `${failed.length} FAILED` : 'ALL PASSED'}** — ${results.length - failed.length - warns.length} passed, ${failed.length} failed, ${warns.length} warnings, ${mins} min`,
  '',
  '| Phase | Passed | Failed | Warnings | Time |',
  '|---|---|---|---|---|',
  ...Object.entries(byPhase).map(([p, c]) => `| ${p} | ${c.pass} | ${c.fail} | ${c.warn} | ${timings[p] ?? '?'}s |`),
  '',
  ...(failed.length ? ['## Failures', '', ...failed.map((r) => `- **[${r.phase}] ${r.name}**${r.detail ? ` — ${r.detail}` : ''}`), ''] : []),
  ...(warns.length ? ['## Warnings', '', ...warns.map((r) => `- [${r.phase}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`), ''] : []),
  '## Every check', '',
  ...results.map((r) => `- ${r.warn ? '⚠️' : r.ok ? '✅' : '❌'} [${r.phase}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`),
]
const mdFile = path.join(OUT, `report-${stamp}.md`)
fs.writeFileSync(mdFile, lines.join('\n'))
fs.writeFileSync(path.join(OUT, `report-${stamp}.json`), JSON.stringify({ results, timings }, null, 2))

console.log(`\n${'='.repeat(66)}\nSUMMARY (${mins} min)`)
for (const [p, c] of Object.entries(byPhase)) console.log(`  ${p.padEnd(9)} ${String(c.pass).padStart(4)} passed  ${String(c.fail).padStart(3)} failed  ${String(c.warn).padStart(3)} warnings  (${timings[p] ?? '?'}s)`)
if (failed.length) {
  console.log('\nFAILURES:')
  for (const r of failed) console.log(`  ✗ [${r.phase}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
}
if (warns.length) {
  console.log('\nWARNINGS:')
  for (const r of warns) console.log(`  ! [${r.phase}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
}
console.log(`\n${failed.length ? `${failed.length} FAILED` : 'ALL PASSED'} — report: ${mdFile}`)
process.exitCode = failed.length ? 1 : 0
