// Second end-to-end scenario for offline play (see e2e-offline.mjs for the main one, same
// prerequisites: fresh `vite build`, API on :3001, `vite preview --port 4173`; LOCAL only).
//
//   A. Map view and Instructions with no signal (POI cards from the phone)
//   B. Captain stops and restarts the clock from the Help menu with no signal — the screen
//      freezes/unfreezes on the phone, and the server gets the stop's real start time
//   C. The LAST landmark finished with no signal: tour-complete celebration + certificate page,
//      "Save and send" queued (never actually sent — the test ends before the phone reconnects)
//
// "No signal" here is the Dev Tools dead-signal switch (every request hangs), so the servers keep
// running. Resets the dev team at the start and end.
//
//   node scripts/offline/e2e-offline-extra.mjs

import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const API = 'http://localhost:3001'
const APP = 'http://localhost:4173'
const CDP_PORT = 9336
const OUT = process.env.E2E_OUT || path.join(os.tmpdir(), 'tourz-e2e-offline-extra')
fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const record = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }
const apiCall = async (p, { token, method = 'GET', body } = {}) => (await fetch(API + p, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Session-Token': token } : {}) }, body: body ? JSON.stringify(body) : undefined,
})).json()
const pidOnPort = (port) => execSync('netstat -ano', { encoding: 'utf8' }).split('\n').find((l) => l.includes(`:${port} `) && l.includes('LISTENING'))?.trim().split(/\s+/).pop()

let chrome
let ws
let msgId = 0
const pending = new Map()
const errors = []
function send(method, params = {}, sessionId) {
  const id = ++msgId
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
let sid
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true }, sid)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}
async function waitFor(js, ms = 15000, label = js) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await ev(`Boolean(await (${js}))`)) return } catch { /* navigating */ }
    await sleep(200)
  }
  throw new Error(`timed out waiting for: ${label}`)
}
const waitText = (t, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(t)})`, ms, `text "${t}"`)
async function click(label) {
  const ok = await ev(`(() => { const b = [...document.querySelectorAll('button')].find((el) => el.offsetParent !== null && !el.disabled && el.innerText.includes(${JSON.stringify(label)})); if (!b) return false; b.click(); return true })()`)
  if (!ok) throw new Error(`no enabled button "${label}"`)
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sid)
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'))
}
async function go(url) { await send('Page.navigate', { url }, sid); await sleep(600) }
async function deadSignal(on) {
  await ev(on ? `sessionStorage.setItem('tourzSimulateDeadSignal', '1')` : `sessionStorage.removeItem('tourzSimulateDeadSignal')`)
}

try {
  if (!pidOnPort(3001) || !pidOnPort(4173)) throw new Error('API (:3001) and vite preview (:4173) must both be running')
  const token = (await apiCall('/api/dev/login', { method: 'POST' })).sessionToken
  await apiCall('/api/dev/reset', { token, method: 'POST' })
  await apiCall('/api/dev/clock', { token, method: 'POST', body: { action: 'minutes-left', minutes: 150 } })

  const profile = path.join(OUT, 'chrome-profile')
  fs.rmSync(profile, { recursive: true, force: true })
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let version
  for (let i = 0; i < 50 && !version; i++) { try { version = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json() } catch { await sleep(200) } }
  ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data.toString())
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
  })
  await send('Browser.grantPermissions', { origin: APP, permissions: ['geolocation'] })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  sid = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId
  await send('Runtime.enable', {}, sid)
  await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 860, deviceScaleFactor: 1, mobile: false }, sid)
  await send('Emulation.setGeolocationOverride', { latitude: -20.1609, longitude: 57.5012, accuracy: 10 }, sid)

  await go(`${APP}/`)
  await waitFor(`localStorage.getItem('tourz.session') && navigator.serviceWorker.controller`, 20000, 'session + service worker')
  await waitFor(`caches.open('tourz-content-v1').then((c) => c.keys()).then((k) => k.length >= 290)`, 120000, 'tour saved')

  // ---- A. Map view + Instructions with no signal ----
  await go(`${APP}/home`)
  await waitText('MAP', 10000)
  await deadSignal(true)
  await send('Page.reload', {}, sid)
  await sleep(800)
  await waitText('MAP', 10000)
  await waitText('No signal', 15000)
  const pins = await ev(`document.querySelectorAll('.map-pin-site, .map-dot-site').length`)
  const mapNote = await ev(`document.body.innerText.includes('The map needs signal')`)
  record('A: Map view opens with no signal', true, pins ? `${pins} POI markers drawn` : mapNote ? 'map script unavailable — "map needs signal" note shown' : 'map area shown')
  await shot('A-map-offline')
  await go(`${APP}/instructions`)
  await waitText('Instructions', 10000)
  record('A: Instructions open with no signal', await ev(`document.body.innerText.includes('landmarks')`))

  // ---- B. clock stop + restart from the Help menu, no signal ----
  await go(`${APP}/play`)
  await waitText('Find it clue', 10000)
  const stopTapped = Date.now()
  await click('Help')
  await sleep(300)
  await click('Stop the clock')
  await sleep(300)
  await ev(`[...document.querySelectorAll('.modal-actions button')].find((b) => b.innerText.includes('Stop the clock')).click()`)
  await waitText("ve stopped the clock", 3000)
  record('B: clock stops instantly with no signal (screen frozen)', await ev(`document.body.classList.contains('clock-frozen')`))
  await shot('B-clock-stopped-offline')
  await sleep(4000)
  await click('Restart clock')
  await sleep(500)
  record('B: clock restarts with no signal', !(await ev(`document.body.classList.contains('clock-frozen')`)))
  await deadSignal(false)
  await send('Page.reload', {}, sid)
  await sleep(800)
  await waitFor(`!document.body.innerText.includes('No signal')`, 20000, 'back online')
  await sleep(2500)
  const st = await apiCall('/api/game/state', { token })
  record('B: server got the stop + restart, with the stop timed from the tap', st.clock.pausesUsed === 1 && st.clock.pausedAt === null && st.clock.pausedSeconds >= 3,
    `pausesUsed ${st.clock.pausesUsed}, pausedSeconds ${st.clock.pausedSeconds} (tap-to-restart ≈ ${Math.round((Date.now() - stopTapped) / 1000)}s incl. reload)`)

  // ---- C. last landmark finished with no signal ----
  await apiCall('/api/dev/complete/999', { token, method: 'POST' })
  const state = await apiCall('/api/game/state', { token })
  const { unsealJson } = await import(pathToFileURL(path.join(root, 'client/src/offline/seal.js')).href)
  const lastSeq = state.team.currentSequence
  const last = unsealJson(state.landmarks.find((l) => l.seq === lastSeq).sealed, `${token}:${lastSeq}`)
  await go(`${APP}/play`)
  await waitFor(`document.querySelectorAll('.quiz-question, .five-right-block, .anagram-board, .five-right-section').length > 0 || document.body.innerText.includes('Take the quiz')`, 15000, 'final quiz')
  await deadSignal(true)
  await send('Page.reload', {}, sid)
  await sleep(800)
  await waitFor(`document.querySelectorAll('.quiz-question, .five-right-block').length > 0 || document.body.innerText.includes('Take the quiz')`, 15000, 'final quiz after reload')
  if (await ev(`document.body.innerText.includes('Take the quiz')`)) await click('Take the quiz')
  const qtype = last.quiz[0]?.type
  if (qtype === 'multiple_choice') {
    for (const [i, q] of last.quiz.entries()) {
      await ev(`[...document.querySelectorAll('.quiz-question')[${i}].querySelectorAll('.quiz-opt')].find((b) => b.innerText.trim() === ${JSON.stringify(q.payload.correct)}).click()`)
      await sleep(120)
      await ev(`document.querySelectorAll('.quiz-question')[${i}].querySelector('.quiz-submit').click()`)
      await sleep(120)
    }
  } else if (qtype === 'five_right') {
    for (const [i, q] of last.quiz.entries()) {
      const correctNames = q.payload.tiles.filter((t) => t.correct).map((t) => t.name)
      await ev(`(() => { const block = document.querySelectorAll('.five-right-block')[${i}]; [...block.querySelectorAll('.five-right-tile')].filter((b) => ${JSON.stringify(correctNames)}.includes(b.innerText.trim().split('\\n')[0])).forEach((b) => b.click()) })()`)
      await sleep(150)
      await ev(`document.querySelectorAll('.five-right-block')[${i}].querySelector('.quiz-submit').click()`)
      await sleep(150)
    }
  } else {
    record(`C: final quiz type "${qtype}" not automated here`, true, 'skipping the rest of C')
  }
  if (qtype === 'multiple_choice' || qtype === 'five_right') {
    await click('Head to next landmark')
    await waitText('Get your certificate', 8000)
    record('C: tour-complete celebration with no signal', true)
    await click('Get your certificate')
    await waitText('TOURZ', 8000)
    await waitFor(`document.querySelector('.certificate-card')`, 8000, 'certificate card')
    record('C: certificate page renders with no signal', await ev(`document.querySelector('.certificate-card').innerText.includes('landmarks completed')`))
    await shot('C-certificate-offline')
    await click('Save and send')
    await sleep(300)
    await ev(`(() => { const i = document.querySelector('.certificate-email-form input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'zz-e2e-test@example.invalid'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await sleep(200)
    const sendAt = Date.now()
    await ev(`document.querySelector('.certificate-email-form button[type=submit]').click()`)
    // Rendering the certificate to an image (html-to-image) takes a few seconds on its own.
    await waitText("as soon as you're back in signal", 30000)
    record('C: certificate email queued with no signal ("will send when back in signal")', true, `${Date.now() - sendAt}ms incl. rendering the image`)
    await shot('C-certificate-queued')
  }
  record('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (err) {
  record('test run', false, err.message)
  try {
    console.log('--- page text at failure ---\n' + String(await ev('document.body.innerText')).slice(0, 600))
    await shot('failure')
  } catch { /* page gone */ }
} finally {
  // Chrome first, so the queued certificate email can never reach the server and really send.
  try { const pid = pidOnPort(CDP_PORT); if (pid) execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' }) } catch { /* gone */ }
  try { chrome?.kill() } catch { /* gone */ }
  try {
    const t = (await apiCall('/api/dev/login', { method: 'POST' })).sessionToken
    await apiCall('/api/dev/reset', { token: t, method: 'POST' })
  } catch { /* server down */ }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots in ${OUT}`)
  process.exit(failed.length ? 1 : 0)
}
