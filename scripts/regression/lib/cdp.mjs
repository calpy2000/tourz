// Drives headless Chrome over the DevTools protocol directly (no Puppeteer/Playwright install
// needed) — same approach as scripts/offline/e2e-offline.mjs, plus real mouse clicks/wheel (the
// coach walkthrough listens for genuine pointer events) and separate browser contexts so two
// "phones" (captain + member) run side by side with their own storage.

import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { sleep } from './common.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

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
  send(method, params = {}, sessionId) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
}

export async function launchChrome({ port, profileDir }) {
  fs.rmSync(profileDir, { recursive: true, force: true })
  const proc = spawn(CHROME, [
    '--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--no-first-run', 'about:blank',
  ], { stdio: 'ignore' })
  let version
  for (let i = 0; i < 75 && !version; i++) {
    try { version = await (await fetch(`http://localhost:${port}/json/version`)).json() } catch { await sleep(200) }
  }
  if (!version) throw new Error('Chrome did not start')
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject) })
  const cdp = new Cdp(ws)
  return {
    cdp,
    close() {
      try { ws.close() } catch { /* gone */ }
      try { execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' }) } catch { /* gone */ }
    },
  }
}

// A "phone": its own browser context (own localStorage/IndexedDB/service worker), 400×860.
export async function newPhone(cdp, { label, origin, outDir, lat, lng }) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: false })
  await cdp.send('Browser.grantPermissions', { origin, permissions: ['geolocation'], browserContextId })
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const page = new Page(cdp, sessionId, label, outDir)
  await page.send('Runtime.enable')
  await page.send('Page.enable')
  await page.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 860, deviceScaleFactor: 1, mobile: false })
  await page.send('Emulation.setGeolocationOverride', { latitude: lat, longitude: lng, accuracy: 10 })
  return page
}

export class Page {
  constructor(cdp, sessionId, label, outDir) {
    this.cdp = cdp
    this.sid = sessionId
    this.label = label
    this.outDir = outDir
    this.errors = []
    this.failedRequests = []
    cdp.handlers.push((msg) => {
      if (msg.sessionId !== sessionId) return
      if (msg.method === 'Runtime.exceptionThrown') this.errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text)
    })
  }
  send(method, params) { return this.cdp.send(method, params, this.sid) }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`)
    return r.result.value
  }
  text() { return this.eval('document.body ? document.body.innerText : ""') }
  url() { return this.eval('location.pathname') }
  async waitFor(predicateJs, ms = 15000, label = predicateJs) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try { if (await this.eval(`(async () => Boolean(await (${predicateJs})))()`)) return true } catch { /* mid-navigation */ }
      await sleep(150)
    }
    throw new Error(`[${this.label}] timed out waiting for: ${label}`)
  }
  waitText(fragment, ms = 15000) {
    return this.waitFor(`document.body && document.body.innerText.includes(${JSON.stringify(fragment)})`, ms, `text "${fragment}"`)
  }
  waitGone(fragment, ms = 15000) {
    return this.waitFor(`document.body && !document.body.innerText.includes(${JSON.stringify(fragment)})`, ms, `text gone "${fragment}"`)
  }
  waitSel(sel, ms = 15000) {
    return this.waitFor(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e && e.getClientRects().length > 0 })()`, ms, `element ${sel}`)
  }
  async navigate(url) {
    await this.send('Page.navigate', { url })
    await sleep(400)
  }
  async reload() {
    await this.send('Page.reload', {})
    await sleep(600)
  }

  // Centre of the first visible element matching `sel` (optionally whose text includes `text`),
  // scrolled into view. Null if none.
  async centre(sel, text) {
    return this.eval(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((el) => el.getClientRects().length > 0
        && (${JSON.stringify(text ?? null)} === null || el.innerText.includes(${JSON.stringify(text ?? '')})))
      const el = els[0]
      if (!el) return null
      el.scrollIntoView({ block: 'center', inline: 'center' })
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: Boolean(el.disabled) }
    })()`)
  }
  async mouseClick(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(120)
  }
  // Real mouse click on an element (by CSS selector, optionally narrowed by its text).
  async clickSel(sel, text, { allowDisabled = false } = {}) {
    const c = await this.centre(sel, text)
    if (!c) throw new Error(`[${this.label}] nothing to click: ${sel}${text ? ` "${text}"` : ''}`)
    if (c.disabled && !allowDisabled) throw new Error(`[${this.label}] disabled: ${sel}${text ? ` "${text}"` : ''}`)
    await this.mouseClick(c.x, c.y)
  }
  // Real mouse click on the first visible, enabled button whose text includes `label`.
  async click(label, scope = '') {
    return this.clickSel(`${scope ? `${scope} ` : ''}button`, label)
  }
  async isDisabled(label, scope = '') {
    return this.eval(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(`${scope ? `${scope} ` : ''}button`)})].find((el) => el.getClientRects().length && el.innerText.includes(${JSON.stringify(label)})); return b ? b.disabled : null })()`)
  }
  async wheel(sel, deltaY = -300) {
    const c = await this.centre(sel)
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY })
    await sleep(300)
  }
  // Types into an input the way React sees it (native setter + input event).
  async type(sel, value) {
    const ok = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)})
      if (!el) return false
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    if (!ok) throw new Error(`[${this.label}] no input ${sel}`)
    await sleep(80)
  }
  // Closes an open popup the way a player does: tapping outside it.
  async tapOutside() {
    await this.mouseClick(6, 6)
    await sleep(200)
  }
  async screenshot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(this.outDir, `${name}.png`)
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }
}
