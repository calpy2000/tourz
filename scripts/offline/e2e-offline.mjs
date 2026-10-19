// End-to-end test of offline play in a real (headless) Chrome against the LOCAL stack only:
// API server on :3001 and a production build served by `vite preview` on :4173 (the build is what
// carries the service worker — `npm run dev` has none). Uses the DEV-LOCAL dev team.
//
//   1. online: open the app, wait for the service worker and the background "save tour" download
//      to finish, use a hint — confirm the server recorded it
//   2. lie-fi: Dev "simulate dead signal" (every request hangs) + reload — the game opens from
//      the phone's saved copy, the puzzle, whole quiz and "next landmark" all work instantly
//   3. true no-signal: both servers stopped, page reloaded — the app itself opens from the
//      service worker, the next landmark is playable, saved photos and narration (with Range
//      requests) are served from the phone; Map view draws the real OSM map from the phone's saved
//      map file (and, switched to the Google map, falls back to the nearby list)
//   4. back in signal: servers restarted — the queue drains, the server's state matches the
//      phone's, every action applied exactly once
//   5. a teammate's phone (a throwaway "ZZ E2E Test Member" player) sees the captain's progress
//
// Prerequisites: `cd client && npx vite build` (fresh build), API server and `vite preview --port
// 4173` running. Stops and restarts both servers itself during step 3/4. Resets the dev team's
// progress at the start and end, and deletes the throwaway member afterwards.
//
//   node scripts/offline/e2e-offline.mjs

import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const API = 'http://localhost:3001'
const APP = 'http://localhost:4173'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP_PORT = 9333
// Screenshots + the throwaway Chrome profile — outside the repo.
const OUT = process.env.E2E_OUT || path.join(os.tmpdir(), 'tourz-e2e-offline')
fs.mkdirSync(OUT, { recursive: true })

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- local process control ------------------------------------------------------------------
function pidOnPort(port) {
  try {
    const out = execSync(`netstat -ano`, { encoding: 'utf8' })
    const line = out.split('\n').find((l) => l.includes(`:${port} `) && l.includes('LISTENING'))
    return line ? Number(line.trim().split(/\s+/).pop()) : null
  } catch { return null }
}
function killPort(port) {
  const pid = pidOnPort(port)
  if (pid) execSync(`powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force"`)
}
async function waitPort(port, up, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (Boolean(pidOnPort(port)) === up) return true
    await sleep(300)
  }
  return false
}
function startApi() {
  spawn(process.execPath, ['index.js'], { cwd: path.join(root, 'server'), detached: true, stdio: 'ignore' }).unref()
}
function startPreview() {
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', '4173', '--strictPort'], { cwd: path.join(root, 'client'), detached: true, stdio: 'ignore' }).unref()
}

// ---- API helpers (direct to the local server) -----------------------------------------------
async function apiCall(p, { token, method = 'GET', body } = {}) {
  const res = await fetch(API + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Session-Token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

// ---- minimal CDP client ---------------------------------------------------------------------
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.handlers = []
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data.toString())
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      } else if (msg.method) {
        this.handlers.forEach((h) => h(msg))
      }
    })
  }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject) })
    return new Cdp(ws)
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
}

class Page {
  constructor(cdp, sessionId, label) {
    this.cdp = cdp
    this.sid = sessionId
    this.label = label
    this.errors = []
    this.logs = []
    cdp.handlers.push((msg) => {
      if (msg.sessionId !== sessionId) return
      if (msg.method === 'Runtime.exceptionThrown') this.errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text)
      if (msg.method === 'Runtime.consoleAPICalled') {
        const line = msg.params.args.map((x) => x.value ?? x.description).join(' ')
        if (/sync|status|sw /.test(line)) this.logs.push(line.slice(0, 220))
      }
    })
  }
  send(method, params) { return this.cdp.send(method, params, this.sid) }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`)
    return r.result.value
  }
  text() { return this.eval('document.body.innerText') }
  async waitFor(predicateJs, ms = 15000, label = predicateJs) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      // Awaited first: a predicate can be a promise, and Boolean(promise) is always true.
      try { if (await this.eval(`(async () => Boolean(await (${predicateJs})))()`)) return true } catch { /* page mid-navigation */ }
      await sleep(200)
    }
    throw new Error(`timed out waiting for: ${label}`)
  }
  async waitText(fragment, ms = 15000) {
    return this.waitFor(`document.body && document.body.innerText.includes(${JSON.stringify(fragment)})`, ms, `text "${fragment}"`)
  }
  // Clicks the first visible <button> whose text includes `label`.
  async click(label) {
    const ok = await this.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find((el) => el.offsetParent !== null && !el.disabled && el.innerText.includes(${JSON.stringify(label)}))
      if (!b) return false
      b.click()
      return true
    })()`)
    if (!ok) throw new Error(`no enabled button "${label}"`)
  }
  async navigate(url) {
    await this.send('Page.navigate', { url })
    await sleep(500)
  }
  async screenshot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'))
  }
}

async function newPage(cdp, label) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const page = new Page(cdp, sessionId, label)
  await page.send('Runtime.enable')
  await page.send('Page.enable')
  await page.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 860, deviceScaleFactor: 1, mobile: false })
  await page.send('Emulation.setGeolocationOverride', { latitude: -20.1609, longitude: 57.5012, accuracy: 10 })
  return page
}

// What the phone's own game store thinks (read straight out of IndexedDB, as the app saved it).
const PHONE_OUTBOX_JS = `new Promise((resolve) => {
  const req = indexedDB.open('tourz', 1)
  req.onsuccess = () => {
    const tx = req.result.transaction('kv', 'readonly')
    const token = JSON.parse(localStorage.getItem('tourz.session')).sessionToken
    const g = tx.objectStore('kv').get('outbox:' + token)
    g.onsuccess = () => resolve((g.result || []).map((a) => a.type))
  }
  req.onerror = () => resolve(null)
})`

// ---- the test -------------------------------------------------------------------------------
let chrome
let memberId = null
try {
  if (!pidOnPort(3001) || !pidOnPort(4173)) throw new Error('API (:3001) and vite preview (:4173) must both be running')

  const captain = await apiCall('/api/dev/login', { method: 'POST' })
  const token = captain.sessionToken
  await apiCall('/api/dev/reset', { token, method: 'POST' })
  await apiCall('/api/dev/clock', { token, method: 'POST', body: { action: 'minutes-left', minutes: 150 } })
  const serverState = await apiCall('/api/game/state', { token })
  record('setup: dev team reset, clock running', serverState.team.currentSequence === serverState.tour.firstPlayableSequence)
  const startSeq = serverState.team.currentSequence
  record('whole tour sent up front (look-ahead = all)', serverState.lookahead === 'all' &&
    serverState.landmarks.filter((l) => l.sealed).length === serverState.tour.playableCount,
    `${serverState.landmarks.filter((l) => l.sealed).length} sealed landmark packages`)

  const profile = path.join(OUT, 'chrome-profile')
  fs.rmSync(profile, { recursive: true, force: true })
  // Software WebGL, so the OSM map (MapLibre) can draw in headless Chrome.
  chrome = spawn(CHROME, ['--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let version
  for (let i = 0; i < 50 && !version; i++) {
    try { version = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json() } catch { await sleep(200) }
  }
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl)
  await cdp.send('Browser.grantPermissions', { origin: APP, permissions: ['geolocation'] })

  // ---- 1. online ----
  const page = await newPage(cdp, 'captain')
  await page.navigate(`${APP}/`)
  await page.waitFor(`localStorage.getItem('tourz.session')`, 20000, 'dev login session')
  await page.waitFor(`navigator.serviceWorker && navigator.serviceWorker.controller`, 20000, 'service worker in control')
  record('service worker installed and controlling the page', true)

  // The background save: every photo and narration file of every landmark and every POI — the
  // exact list worked out here from the server's own data, independently of the app — must all
  // end up on the phone.
  const { unsealJson: unsealForList } = await import(pathToFileURL(path.join(root, 'client/src/offline/seal.js')).href)
  const tourPack = await apiCall('/api/game/tour-pack', { token })
  const expected = new Set()
  for (const l of serverState.landmarks) {
    const full = l.sealed ? unsealForList(l.sealed, `${token}:${l.seq}`) : l
    for (const img of [full.tileImage, full.heroImage]) if (img) expected.add(`/content-photos/${img}`)
    if (full.detail?.audioPath) expected.add(`/content-audio/${full.detail.audioPath}`)
    for (const q of full.quiz || []) for (const t of q.payload?.tiles || []) if (t.imagePath) expected.add(`/content-photos/${t.imagePath}`)
  }
  for (const s of tourPack.sites) {
    if (s.imagePath) expected.add(`/content-photos/${s.imagePath}`)
    if (s.audioPath) expected.add(`/content-audio/${s.audioPath}`)
  }
  // The tour's OSM map file, plus the fonts and icons it draws with (see client/src/map/mapFiles.js).
  const mapAssets = JSON.parse(fs.readFileSync(path.join(root, 'client/src/map/mapAssets.json'), 'utf8'))
  const tourMap = mapAssets.tours[serverState.tour.tourCode]
  record('this tour has a built OSM map', Boolean(tourMap), serverState.tour.tourCode)
  if (tourMap) {
    expected.add(tourMap.file)
    const ranges = new Set(tourMap.glyphRanges.map((r) => `/${r}-${r + 255}.pbf`))
    for (const g of mapAssets.glyphs) if (ranges.has(g.slice(g.lastIndexOf('/')))) expected.add(g)
    for (const sp of mapAssets.sprites) expected.add(sp)
  }
  const expectedList = JSON.stringify([...expected])
  const t0 = Date.now()
  const missingJs = `caches.open('tourz-content-v1').then((c) => c.keys()).then((keys) => {
    const have = new Set(keys.map((r) => decodeURIComponent(new URL(r.url).pathname)))
    return ${expectedList}.filter((p) => !have.has(p))
  })`
  let missing = []
  for (let i = 0; i < 600; i++) {
    missing = await page.eval(missingJs)
    if (!missing.length) break
    await sleep(500)
  }
  record('background save: EVERY landmark + POI photo and narration, and the OSM map, on the phone', missing.length === 0,
    `${expected.size - missing.length}/${expected.size} files in ${Math.round((Date.now() - t0) / 1000)}s${missing.length ? `; missing e.g. ${missing.slice(0, 3).join(', ')}` : ''}`)
  const pillDone = await page.eval(`document.body.innerText.includes('Tour saved for offline use') || !document.body.innerText.includes('Saving tour')`)
  record('background save: progress pill finished', pillDone)

  await page.navigate(`${APP}/play`)
  await page.waitText('Find it clue')
  await page.screenshot('1-online-play')
  await page.click('Get a hint')
  await page.click('Use hint')
  const hintShownAt = Date.now()
  await page.waitText('Hint 1:', 3000)
  record('online: hint shows instantly', true, `${Date.now() - hintShownAt}ms`)
  await sleep(2500)
  const afterHint = await apiCall('/api/game/state', { token })
  record('online: server recorded the hint', afterHint.events.filter((e) => e.type === 'clue_hint_used').length === 1)

  // ---- 2. lie-fi (requests hang) ----
  await page.eval(`sessionStorage.setItem('tourzSimulateDeadSignal', '1')`)
  const reloadAt = Date.now()
  await page.send('Page.reload', {})
  await sleep(300)
  await page.waitText('Find it clue', 15000)
  record('dead signal: game opens from the phone after reload', true, `${Date.now() - reloadAt}ms`)
  await page.waitText('Hint 1:', 3000)

  // The right answers, unsealed here in Node exactly as the app does (same token, same packages).
  const { unsealJson } = await import(pathToFileURL(path.join(root, 'client/src/offline/seal.js')).href)
  const unseal = (seq) => unsealJson(serverState.landmarks.find((x) => x.seq === seq).sealed, `${token}:${seq}`)
  const lm1 = unseal(startSeq)
  const answer1 = lm1.puzzle.type === 'exact_numeric' ? lm1.puzzle.answer.answer : lm1.puzzle.answer.accepted[0]

  await page.eval(`(() => {
    const input = document.querySelector('input[placeholder="Your answer"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(String(answer1))})
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(200)
  const submitAt = Date.now()
  await page.eval(`document.querySelector('form.answer-form button[type=submit]').click()`)
  await page.waitText('is Correct!', 3000)
  record('dead signal: Prove it answered instantly', true, `${Date.now() - submitAt}ms`)
  await page.waitText('No signal', 15000)
  record('dead signal: "No signal" strip appears (app not frozen)', true)
  const dot = await page.eval(`Boolean(document.querySelector('.score-sync-dot'))`)
  record('dead signal: score shows the not-synced dot', dot)
  await page.screenshot('2-deadsignal-solved')

  await page.click('Take the quiz')
  await page.waitFor(`document.querySelectorAll('.quiz-question').length > 0`, 5000, 'quiz questions')
  for (const [i, q] of lm1.quiz.entries()) {
    const pick = i % 2 ? q.payload.correct : q.payload.options.find((o) => o !== q.payload.correct)
    await page.eval(`(() => {
      const block = document.querySelectorAll('.quiz-question')[${i}]
      const opt = [...block.querySelectorAll('.quiz-opt')].find((b) => b.innerText.trim() === ${JSON.stringify(pick)})
      opt.click()
    })()`)
    await sleep(150)
    await page.eval(`document.querySelectorAll('.quiz-question')[${i}].querySelector('.quiz-submit').click()`)
    await sleep(150)
  }
  await page.waitText('Head to next landmark', 3000)
  record('dead signal: whole quiz answered, landmark complete', true)
  await page.click('Head to next landmark')
  const lm2 = unseal(startSeq + 1)
  await page.waitFor(`document.body.innerText.includes(${JSON.stringify(lm2.clue.text.slice(0, 40))})`, 3000, 'next clue')
  record('dead signal: next landmark\'s clue appears with no signal', true)
  const scoreDeadSignal = await page.eval(`document.querySelector('.home-pill-brass').innerText`)
  const outboxDead = await page.eval(PHONE_OUTBOX_JS)
  record('dead signal: actions saved on the phone, waiting to sync', outboxDead && outboxDead.length >= 6, outboxDead?.join(','))

  // ---- 3. true no signal: both servers gone, reload ----
  killPort(3001)
  killPort(4173)
  await waitPort(3001, false)
  await waitPort(4173, false)
  // This machine still has internet, but a phone with no signal can't reach Google's map either —
  // block it so MapView takes its no-map path (the nearby list) exactly as on a real phone.
  await page.send('Network.enable', {})
  await page.send('Network.setBlockedURLs', { urls: ['*googleapis.com*', '*gstatic.com*', '*google.com/maps*'] })
  await page.eval(`sessionStorage.removeItem('tourzSimulateDeadSignal')`)
  const offlineReloadAt = Date.now()
  await page.send('Page.reload', {})
  await sleep(500)
  await page.waitFor(`document.body.innerText.includes(${JSON.stringify(lm2.clue.text.slice(0, 40))})`, 15000, 'clue after offline reload')
  record('no signal: app itself reopens from the phone (service worker) on the next landmark', true, `${Date.now() - offlineReloadAt}ms`)
  await page.waitText('No signal', 15000)
  await sleep(300)
  const layout = await page.eval(`(() => {
    const strip = document.querySelector('.conn-strip').getBoundingClientRect()
    // The visible one — HomePage stays mounted (hidden) behind CURRENT landmark with its own switch.
    const sw = [...document.querySelectorAll('.view-switch')].find((el) => el.offsetParent !== null).getBoundingClientRect()
    return { stripBottom: Math.round(strip.bottom), switchTop: Math.round(sw.top) }
  })()`)
  record('no signal: strip doesn\'t cover the MAP/CURRENT switch', layout.switchTop >= layout.stripBottom, JSON.stringify(layout))
  const fontsOk = await page.eval(`document.fonts.ready.then(() => document.fonts.check('16px Quicksand'))`)
  record('no signal: bundled fonts load', fontsOk)
  const stillQueued = await page.eval(PHONE_OUTBOX_JS)
  record('no signal: queue survived the reload', stillQueued?.length === outboxDead.length, `${stillQueued?.length} queued`)
  await page.screenshot('3-offline-reload')

  const pack = await apiFetchPackFromPhone(page)
  // Prefer a POI with both a photo and narration; a tour with no narration yet (local Edinburgh)
  // skips the Range check.
  const site = pack.sites.find((s) => s.imagePath && s.audioPath) || pack.sites.find((s) => s.imagePath)
  const photo = await page.eval(`fetch('/content-photos/${site.imagePath}').then((r) => r.blob()).then((b) => b.size).catch((e) => 'ERR ' + e)`)
  record('no signal: a POI photo is served from the phone', typeof photo === 'number' && photo > 1000, `${photo} bytes`)
  if (site.audioPath) {
    const audio = await page.eval(`fetch('/content-audio/${site.audioPath}', { headers: { Range: 'bytes=0-1023' } }).then((r) => r.status + ' ' + r.headers.get('content-range')).catch((e) => 'ERR ' + e)`)
    record('no signal: narration Range request answered from the phone (206)', String(audio).startsWith('206 bytes 0-1023/'), audio)
  } else console.log('SKIP  no signal: narration Range request — this tour has no narration files')
  record('no signal: every POI card is on the phone', pack.sites.length >= 100 && pack.sites.every((s) => s.aboutSiteText !== undefined), `${pack.sites.length} cards`)

  await page.click('Get a hint')
  await page.click('Use hint')
  await page.waitText('Hint 1:', 3000)
  record('no signal: hint on the new landmark', true)

  // Map view with no signal: the real OSM map, drawn from the map file saved on the phone.
  await page.click('MAP')
  await page.waitFor(`document.querySelector('.osm-map canvas') && document.querySelectorAll('.osm-map .maplibregl-marker').length > 0`, 20000, 'OSM map with markers')
  await sleep(3000) // let the tiles draw
  const osm = await page.eval(`({
    markers: document.querySelectorAll('.osm-map .maplibregl-marker').length,
    nearby: document.querySelectorAll('.nearby-item').length,
    attribution: document.querySelector('.maplibregl-ctrl-attrib-inner')?.textContent || '',
  })`)
  record('no signal: map view shows the real OSM map with every marker', osm.nearby === 0 && osm.markers >= pack.sites.length + 2,
    `${osm.markers} markers for ${pack.sites.length} POIs + landmarks + you-are-here`)
  record('no signal: OSM attribution shown', osm.attribution.includes('OpenStreetMap'), osm.attribution)
  await page.screenshot('3a-osm-map-offline')
  // The map really drew (not just an empty canvas): count pixels of the buildings' fill colour.
  const { default: sharp } = await import('sharp')
  const { data: px } = await sharp(path.join(OUT, '3a-osm-map-offline.png')).raw().toBuffer({ resolveWithObject: true })
  let buildingPx = 0
  for (let i = 0; i < px.length; i += 3) if (px[i] === 0xde && px[i + 1] === 0xde && px[i + 2] === 0xde) buildingPx++
  record('no signal: OSM map tiles drawn from the phone (buildings visible)', buildingPx > 2000, `${buildingPx} building-fill pixels`)

  // A real tap (coordinates, not element.click()) on a POI marker that's actually on top at its
  // own centre — the Google map once shipped markers that looked fine but swallowed taps.
  const tap = await page.eval(`(() => {
    const vw = innerWidth, vh = innerHeight
    for (const m of document.querySelectorAll('.osm-map .maplibregl-marker')) {
      if (!m.querySelector('.map-dot-site, .map-pin-site')) continue
      const r = m.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      if (x < 40 || y < 120 || x > vw - 40 || y > vh - 120) continue
      if (m.contains(document.elementFromPoint(x, y))) return { x: Math.round(x), y: Math.round(y) }
    }
    return null
  })()`)
  record('no signal: a POI marker is tappable on the OSM map', Boolean(tap), JSON.stringify(tap))
  if (tap) {
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: tap.x, y: tap.y, button: 'left', clickCount: 1 })
    await page.waitFor(`document.querySelector('.detail-popup')`, 5000, 'POI card from map marker')
    record('no signal: tapping an OSM map marker opens its card', true)
    await page.click('back')
  }

  // Switched to the Google map (Dev menu), with no signal its script can't load — the nearby list
  // stands in, and its cards open from the phone.
  await page.eval(`localStorage.setItem('tourz.mapProvider', 'google')`)
  await page.send('Page.reload', {})
  await sleep(500)
  await page.waitFor(`[...document.querySelectorAll('button')].some((b) => b.offsetParent !== null && b.innerText.includes('MAP'))`, 15000, 'MAP switch after reload')
  if (!(await page.eval(`document.querySelectorAll('.nearby-item').length`))) await page.click('MAP')
  await page.waitFor(`document.querySelectorAll('.nearby-item').length > 0`, 20000, 'nearby list')
  // Distances join once the GPS fix arrives (the list re-sorts nearest-first then).
  await page.waitFor(`document.querySelectorAll('.nearby-item-distance').length > 0`, 10000, 'nearby distances').catch(() => {})
  const nearby = await page.eval(`(() => {
    const items = [...document.querySelectorAll('.nearby-item')]
    return { count: items.length, first: items[0].innerText.replace(/\\n/g, ' · '), withDistance: items.filter((i) => i.querySelector('.nearby-item-distance')).length }
  })()`)
  record('no signal, Google map: map view shows the nearby list instead of a dead map', nearby.count >= pack.sites.length,
    `${nearby.count} entries, ${nearby.withDistance} with distances; nearest: ${nearby.first}`)
  await page.screenshot('3b-nearby-list')
  await page.eval(`[...document.querySelectorAll('.nearby-item')].find((b) => !b.innerText.includes('Landmark')).click()`)
  await page.waitFor(`document.querySelector('.detail-popup')`, 5000, 'POI card')
  const card = await page.eval(`({ title: document.querySelector('.detail-popup h3').innerText, listen: Boolean(document.querySelector('.narration-entry-icon')), img: (() => { const i = document.querySelector('.detail-popup-image'); return i ? i.complete && i.naturalWidth > 0 : null })() })`)
  record('no signal: tapping a nearby POI opens its card (photo + Listen here)', Boolean(card.title) && card.listen && card.img !== false, JSON.stringify(card))
  await page.screenshot('3c-poi-card-offline')
  await page.click('back')
  await page.eval(`localStorage.removeItem('tourz.mapProvider')`)
  await page.click('CURRENT')
  await page.send('Network.setBlockedURLs', { urls: [] })

  // ---- 4. back in signal ----
  startApi()
  startPreview()
  await waitPort(3001, true)
  await waitPort(4173, true)
  const reconnectAt = Date.now()
  await page.waitFor(`!document.body.innerText.includes('No signal')`, 30000, 'signal noticed')
  record('back in signal: app notices on its own', true, `${Date.now() - reconnectAt}ms after servers returned`)
  // Drained = the phone's own saved queue is empty (the "Syncing…" strip only shows after 2s).
  await page.waitFor(`${PHONE_OUTBOX_JS}.then((q) => q && q.length === 0)`, 30000, 'queue empty')
  record('back in signal: queue drains on its own, nothing left queued', true, `${Date.now() - reconnectAt}ms after servers returned`)

  const finalState = await apiCall('/api/game/state', { token })
  const types = finalState.events.map((e) => `${e.seq}:${e.type}`)
  const count = (t) => types.filter((x) => x === t).length
  const expectedQuizAnswers = lm1.quiz.length
  record('server: exactly one hint on the first landmark', count(`${startSeq}:clue_hint_used`) === 1)
  record('server: puzzle recorded once, correct', count(`${startSeq}:puzzle_solved`) === 1 &&
    finalState.events.find((e) => e.type === 'puzzle_solved').payload.correct === true)
  record('server: every quiz answer recorded once', count(`${startSeq}:quiz_answered`) === expectedQuizAnswers, `${count(`${startSeq}:quiz_answered`)}/${expectedQuizAnswers}`)
  record('server: landmark completed once and team advanced', count(`${startSeq}:landmark_completed`) === 1 && finalState.team.currentSequence === startSeq + 1)
  record('server: offline hint on the next landmark', count(`${startSeq + 1}:clue_hint_used`) === 1)
  const phoneScore = await page.eval(`document.querySelector('.home-pill-brass').innerText`)
  record('phone score = server score', phoneScore.includes(`${finalState.team.totalScore} pts`) && scoreDeadSignal.includes(`${finalState.team.totalScore} pts`),
    `phone "${phoneScore.trim()}", server ${finalState.team.totalScore}`)
  await page.screenshot('4-synced')

  // ---- 5. a teammate's phone ----
  const reg = await apiCall('/api/register', { method: 'POST', body: { code: 'DEV-LOCAL', name: 'ZZ E2E Test Member', avatar: '🧪', role: 'member' } })
  if (reg.error) {
    record('teammate: register throwaway member', false, reg.error)
  } else {
    memberId = reg.player.id
    const member = await newPage(cdp, 'member')
    await member.navigate(`${APP}/home`)
    await member.eval(`localStorage.setItem('tourz.session', JSON.stringify(${JSON.stringify({
      sessionToken: reg.sessionToken, playerId: reg.player.id, teamId: reg.team.id, name: reg.player.name, avatar: reg.player.avatar, isCaptain: false,
    })}))`)
    await member.navigate(`${APP}/play`)
    await member.waitFor(`document.body.innerText.includes(${JSON.stringify(lm2.clue.text.slice(0, 40))})`, 15000, 'member sees landmark 2')
    await member.waitText('Hint 1:', 5000)
    record('teammate: sees the captain\'s offline progress once synced', true)
    const disabled = await member.eval(`[...document.querySelectorAll('button')].filter((b) => b.innerText.includes('Get a hint')).every((b) => b.disabled)`)
    record('teammate: captain-only buttons stay disabled', disabled)
  }

  if (results.some((r) => !r.ok)) console.log(`--- captain phone sync log ---\n${page.logs.join('\n')}`)
  const errs = page.errors
  record('no uncaught page errors (captain)', errs.length === 0, errs.slice(0, 3).join(' | '))
} catch (err) {
  record('test run', false, err.message)
} finally {
  try {
    const t = (await apiCall('/api/dev/login', { method: 'POST' })).sessionToken
    await apiCall('/api/dev/reset', { token: t, method: 'POST' })
  } catch { /* server down */ }
  if (memberId) {
    try {
      execSync(`"C:/Program Files/PostgreSQL/18/bin/psql.exe" -U postgres -h localhost -d tourz -c "DELETE FROM client_actions WHERE player_id = ${Number(memberId)}; DELETE FROM narration_listens WHERE player_id = ${Number(memberId)}; DELETE FROM players WHERE id = ${Number(memberId)} AND name = 'ZZ E2E Test Member';"`, { stdio: 'ignore' })
    } catch { console.log('(could not delete the throwaway member — remove player', memberId, 'by hand)') }
  }
  // Only this test's own Chrome (its debug port's PID, then the spawned handle) — never by name.
  try {
    const chromePid = pidOnPort(CDP_PORT)
    if (chromePid) execSync(`taskkill /F /T /PID ${chromePid}`, { stdio: 'ignore' })
  } catch { /* already gone */ }
  try { chrome?.kill() } catch { /* already gone */ }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots in ${OUT}`)
  process.exit(failed.length ? 1 : 0)
}

// The tour pack exactly as the phone saved it (IndexedDB), so the "every card is on the phone"
// check reads the phone's copy rather than asking the server.
async function apiFetchPackFromPhone(page) {
  return page.eval(`new Promise((resolve) => {
    const req = indexedDB.open('tourz', 1)
    req.onsuccess = () => {
      const store = req.result.transaction('kv', 'readonly').objectStore('kv')
      const all = store.getAllKeys()
      all.onsuccess = () => {
        const key = all.result.find((k) => String(k).startsWith('tour-pack:'))
        const g = store.get(key)
        g.onsuccess = () => resolve(g.result)
      }
    }
  })`)
}
