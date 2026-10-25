// Regression phase 3 — the real app in a real (headless) Chrome, played the way a team plays it:
// two "phones" side by side, a captain and a member, each with its own storage, on a production-
// style build (dev mode OFF) served by the suite's private test stack.
//
//   registration (incl. its error messages) → welcome + team name → instructions → the full
//   guided walkthrough (every coach step, incl. playing/pausing/minimising/closing narration) →
//   the clock starting for both phones → Find it / Prove it with a hint, a reveal, a right and a
//   wrong answer → landmark detail → every quiz format the route reaches → the member's phone
//   following along (and being blocked from answering) → Map view (real OSM map, pins, POI card,
//   photo, narration) → Help menu (page help, coming soon, report a problem, stop + restart the
//   clock on both phones, hand captaincy over and back) → resuming after closing the app → the
//   final landmark → tour-complete celebration → certificate → emailing it (test transport, never
//   really sent) → "start another tour".
//
// Run on its own:  node scripts/regression/ui.mjs   (builds and starts its own test stack)

import path from 'node:path'
import { makeRecorder, apiClient, unsealLandmark, readableAnswer, createTestCode, OUT, sleep } from './lib/common.mjs'
import { launchChrome, newPhone } from './lib/cdp.mjs'

const CDP_PORT = 9351
const SESSION_JS = `JSON.parse(localStorage.getItem('tourz.session') || 'null')`

export async function runUiPhase({ api: apiBase, app, db, tourCode = 'edinburgh' }) {
  const rec = makeRecorder('ui')
  const call = apiClient(apiBase)
  const shots = path.join(OUT, 'ui-screens')
  ;(await import('node:fs')).mkdirSync(shots, { recursive: true })
  const code = await createTestCode(db, { tourCode, maxPlayers: 3, label: 'UI' })
  const { rows: [start] } = await db.query(
    `SELECT l.latitude, l.longitude FROM landmarks l JOIN tours t ON t.id = l.tour_id WHERE t.tour_code = $1 ORDER BY l.sequence_order LIMIT 1`, [tourCode])

  const chrome = await launchChrome({ port: CDP_PORT, profileDir: path.join(OUT, 'ui-chrome-profile') })
  const phone = (label) => newPhone(chrome.cdp, { label, origin: app, outDir: shots, lat: Number(start.latitude), lng: Number(start.longitude) })
  const cap = await phone('captain')
  const mem = await phone('member')
  let aborted = null
  let shotNo = 0

  // A step that later steps depend on: if it fails, the rest are reported as skipped rather than
  // producing a cascade of confusing failures.
  async function step(name, fn, { critical = false } = {}) {
    if (aborted) return rec(`${name}`, false, `skipped — an earlier step failed (${aborted})`)
    try {
      await fn()
    } catch (err) {
      const n = String(++shotNo).padStart(2, '0')
      const files = []
      for (const p of [cap, mem]) { try { files.push(await p.screenshot(`FAIL-${n}-${p.label}`)) } catch { /* page gone */ } }
      rec(`${name}`, false, `${err.message.split('\n')[0]} (screenshots: ${files.map((f) => path.basename(f)).join(', ')})`)
      if (critical) aborted = name
    }
  }
  // Each later step starts from the landmark screen, so one failure can't strand the next step.
  const goPlay = async (p) => {
    if ((await p.url()) !== '/play') await p.navigate(`${app}/play`)
    await p.waitText('Find it clue', 15000)
  }
  const shot = async (p, name) => { try { await p.screenshot(`${String(++shotNo).padStart(2, '0')}-${p.label}-${name}`) } catch { /* ignore */ } }

  let capToken
  let memToken
  let state
  const pkgFor = (seq) => unsealLandmark(state, capToken, seq)
  const score = async () => (await call('GET', '/api/game/clock', { token: capToken })).body.totalScore

  try {
    // ---------------------------------------------------------------- registration
    await step('registration page loads with dev mode off', async () => {
      await cap.navigate(`${app}/`)
      await cap.waitText('Welcome to the tour', 20000)
      rec('registration page loads with dev mode off', !(await cap.text()).includes('Dev'))
      await shot(cap, 'registration')
    }, { critical: true })

    await step('registration form validation', async () => {
      await cap.click('Submit')
      await cap.waitText('Please fill in your name')
      rec('empty registration form shows a clear error', true)
      await cap.type('#reg-name', 'ZZ UI Captain')
      await cap.clickSel('.avatar-picker-grid button')
      await cap.clickSel('input[value="captain"]')
      await cap.type('#reg-code', 'ZZ-NO-SUCH-CODE')
      await cap.click('Submit')
      await cap.waitText('not recognised')
      rec('unknown game code shows "not recognised"', true)
    })

    await step('captain registers', async () => {
      await cap.type('#reg-code', code)
      await cap.click('Submit')
      await cap.waitText('Welcome ZZ UI Captain', 15000)
      rec('captain registers and lands on the welcome page', (await cap.url()) === '/welcome')
      capToken = (await cap.eval(SESSION_JS)).sessionToken
      rec('captain is told they are the captain', (await cap.text()).includes('registered as the team captain'))
      rec('"See instructions" is locked until the team has a name', (await cap.isDisabled('See instructions')) === true)
      await cap.type('input[placeholder="Your team name"]', 'ZZ UI Team')
      await cap.click('Save')
      await cap.waitText('Your team name is')
      rec('team name saved and shown', (await cap.text()).includes('ZZ UI Team') && (await cap.isDisabled('See instructions')) === false)
      await shot(cap, 'welcome')
    }, { critical: true })

    await step('member registers', async () => {
      await mem.navigate(`${app}/`)
      await mem.waitText('Welcome to the tour', 20000)
      await mem.type('#reg-name', 'ZZ UI Member')
      await mem.clickSel('.avatar-picker-grid button:nth-child(3)')
      await mem.clickSel('input[value="captain"]')
      await mem.type('#reg-code', code)
      await mem.click('Submit')
      await mem.waitText('captain has already registered')
      rec('a second captain is turned away with a clear message', true)
      await mem.clickSel('input[value="member"]')
      await mem.click('Submit')
      await mem.waitText('Welcome ZZ UI Member', 15000)
      memToken = (await mem.eval(SESSION_JS)).sessionToken
      const t = await mem.text()
      rec('member sees the team name and their captain', t.includes('ZZ UI Team') && t.includes('ZZ UI Captain') && t.includes('2nd member'))
    }, { critical: true })

    // ---------------------------------------------------------------- instructions + walkthrough
    async function readInstructions(p) {
      await p.click('See instructions')
      // The progress label is upper-cased by CSS, which innerText reflects — match ignoring case.
      await p.waitFor(`/instructions 1\\//i.test(document.body.innerText)`, 15000, 'instructions page 1')
      const total = Number((await p.text()).match(/instructions 1\/(\d+)/i)[1])
      for (let i = 1; i < total; i++) {
        await p.click('i have read this - next')
        await p.waitFor(`/instructions ${i + 1}\\/${total}/i.test(document.body.innerText)`, 5000, `instructions page ${i + 1}`)
      }
      await p.click("let's start the tour")
      return total
    }

    // Every coach step, in coach-steps.csv order, tapped (or scrolled) for real.
    const COACH = [
      'map-rbs-landmark-marker', 'detail-popup-back-btn', 'WHEEL', 'map-poi-marker', 'narration-entry-icon',
      'narration-play-btn', 'detail-popup-back-btn', 'narration-play-btn', 'narration-minimize-btn',
      'narration-mini-close-btn', 'help-btn', 'help-menu-show-instructions', 'help-instructions-back-btn',
      'home-current-landmark-btn', 'ANYWHERE',
    ]
    // A map pin that's actually tappable: on screen, inside the map, and on top at its centre
    // (map pins are positioned by the map itself, so off-screen ones can't be scrolled to).
    const tappablePinJs = (sel) => `(() => {
      const map = document.querySelector('[data-coach-id="map-navigation-area"]').getBoundingClientRect()
      const pop = document.querySelector('.coach-popup')?.getBoundingClientRect()
      for (const el of document.querySelectorAll(${JSON.stringify(sel)})) {
        const r = el.getBoundingClientRect()
        const x = r.left + r.width / 2, y = r.top + r.height / 2
        if (x < map.left + 20 || x > map.right - 20 || y < map.top + 60 || y > map.bottom - 60) continue
        if (pop && x > pop.left - 10 && x < pop.right + 10 && y > pop.top - 10 && y < pop.bottom + 10) continue
        const top = document.elementFromPoint(x, y)
        if (top && el.contains(top)) return { x, y }
      }
      return null
    })()`
    const OPEN_POI_JS = tappablePinJs('[data-coach-id="map-poi-marker"]')
    async function runCoach(p) {
      await p.waitSel('.coach-popup', 20000)
      let audioPlayed = false
      for (const [n, target] of COACH.entries()) {
        const before = await p.eval(`document.querySelector('.coach-popup')?.innerText || ''`)
        if (target === 'WHEEL') await p.wheel('[data-coach-id="map-navigation-area"]')
        else if (target === 'ANYWHERE') await p.mouseClick(200, 300)
        else if (target === 'map-poi-marker') {
          await p.waitFor(OPEN_POI_JS, 10000, 'a tappable POI pin')
          const at = await p.eval(OPEN_POI_JS)
          await p.mouseClick(at.x, at.y)
        } else {
          await p.waitSel(`[data-coach-id="${target}"]`, 10000)
          if (n === 5) { // the "pause" step: narration should be playing by now
            await p.waitFor(`(() => { const a = document.querySelector('audio'); return a && a.currentTime > 0.3 && !a.paused })()`, 10000, 'narration playing').then(() => { audioPlayed = true }).catch(() => {})
          }
          await p.clickSel(`[data-coach-id="${target}"]`)
        }
        await p.waitFor(`(document.querySelector('.coach-popup')?.innerText || '') !== ${JSON.stringify(before)}`, 8000, `coach step ${n + 1} (${target}) to advance`)
        const now = await p.eval(`document.querySelector('.coach-popup')?.innerText || ''`)
        if (/not quite right|let me help/i.test(now)) throw new Error(`coach step ${n + 1} (${target}) was judged a wrong tap`)
      }
      return audioPlayed
    }

    await step('member: instructions and walkthrough', async () => {
      const pages = await readInstructions(mem)
      rec('member reads every instructions page', true, `${pages} pages`)
      const played = await runCoach(mem)
      rec('member completes all 15 walkthrough steps', true)
      rec('narration audio plays during the walkthrough', played)
      await mem.waitText('Waiting for your captain', 10000)
      rec('member is held at "Waiting for your captain" until the captain finishes', (await call('GET', '/api/game/clock', { token: memToken })).body.started === false)
      await shot(mem, 'waiting-for-captain')
    })

    await step('captain: instructions and walkthrough start the clock', async () => {
      await readInstructions(cap)
      await runCoach(cap)
      rec('captain completes all 15 walkthrough steps', true)
      await cap.waitText('Find it clue', 15000)
      const clk = (await call('GET', '/api/game/clock', { token: capToken })).body
      rec('the clock starts when the captain finishes the walkthrough', clk.started === true && clk.paused === false)
      await mem.waitGone('Waiting for your captain', 15000)
      rec("member's phone unfreezes on its own", true)
      await shot(cap, 'play-first-landmark')
    }, { critical: true })

    // ---------------------------------------------------------------- landmarks
    state = (await call('GET', '/api/game/state', { token: capToken })).body
    const first = state.tour.firstPlayableSequence
    const last = state.tour.lastPlayableSequence

    async function answerQuiz(p, pkg, { right }) {
      const fmt = pkg.quiz[0].type
      if (fmt === 'multiple_choice') {
        await p.waitSel('.quiz-question')
        for (const [i, q] of pkg.quiz.entries()) {
          const pick = right || i % 2 ? q.payload.correct : q.payload.options.find((o) => o !== q.payload.correct)
          const at = await p.eval(`(() => {
            const block = document.querySelectorAll('.quiz-question')[${i}]
            const opt = [...block.querySelectorAll('.quiz-opt')].find((b) => b.innerText.trim() === ${JSON.stringify(pick)})
            opt.scrollIntoView({ block: 'center' })
            const r = opt.getBoundingClientRect()
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
          })()`)
          await p.mouseClick(at.x, at.y)
          const sub = await p.eval(`(() => { const b = document.querySelectorAll('.quiz-question')[${i}].querySelector('.quiz-submit'); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
          await p.mouseClick(sub.x, sub.y)
          await p.waitFor(`document.querySelectorAll('.quiz-question')[${i}].innerText.match(/Correct!|Not quite/)`, 5000, `quiz Q${i + 1} result`)
        }
      } else if (fmt === 'five_right') {
        await p.waitSel('.five-right-grid')
        const tiles = pkg.quiz[0].payload.tiles
        const good = tiles.filter((t) => t.correct).map((t) => t.name)
        const names = right ? good : [...good.slice(1), tiles.find((t) => !t.correct).name]
        for (const name of names) await p.clickSel('.five-right-grid button', name)
        await p.waitText(`${names.length} tile`, 3000)
        await p.clickSel('.quiz-submit')
      } else if (fmt === 'anagram') {
        await p.waitSel('.anagram-board')
        await p.clickSel('.quiz-submit')
        await p.waitFor(`/Correct!|Not quite/.test(document.body.innerText)`, 5000, 'anagram result')
      }
      await p.waitText('Head to next landmark', 8000)
      return fmt
    }

    await step('L1: hint, right answer, landmark page, quiz', async () => {
      const pkg = pkgFor(first)
      await mem.clickSel('[data-coach-id="home-current-landmark-btn"]').catch(() => {})
      await mem.waitText('Find it clue', 15000)
      rec("member can't take hints or answer", (await mem.isDisabled('Get a hint')) === true && (await mem.text()).includes('Only your team captain can submit an answer'))
      await cap.click('Get a hint')
      await cap.click('Use hint', '.modal-actions')
      await cap.waitText('Hint 1:', 5000)
      rec('captain takes a hint', (await cap.text()).includes(pkg.hints[0].slice(0, 30)))
      await mem.waitText(pkg.hints[0].slice(0, 30), 20000)
      rec("the hint appears on the member's phone", true)
      await cap.type('input[placeholder="Your answer"]', readableAnswer(pkg.puzzle))
      await cap.clickSel('form.answer-form button[type=submit]')
      await cap.waitText('is Correct!', 8000)
      rec('right Prove it answer is marked correct', true)
      await cap.click('See landmark')
      await cap.waitSel('.detail-popup')
      rec("landmark's detail page opens with its photo and text", (await cap.text()).includes(pkg.title) && await cap.eval(`(() => { const i = document.querySelector('.detail-popup-image'); return Boolean(i && i.complete && i.naturalWidth > 0) })()`))
      await cap.clickSel('[data-coach-id="detail-popup-back-btn"]')
      await cap.click('Take the quiz')
      const fmt = await answerQuiz(cap, pkg, { right: true })
      rec(`quiz answered (${fmt})`, true)
      await cap.click('Head to next landmark')
      await cap.waitText(pkgFor(first + 1).clue.text.slice(0, 40), 8000)
      rec('next landmark\'s clue appears', true)
      await mem.waitText(pkgFor(first + 1).clue.text.slice(0, 40), 20000)
      rec("member's phone moves on to the next landmark too", true)
      await sleep(5000)
      const pill = await cap.eval(`document.querySelector('.home-pill-brass')?.innerText || ''`)
      const s = await score()
      rec('score shown on the phone matches the server', pill.includes(String(s)), `phone "${pill}", server ${s}`)
    }, { critical: true })

    await step('L2: reveal, wrong answer, quiz', async () => {
      const pkg = pkgFor(first + 1)
      await cap.click('Reveal location')
      await cap.click('Reveal anyway', '.modal-actions')
      await cap.waitText(pkg.title, 8000)
      rec('reveal shows the landmark\'s name', true)
      await cap.type('input[placeholder="Your answer"]', 'zz definitely wrong')
      await cap.clickSel('form.answer-form button[type=submit]')
      await cap.waitText('is wrong - the answer is', 8000)
      rec('wrong Prove it answer shows the right one', true)
      await cap.click('Take the quiz')
      const fmt = await answerQuiz(cap, pkg, { right: false })
      rec(`quiz answered with mistakes (${fmt})`, true)
      await cap.click('Head to next landmark')
      await cap.waitText(pkgFor(first + 2).clue.text.slice(0, 40), 8000)
      await shot(cap, 'after-L2')
    }, { critical: true })

    // ---------------------------------------------------------------- map view
    await step('Map view', async () => {
      await cap.click('MAP')
      await cap.waitSel('.osm-map canvas', 20000)
      await sleep(2500)
      const pins = await cap.eval(`document.querySelectorAll('.map-pin-landmark').length`)
      rec('map shows the start landmark and both found landmarks', pins >= 3, `${pins} landmark pins`)
      const pois = await cap.eval(`document.querySelectorAll('[data-coach-id="map-poi-marker"]').length`)
      rec('map shows the POI pins', pois > 10, `${pois}`)
      const drawn = await cap.eval(`(() => { const c = document.querySelector('.osm-map canvas'); return c && c.width > 0 && c.height > 0 })()`)
      rec('real OSM map is drawn (not the nearby-list fallback)', drawn && !(await cap.text()).includes('Nearby'))
      const lmPin = await cap.eval(tappablePinJs('.map-pin-landmark'))
      if (!lmPin) throw new Error('no landmark pin on screen')
      await cap.mouseClick(lmPin.x, lmPin.y)
      await cap.waitSel('.detail-popup')
      await cap.waitFor(`(() => { const i = document.querySelector('.detail-popup-image'); return i && i.complete && i.naturalWidth > 0 })()`, 8000, 'landmark photo')
      rec('tapping a landmark pin opens its card with photo', true)
      await cap.clickSel('[data-coach-id="detail-popup-back-btn"]')
      const at = await cap.eval(OPEN_POI_JS)
      await cap.mouseClick(at.x, at.y)
      await cap.waitSel('.detail-popup')
      await cap.waitFor(`(() => { const i = document.querySelector('.detail-popup-image'); return !i || (i.complete && i.naturalWidth > 0) })()`, 8000, 'POI photo')
      rec('tapping a POI opens its card with photo', true, await cap.eval(`document.querySelector('.detail-popup h2, .detail-popup h3, .detail-popup-title')?.innerText || ''`))
      await cap.clickSel('[data-coach-id="narration-entry-icon"]')
      await cap.waitFor(`(() => { const a = document.querySelector('audio'); return a && a.currentTime > 0.3 && !a.paused })()`, 10000, 'POI narration playing')
      rec('"Listen here" plays the POI narration', true)
      await cap.clickSel('.narration-close-btn')
      await cap.clickSel('[data-coach-id="detail-popup-back-btn"]')
      await shot(cap, 'map-view')
      await cap.clickSel('[data-coach-id="home-current-landmark-btn"]')
      await cap.waitText('Find it clue', 8000)
    })

    // ---------------------------------------------------------------- help menu
    await step('Help menu: page help, coming soon, report a problem', async () => {
      await goPlay(cap)
      await cap.clickSel('[data-coach-id="help-btn"]')
      await cap.click('Help on this page', '.help-menu')
      await cap.waitSel('.why-card')
      rec('"Help on this page" opens', true)
      await cap.tapOutside()
      await cap.clickSel('[data-coach-id="help-btn"]')
      await cap.click('About this tour', '.help-menu')
      await cap.waitText('coming soon', 5000)
      rec('"About this tour" says coming soon', true)
      await cap.tapOutside()
      await cap.clickSel('[data-coach-id="help-btn"]')
      await cap.click('Report a problem', '.help-menu')
      await cap.type('.report-problem-textarea', 'ZZ regression test report — please ignore')
      await cap.click('Submit', '.report-problem-card')
      await cap.waitText('Problem report sent', 15000)
      rec('"Report a problem" sends (test mail transport)', true)
      await sleep(2500)
    })

    await step('Help menu: stop and restart the clock', async () => {
      await goPlay(cap)
      await goPlay(mem)
      await cap.clickSel('[data-coach-id="help-btn"]')
      await cap.click('Stop the clock', '.help-menu')
      await cap.click('Stop the clock', '.modal-actions')
      await cap.waitText('stopped the clock', 8000)
      rec('captain stops the clock', (await call('GET', '/api/game/clock', { token: capToken })).body.paused === true)
      await mem.waitText('Your captain has stopped the clock', 20000)
      rec("member's phone freezes with \"Your captain has stopped the clock\"", true)
      await shot(mem, 'clock-stopped')
      await cap.click('Restart clock')
      await cap.waitGone('stopped the clock', 8000)
      await mem.waitGone('Your captain has stopped the clock', 20000)
      rec('restarting unfreezes both phones', (await call('GET', '/api/game/clock', { token: capToken })).body.paused === false)
    })

    await step('Help menu: hand captaincy over and back', async () => {
      await goPlay(cap)
      await goPlay(mem)
      await cap.clickSel('[data-coach-id="help-btn"]')
      await cap.click('Change team captain', '.help-menu')
      await cap.clickSel('.captain-pick-item', 'ZZ UI Member')
      await cap.click('Submit', '.captain-picker')
      await mem.waitFor(`(() => { const b = [...document.querySelectorAll('button')].find((e) => e.innerText.includes('Get a hint')); return b && !b.disabled })()`, 20000, 'member gets captain controls')
      rec("new captain's phone gets the answer buttons", true)
      await cap.waitFor(`(() => { const b = [...document.querySelectorAll('button')].find((e) => e.innerText.includes('Get a hint')); return b && b.disabled })()`, 20000, 'old captain loses captain controls')
      rec("old captain's phone loses them", true)
      await mem.clickSel('[data-coach-id="help-btn"]')
      await mem.click('Change team captain', '.help-menu')
      await mem.clickSel('.captain-pick-item', 'ZZ UI Captain')
      await mem.click('Submit', '.captain-picker')
      await cap.waitFor(`(() => { const b = [...document.querySelectorAll('button')].find((e) => e.innerText.includes('Get a hint')); return b && !b.disabled })()`, 20000, 'captain controls back')
      rec('captaincy handed back', true)
    })

    await step('closing and reopening the app resumes the game', async () => {
      await cap.navigate(`${app}/`)
      await cap.waitFor(`location.pathname === '/home'`, 15000, 'resume to /home')
      await sleep(1500)
      rec('reopening goes straight back into the tour (no registration, no walkthrough again)', !(await cap.eval(`Boolean(document.querySelector('.coach-popup'))`)) && (await cap.url()) === '/home')
      await cap.clickSel('[data-coach-id="home-current-landmark-btn"]')
      await cap.waitText('Find it clue', 8000)
    })

    // ---------------------------------------------------------------- the finish
    await step('final landmark, tour complete, certificate', async () => {
      // Landmarks 3..last-1 straight through the API (the screens for them are the same ones
      // already tested); the last one's Prove it too, so the finish happens on screen.
      for (let seq = first + 2; seq <= last; seq++) {
        const pkg = pkgFor(seq)
        await call('POST', '/api/game/puzzle/answer', { token: capToken, body: { answer: readableAnswer(pkg.puzzle) } })
        if (seq === last) break
        for (const q of pkg.quiz) {
          const answer = q.type === 'five_right' ? q.payload.tiles.filter((t) => t.correct).map((t) => t.id) : q.type === 'anagram' ? q.payload.solution : q.payload.correct
          await call('POST', '/api/game/quiz/answer', { token: capToken, body: { questionId: q.id, answer } })
        }
        await call('POST', '/api/game/advance', { token: capToken })
      }
      await cap.navigate(`${app}/play`)
      // Opening /play on a landmark whose Prove it is already answered goes straight to its quiz
      // (no "Take the quiz" popup) — accept either.
      await cap.waitFor(`document.body.innerText.includes('Take the quiz') || document.querySelector('.quiz-question, .five-right-grid, .anagram-board')`, 20000, 'final quiz')
      if ((await cap.text()).includes('Take the quiz')) await cap.click('Take the quiz')
      const fmt = await answerQuiz(cap, pkgFor(last), { right: true })
      rec(`final landmark's quiz answered on screen (${fmt})`, true)
      await cap.click('Head to next landmark')
      await cap.waitText('Get your certificate', 10000)
      rec('tour-complete celebration appears', (await cap.text()).includes('Congratulations'))
      await shot(cap, 'tour-complete')
      await cap.click('Get your certificate')
      await cap.waitFor(`location.pathname === '/certificate'`, 10000, '/certificate')
      await cap.waitText('ZZ UI Team', 10000)
      const s = await score()
      rec('certificate shows the team, player and final score', (await cap.text()).includes('ZZ UI Captain') && (await cap.text()).includes(String(s)), `${s} pts`)
      await shot(cap, 'certificate')
      await cap.click('Save and send')
      await cap.type('input[type=email]', 'zz-fake-player@example.invalid')
      await cap.click('Send')
      await cap.waitText('Sent to zz-fake-player@example.invalid', 30000)
      rec('certificate emailed (test mail transport — not really sent)', true)
      await cap.reload()
      await cap.waitFor(`location.pathname === '/certificate'`, 15000, 'certificate after reload')
      rec('the certificate is "sticky" — reopening the app goes back to it', true)
    })

    await step("member's phone finishes too, then starts another tour", async () => {
      await mem.navigate(`${app}/`)
      await mem.waitFor(`location.pathname === '/certificate'`, 20000, 'member resumes to /certificate')
      await mem.waitText('ZZ UI Member', 10000)
      rec("member's phone resumes to their own certificate", true)
      await mem.click('Start another tour')
      await mem.click('Yes, start another tour')
      await mem.waitText('Welcome to the tour', 10000)
      rec('"Start another tour" clears the phone back to registration', (await mem.eval(SESSION_JS)) === null)
    })

    rec('no JavaScript errors on the captain\'s phone', cap.errors.length === 0, cap.errors.slice(0, 3).join(' | '))
    rec('no JavaScript errors on the member\'s phone', mem.errors.length === 0, mem.errors.slice(0, 3).join(' | '))
    console.log(`  screenshots: ${shots}`)
  } finally {
    chrome.close()
  }
  return rec.results
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const { localDb, deleteTestCodes } = await import('./lib/common.mjs')
  const stack = await import('./lib/stack.mjs')
  const db = await localDb()
  try {
    await stack.startApi()
    if (!process.argv.includes('--no-build')) stack.buildClient()
    await stack.startClient()
    const results = await runUiPhase({ api: stack.API, app: stack.APP, db, tourCode: process.argv.find((a) => a.startsWith('--tour='))?.slice(7) || 'edinburgh' })
    const failed = results.filter((r) => !r.ok)
    console.log(`\n${results.length - failed.length}/${results.length} passed`)
    process.exitCode = failed.length ? 1 : 0
  } finally {
    await deleteTestCodes(db)
    await db.end()
    stack.stopAll()
  }
}
