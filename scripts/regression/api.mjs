// Regression phase 2 — the server's API, end to end, as real players would hit it.
//
// For EVERY tour in the local database: registers a fresh team on a throwaway ZZ-REG-* code
// (captain + 2 members), checks every registration rule, then plays the WHOLE tour through the
// API, landmark by landmark, rotating through every way of playing one (clean solve, hints,
// wrong answer, reveal) and every quiz format the route reaches, checking the score after every
// step against the documented scoring rules. Along the way: permissions (captain-only actions,
// missing/invalid sessions), "never reveal in advance" (titles, answers, detail pages), the tour
// clock (start rule, stops, restart, the 2-stop limit), captain handoff, narration bonus,
// offline sync (batch, re-send, back-dating), the email endpoints (with the test server's
// no-send mail transport), the certificate, time running out, and the static photo/audio files.
//
// Run on its own:  node scripts/regression/api.mjs   (starts its own test server)
// Normally run via run-all.mjs.

import { makeRecorder, apiClient, unsealLandmark, readableAnswer, createTestCode } from './lib/common.mjs'

const puzzlePoints = (hints, reveal, correct) => (!correct ? 0 : reveal ? 1 : Math.max(1, 5 - hints))
const quizPoints = (n) => ({ 4: 5, 3: 3, 2: 2, 1: 1, 0: 0 }[n] ?? 0)

export async function runApiPhase({ api: base, db }) {
  const rec = makeRecorder('api')
  const call = apiClient(base)

  const { rows: tours } = await db.query('SELECT id, tour_code, name FROM tours ORDER BY id')

  // ---- 1. basics ----
  await rec.section('basics', async () => {
    const h = await call('GET', '/api/health')
    rec('health check answers', h.status === 200 && h.body?.ok === true)
    const gets = ['/api/game/session', '/api/game/home', '/api/game/current', '/api/game/map', '/api/game/clock', '/api/game/state', '/api/game/tour-pack', '/api/game/certificate', '/api/game/narration/latest']
    const noToken = await Promise.all(gets.map((p) => call('GET', p)))
    rec('every game endpoint refuses a request with no session (401)', noToken.every((r) => r.status === 401), noToken.filter((r) => r.status !== 401).length ? `not 401: ${gets.filter((_, i) => noToken[i].status !== 401).join(', ')}` : `${gets.length} endpoints`)
    const badToken = await Promise.all(gets.map((p) => call('GET', p, { token: 'zz-not-a-real-session-token' })))
    rec('every game endpoint refuses a made-up session token (401)', badToken.every((r) => r.status === 401))
    const posts = ['/api/game/clue/hint', '/api/game/puzzle/answer', '/api/game/quiz/answer', '/api/game/advance', '/api/game/sync', '/api/game/clock/stop', '/api/game/certificate/send', '/api/game/problem-report']
    const noTokenPosts = await Promise.all(posts.map((p) => call('POST', p, { body: {} })))
    rec('every game action refuses a request with no session (401)', noTokenPosts.every((r) => r.status === 401))
    const dev = await call('POST', '/api/dev/complete/1', { token: 'zz-not-a-real-session-token' })
    rec.warn('the /api/dev/* shortcuts exist on every server, production included (they still need a valid session)', `dev endpoint with a fake token → ${dev.status}`)
  })

  for (const tour of tours) await playTour(tour)
  await timeUpScenario(tours[0])

  // ---- static files ----
  await rec.section('static files', async () => {
    const { rows: [site] } = await db.query('SELECT image_path, audio_path FROM sites WHERE image_path IS NOT NULL AND audio_path IS NOT NULL LIMIT 1')
    const img = await fetch(`${base}/content-photos/${encodeURI(site.image_path)}`)
    rec('a POI photo is served', img.status === 200 && /^image\//.test(img.headers.get('content-type') || ''), `${img.status} ${img.headers.get('content-type')}`)
    const audio = await fetch(`${base}/content-audio/${encodeURI(site.audio_path)}`, { headers: { Range: 'bytes=0-1023' } })
    rec('narration audio answers a Range request with 206 (needed for seeking on iPhone)', audio.status === 206, `${audio.status} ${audio.headers.get('content-range')}`)
    const missing = await fetch(`${base}/content-photos/zz-no-such-photo.jpg`)
    rec('a missing photo is a 404', missing.status === 404)
  })

  return rec.results

  // =============================================================================================
  async function register(code, name, role, avatar = '🦊') {
    return call('POST', '/api/register', { body: { code, name, avatar, role } })
  }

  async function playTour(tour) {
    const T = tour.tour_code
    const code = await createTestCode(db, { tourCode: T, maxPlayers: 3, label: T.slice(0, 4) })
    let captain, memberA, memberB

    // ---- registration ----
    await rec.section(`${T}: registration`, async () => {
      rec(`${T}: registration with missing details is refused (400)`, (await call('POST', '/api/register', { body: { code } })).status === 400)
      rec(`${T}: registration with an invalid role is refused (400)`, (await register(code, 'ZZ Test', 'king')).status === 400)
      rec(`${T}: an unknown game code is refused (404)`, (await register('ZZ-NO-SUCH-CODE', 'ZZ Test', 'captain')).status === 404)
      const expired = await createTestCode(db, { tourCode: T, status: 'expired', label: 'EXP' })
      const ex = await register(expired, 'ZZ Test', 'captain')
      rec(`${T}: an expired game code is refused (400)`, ex.status === 400 && /expired/i.test(ex.body?.error), ex.body?.error)

      const c = await register(code, '  ZZ Test Captain  ', 'captain', '🦁')
      rec(`${T}: captain registers and activates the code`, c.status === 200 && c.body.player.isCaptain && c.body.registrationNumber === 1 && c.body.maxPlayers === 3, `#${c.body?.registrationNumber}`)
      rec(`${T}: player name is trimmed`, c.body?.player?.name === 'ZZ Test Captain', JSON.stringify(c.body?.player?.name))
      rec(`${T}: time limit comes from the tour`, c.body?.timeLimitMinutes > 0, `${c.body?.timeLimitMinutes} min`)
      captain = c.body.sessionToken
      const { rows: [gc] } = await db.query('SELECT status FROM game_codes WHERE code = $1', [code])
      rec(`${T}: game code is marked activated`, gc.status === 'activated')

      const c2 = await register(code, 'ZZ Second Captain', 'captain')
      rec(`${T}: a second captain is refused (400)`, c2.status === 400 && /captain/i.test(c2.body?.error), c2.body?.error)
      const a = await register(code, 'ZZ Test Member A', 'member', '🐼')
      rec(`${T}: member A joins as #2 and sees the captain's name`, a.status === 200 && a.body.registrationNumber === 2 && !a.body.player.isCaptain && a.body.captainName === 'ZZ Test Captain')
      memberA = a.body.sessionToken
      const b = await register(code, 'ZZ Test Member B', 'member', '🐸')
      rec(`${T}: member B joins as #3`, b.status === 200 && b.body.registrationNumber === 3)
      memberB = b.body.sessionToken
      const full = await register(code, 'ZZ Too Many', 'member')
      rec(`${T}: a 4th player is refused when the team is full (400)`, full.status === 400 && /full/i.test(full.body?.error), full.body?.error)
      rec(`${T}: session tokens are unique and long`, new Set([captain, memberA, memberB]).size === 3 && captain.length >= 40)

      const s = await call('GET', '/api/game/session', { token: memberA })
      rec(`${T}: session endpoint returns the player's live status`, s.status === 200 && s.body.registrationNumber === 2 && s.body.team.name == null)
      rec(`${T}: empty team name is refused (400)`, (await call('POST', '/api/game/team/name', { token: captain, body: { name: '   ' } })).status === 400)
      const tn = await call('POST', '/api/game/team/name', { token: captain, body: { name: ' ZZ Regression Team ' } })
      rec(`${T}: team name is saved (trimmed)`, tn.status === 200 && tn.body.name === 'ZZ Regression Team')
      rec(`${T}: team name can only be set once (400)`, (await call('POST', '/api/game/team/name', { token: memberA, body: { name: 'ZZ Other' } })).status === 400)
      const s2 = await call('GET', '/api/game/session', { token: memberB })
      rec(`${T}: teammates see the team name`, s2.body?.team?.name === 'ZZ Regression Team')
    })
    if (!captain) return

    // ---- before the clock starts ----
    await rec.section(`${T}: before the clock starts`, async () => {
      const clk = await call('GET', '/api/game/clock', { token: captain })
      rec(`${T}: clock has not started after registering`, clk.body.started === false && clk.body.pausesUsed === 0 && clk.body.maxStops === 2 && clk.body.isCaptain === true)
      const cert = await call('GET', '/api/game/certificate', { token: captain })
      rec(`${T}: resume check says: not finished, instructions not done, walkthrough not done`, cert.body.tourComplete === false && cert.body.instructionsComplete === false && cert.body.coachComplete === false)
      const hint = await call('POST', '/api/game/clue/hint', { token: captain, body: { hintNumber: 1 } })
      rec(`${T}: no play before the clock starts (423)`, hint.status === 423 && hint.body.clockBlocked === true, hint.body?.error)
      const cc = await call('POST', '/api/game/team/captain', { token: captain, body: { newCaptainId: 1 } })
      rec(`${T}: captain can't be changed before the clock starts`, cc.status === 423 || cc.status === 400, `${cc.status} ${cc.body?.error}`)
      rec(`${T}: finishing the instructions is recorded`, (await call('POST', '/api/game/instructions-complete', { token: captain })).status === 200 &&
        (await call('GET', '/api/game/certificate', { token: captain })).body.instructionsComplete === true)
      await call('POST', '/api/game/coach-complete', { token: memberA })
      rec(`${T}: a MEMBER finishing the walkthrough does not start the clock`, (await call('GET', '/api/game/clock', { token: memberA })).body.started === false)
      await call('POST', '/api/game/coach-complete', { token: captain })
      const after = await call('GET', '/api/game/clock', { token: memberB })
      rec(`${T}: the CAPTAIN finishing the walkthrough starts the clock for everyone`, after.body.started === true && after.body.paused === false && after.body.remainingSeconds > 0, `${after.body.remainingSeconds}s left`)
    })

    // ---- secrecy and permissions on the first landmark ----
    let state = (await call('GET', '/api/game/state', { token: captain })).body
    const first = state.tour.firstPlayableSequence
    const last = state.tour.lastPlayableSequence
    await rec.section(`${T}: secrecy and permissions`, async () => {
      for (const [label, method, p] of [['hint', 'POST', '/api/game/clue/hint'], ['reveal', 'POST', '/api/game/clue/reveal'], ['Prove it answer', 'POST', '/api/game/puzzle/answer'], ['quiz answer', 'POST', '/api/game/quiz/answer'], ['advance', 'POST', '/api/game/advance'], ['clock stop', 'POST', '/api/game/clock/stop'], ['team roster', 'GET', '/api/game/team/players']]) {
        const r = await call(method, p, { token: memberA, body: method === 'POST' ? { answer: 'x' } : undefined })
        rec(`${T}: a member can't ${label} (403)`, r.status === 403, `${r.status}`)
      }
      const cur = (await call('GET', '/api/game/current', { token: memberA })).body
      rec(`${T}: current landmark starts at the first playable one`, cur.sequenceOrder === first, `seq ${cur.sequenceOrder}`)
      rec(`${T}: landmark name is withheld before Prove it`, cur.title === null && cur.clue.reveal === null)
      rec(`${T}: Prove it answer is withheld before answering`, cur.puzzle.correctAnswer === null && cur.puzzle.explanation === null)
      rec(`${T}: quiz is locked and empty before Prove it`, cur.quiz.unlocked === false && cur.quiz.questions.length === 0)
      rec(`${T}: local test server exposes dev answers (proves it's not a production config)`, Boolean(cur._dev?.puzzleAnswer))
      const home = (await call('GET', '/api/game/home', { token: memberA })).body
      rec(`${T}: home starts with 0 points, nothing in progress`, home.totalScore === 0 && home.currentRevealed == null && home.maxScore > 0 && home.teamName === 'ZZ Regression Team', `max ${home.maxScore}`)
      rec(`${T}: current landmark's detail page is locked (403)`, (await call('GET', `/api/game/landmark/${first}`, { token: memberA })).status === 403)
      rec(`${T}: a future landmark's detail page is locked (403)`, (await call('GET', `/api/game/landmark/${last}`, { token: memberA })).status === 403)
      rec(`${T}: a landmark number that doesn't exist is a 404`, (await call('GET', '/api/game/landmark/9999', { token: memberA })).status === 404)
      if (first > 1) {
        const start = await call('GET', '/api/game/landmark/1', { token: memberA })
        rec(`${T}: the start landmark's detail page is open from the beginning`, start.status === 200 && Boolean(start.body.title), start.body?.title)
      }
      const map = (await call('GET', '/api/game/map', { token: memberA })).body
      rec(`${T}: map has the POIs and no current/future landmark pins`, map.sites.length > 0 && map.currentRevealed == null && map.solvedLandmarks.every((l) => l.sequenceOrder < first), `${map.sites.length} POIs`)
      rec(`${T}: every POI on the map has coordinates`, map.sites.every((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude) && s.latitude !== 0))
      const site = await call('GET', `/api/game/site/${map.sites[0].id}`, { token: memberA })
      rec(`${T}: a POI's detail page opens`, site.status === 200 && Boolean(site.body.title) && 'aboutSiteText' in site.body, site.body?.title)
      const { rows: [otherSite] } = await db.query('SELECT s.id FROM sites s JOIN tours t ON t.id = s.tour_id WHERE t.tour_code <> $1 LIMIT 1', [T])
      if (otherSite) rec(`${T}: another tour's POI can't be opened (404)`, (await call('GET', `/api/game/site/${otherSite.id}`, { token: memberA })).status === 404)
      const pack = (await call('GET', '/api/game/tour-pack', { token: memberA })).body
      rec(`${T}: tour pack holds every POI's full detail`, pack.sites.length === map.sites.length && Boolean(pack.version), `${pack.sites.length} POIs`)
      rec(`${T}: phone gets every playable landmark up front, sealed`, state.lookahead === 'all' && state.landmarks.filter((l) => l.sealed).length === state.tour.playableCount, `${state.tour.playableCount} playable`)
      const firstPkg = unsealLandmark(state, captain, first)
      rec(`${T}: sealed packages don't show names or clues in plain text`, !JSON.stringify(state.landmarks).includes(firstPkg.title) && !JSON.stringify(state.landmarks).includes(firstPkg.clue.text.slice(0, 30)))
      const again = (await call('GET', `/api/game/state?v=${state.version}`, { token: memberA })).body
      rec(`${T}: state poll answers "unchanged" when nothing moved`, again.unchanged === true)
    })

    // ---- the whole tour ----
    let expectedTotal = 0
    let actor = captain // whoever is captain right now
    const strategies = ['clean', 'hints', 'wrong', 'reveal']
    const formatsSeen = new Set()
    let { rows: [captainRow] } = await db.query('SELECT id FROM players WHERE session_token = $1', [captain])
    let { rows: [memberARow] } = await db.query('SELECT id FROM players WHERE session_token = $1', [memberA])

    for (let seq = first, i = 0; seq <= last; seq++, i++) {
      const pkg = unsealLandmark(state, captain, seq)
      if (!pkg) continue // not playable (no puzzle)
      const strategy = pkg.hints.length || strategies[i % 4] !== 'hints' ? strategies[i % 4] : 'clean'
      const viaSync = i === 4
      const label = `${T} L${seq} (${strategy}${viaSync ? ', via offline sync' : ''})`
      let ok = true
      await rec.section(label, async () => {
        const fmt = pkg.quiz[0]?.type
        formatsSeen.add(fmt)
        const actions = []
        const act = async (type, payload) => {
          if (viaSync) { actions.push({ id: `zz-reg-${code}-${seq}-${actions.length}`, type, clientTime: new Date().toISOString(), payload }); return null }
          const routes = { hint: '/api/game/clue/hint', reveal: '/api/game/clue/reveal', puzzle: '/api/game/puzzle/answer', quiz: '/api/game/quiz/answer', advance: '/api/game/advance' }
          return call('POST', routes[type], { token: actor, body: payload })
        }

        if (i === 0) {
          rec(`${label}: quiz can't be answered before Prove it (400)`, (await call('POST', '/api/game/quiz/answer', { token: actor, body: { questionId: pkg.quiz[0].id, answer: 'x' } })).status === 400)
          rec(`${label}: can't advance before the landmark is complete (400)`, (await call('POST', '/api/game/advance', { token: actor })).status === 400)
        }

        let hintsUsed = 0
        let revealUsed = false
        if (strategy === 'hints') {
          const n = Math.min(2, pkg.hints.length)
          for (let h = 1; h <= n; h++) {
            const r = await act('hint', { hintNumber: h })
            if (r) ok = rec(`${label}: hint ${h} is the right hint`, r.status === 200 && r.body.hintText === pkg.hints[h - 1]) && ok
            hintsUsed++
          }
          if (!viaSync) {
            const dup = await act('hint', { hintNumber: 1 })
            rec(`${label}: re-sending hint 1 returns it again without spending another`, dup.body.duplicate === true && dup.body.hintText === pkg.hints[0])
            const skip = await act('hint', { hintNumber: n + 2 })
            rec(`${label}: hints must be taken in order (400)`, skip.status === 400)
            const cur = (await call('GET', '/api/game/current', { token: memberB })).body
            rec(`${label}: teammates see the hints used`, cur.clue.hintsRevealed.length === n && cur.clue.hintsRemaining === pkg.hints.length - n)
          }
        }
        if (strategy === 'reveal') {
          const r = await act('reveal', {})
          if (r) rec(`${label}: reveal gives the landmark's name and place`, r.status === 200 && r.body.title === pkg.title && r.body.latitude != null)
          revealUsed = true
        }

        const correct = strategy !== 'wrong'
        // Fuzzy text answers are matched ignoring case and extra spaces — test that too.
        const right = readableAnswer(pkg.puzzle)
        const answer = correct ? (pkg.puzzle.type === 'fuzzy_text' ? `  ${right.toUpperCase()} ` : right) : 'zz-definitely-wrong-answer'
        const p = await act('puzzle', { answer })
        const puzzlePts = puzzlePoints(hintsUsed, revealUsed, correct)
        if (p) {
          ok = rec(`${label}: Prove it judged ${correct ? 'right' : 'wrong'}, ${puzzlePts} pts`, p.status === 200 && p.body.correct === correct && p.body.pointsEarned === puzzlePts, `${p.status} correct=${p.body?.correct} pts=${p.body?.pointsEarned}`) && ok
          rec(`${label}: Prove it is single-shot (400 on a second answer)`, (await act('puzzle', { answer: right })).status === 400)
        }
        expectedTotal += puzzlePts

        if (!viaSync) {
          const cur = (await call('GET', '/api/game/current', { token: memberB })).body
          rec(`${label}: name revealed once Prove it is answered`, cur.title === pkg.title && cur.puzzle.solved === true && cur.quiz.unlocked === true)
          rec(`${label}: only the landmark's active quiz format is served`, cur.quiz.questions.length === pkg.quiz.length && cur.quiz.questions.every((q) => q.type === fmt), `${cur.quiz.questions.length} × ${fmt}`)
          rec(`${label}: quiz answers withheld until answered`, cur.quiz.questions.every((q) => q.correctAnswer == null && q.explanation == null && (q.type !== 'five_right' || q.tiles.every((t) => t.correct === null))))
          const det = await call('GET', `/api/game/landmark/${seq}`, { token: memberB })
          rec(`${label}: its detail page opens once Prove it is answered`, det.status === 200 && det.body.isCurrent === true && det.body.title === pkg.title)
          const home = (await call('GET', '/api/game/home', { token: memberB })).body
          const map = (await call('GET', '/api/game/map', { token: memberB })).body
          rec(`${label}: home and map show it as the landmark in progress`, home.currentRevealed?.sequenceOrder === seq && map.currentRevealed?.sequenceOrder === seq)
        }

        // Quiz — a mix of right and wrong, every format.
        let correctCount = 0
        let quizPts = 0
        for (const [j, q] of pkg.quiz.entries()) {
          let payload
          if (q.type === 'five_right') {
            const good = q.payload.tiles.filter((t) => t.correct).map((t) => t.id)
            const bad = q.payload.tiles.filter((t) => !t.correct).map((t) => t.id)
            const picked = i % 2 ? [...good, bad[0]] : good
            quizPts = good.length - (i % 2 ? 1 : 0)
            payload = { questionId: q.id, answer: picked }
          } else if (q.type === 'anagram') {
            const right = i % 2 === 0
            quizPts = right ? 5 : 0
            payload = { questionId: q.id, answer: right ? q.payload.solution : 'zzzz' }
          } else {
            const right = (i + j) % 3 !== 0
            if (right) correctCount++
            payload = { questionId: q.id, answer: right ? q.payload.correct : q.payload.options.find((o) => o !== q.payload.correct) }
          }
          const r = await act('quiz', payload)
          if (r) {
            const isLastQ = j === pkg.quiz.length - 1
            ok = rec(`${label}: quiz Q${j + 1} (${q.type}) accepted${isLastQ ? ' and completes the landmark' : ''}`, r.status === 200 && r.body.quizComplete === isLastQ, `${r.status} ${r.body?.error || ''}`) && ok
            if (q.type === 'five_right') rec(`${label}: five-right scores +1 per right tile, −1 per wrong`, r.body.score === quizPts && r.body.tiles.length === q.payload.tiles.length, `score ${r.body.score}, expected ${quizPts}`)
            if (j === 0 && !viaSync) rec(`${label}: a quiz question is single-shot (400 on a second answer)`, (await act('quiz', payload)).status === 400)
          }
        }
        if (fmt === 'multiple_choice') quizPts = quizPoints(correctCount)
        expectedTotal += quizPts

        if (i === 0) {
          const next = unsealLandmark(state, captain, seq + 1)
          if (next?.quiz?.[0]) rec(`${label}: a question from a different landmark is refused (400)`, (await call('POST', '/api/game/quiz/answer', { token: actor, body: { questionId: next.quiz[0].id, answer: 'x' } })).status === 400)
        }

        const adv = await act('advance', {})
        if (adv) rec(`${label}: advance to the next landmark`, adv.status === 200 && adv.body.advanced === true)

        if (viaSync) {
          actions.splice(2, 0, { id: `zz-reg-${code}-${seq}-bogus`, type: 'zz-not-an-action', clientTime: new Date().toISOString() })
          const s = await call('POST', '/api/game/sync', { token: actor, body: { actions } })
          rec(`${label}: sync applies every queued action in order`, s.status === 200 && s.body.results.filter((r) => r.id.endsWith('bogus') === false).every((r) => r.status === 200), s.body?.results?.map((r) => r.status).join(','))
          rec(`${label}: sync rejects an unknown action type (400) without stopping the batch`, s.body.results.find((r) => r.id.endsWith('bogus'))?.status === 400)
          rec(`${label}: sync returns the fresh state`, s.body.state?.team?.currentSequence === seq + 1 && s.body.state.team.totalScore === expectedTotal, `score ${s.body.state?.team?.totalScore}, expected ${expectedTotal}`)
          const again = await call('POST', '/api/game/sync', { token: actor, body: { actions } })
          rec(`${label}: re-sending the same batch (lost reply in a dead spot) applies nothing twice`, again.body.results.filter((r) => r.status === 200).every((r) => r.duplicate) && again.body.state.team.totalScore === expectedTotal && again.body.state.team.currentSequence === seq + 1)
          // Tap time is honoured but clamped to 20 minutes back.
          const oldId = `zz-reg-${code}-${seq}-old`
          await call('POST', '/api/game/sync', { token: actor, body: { actions: [{ id: oldId, type: 'instructions_complete', clientTime: new Date(Date.now() - 3600_000).toISOString() }] } })
          const { rows: [ca] } = await db.query('SELECT applied_time FROM client_actions WHERE id = $1', [oldId])
          const back = (Date.now() - new Date(ca.applied_time).getTime()) / 60000
          rec(`${label}: an action tapped an hour ago is judged at most 20 minutes back`, back > 19 && back < 21, `${back.toFixed(1)} min back`)
        }

        const clk = (await call('GET', '/api/game/clock', { token: memberB })).body
        ok = rec(`${label}: team score is right (${expectedTotal})`, clk.totalScore === expectedTotal, `server ${clk.totalScore}`) && ok
        const prev = await call('GET', `/api/game/landmark/${seq}`, { token: memberB })
        rec(`${label}: completed landmark's detail page stays open`, prev.status === 200 && prev.body.isCurrent === false)
        const home = (await call('GET', '/api/game/home', { token: memberB })).body
        const entry = home.landmarks.find((l) => l.sequenceOrder === seq)
        rec(`${label}: home shows the landmark found with its points`, entry && entry.points === puzzlePts + quizPts && entry.secondsTaken >= 0, `${entry?.points} pts`)
      })
      if (!ok) rec.warn(`${label}: later score checks may cascade from this landmark`)

      // ---- extras, slotted between landmarks ----
      if (i === 1) await clockStops(T, captain, memberA)
      if (i === 2) {
        await rec.section(`${T}: captain handoff`, async () => {
          const roster = await call('GET', '/api/game/team/players', { token: captain })
          rec(`${T}: captain's roster lists the teammates, not themselves`, roster.body.players.length === 2 && !roster.body.players.some((p) => p.id === captainRow.id))
          rec(`${T}: can't hand captaincy to someone outside the team (400)`, (await call('POST', '/api/game/team/captain', { token: captain, body: { newCaptainId: 999999999 } })).status === 400)
          const h = await call('POST', '/api/game/team/captain', { token: captain, body: { newCaptainId: memberARow.id } })
          rec(`${T}: captain hands over to member A`, h.status === 200 && h.body.newCaptainName === 'ZZ Test Member A')
          rec(`${T}: the old captain can no longer play (403)`, (await call('POST', '/api/game/clue/hint', { token: captain, body: { hintNumber: 1 } })).status === 403)
          rec(`${T}: the new captain is told they're captain on their next poll`, (await call('GET', '/api/game/current', { token: memberA })).body.isCaptain === true)
          actor = memberA
        })
      }
      if (i === 3 && actor === memberA) {
        await rec.section(`${T}: captain handback`, async () => {
          const h = await call('POST', '/api/game/team/captain', { token: memberA, body: { newCaptainId: captainRow.id } })
          rec(`${T}: new captain (who just played a landmark) hands back`, h.status === 200)
          actor = captain
        })
      }
      if (i === 5) expectedTotal += await narration(T, memberB, state)
      state = (await call('GET', '/api/game/state', { token: captain })).body
    }
    rec(`${T}: quiz formats played`, formatsSeen.size > 0, [...formatsSeen].join(', '))

    // ---- finished ----
    await rec.section(`${T}: tour complete`, async () => {
      const cur = (await call('GET', '/api/game/current', { token: memberA })).body
      rec(`${T}: current landmark says the tour is complete`, cur.tourComplete === true && cur.totalScore === expectedTotal)
      const cert = (await call('GET', '/api/game/certificate', { token: memberA })).body
      rec(`${T}: certificate has the team, tour, score and every landmark`, cert.tourComplete === true && cert.timeUp === false && cert.teamName === 'ZZ Regression Team' && cert.playerName === 'ZZ Test Member A' && cert.totalScore === expectedTotal && cert.landmarksCompleted === cert.totalLandmarks && cert.tourName === tour.name, `${cert.landmarksCompleted}/${cert.totalLandmarks}, ${cert.totalScore} pts`)
      const clk = (await call('GET', '/api/game/clock', { token: captain })).body
      rec(`${T}: clock shows the tour complete and can no longer run out`, clk.tourComplete === true && clk.timeUp === false)
      rec(`${T}: no more play once complete (400)`, (await call('POST', '/api/game/clue/hint', { token: captain, body: { hintNumber: 1 } })).status === 400)
      rec(`${T}: the clock can't be stopped once complete (400)`, (await call('POST', '/api/game/clock/stop', { token: captain })).status === 400)
      const home = (await call('GET', '/api/game/home', { token: memberB })).body
      rec(`${T}: home lists every landmark`, home.landmarks.filter((l) => l.secondsTaken != null).length === cert.totalLandmarks && home.totalScore === expectedTotal)
      rec(`${T}: final score is within the maximum`, expectedTotal <= home.maxScore, `${expectedTotal}/${home.maxScore}`)
    })

    await rec.section(`${T}: emails`, async () => {
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
      rec(`${T}: certificate email to a bad address is refused (400)`, (await call('POST', '/api/game/certificate/send', { token: memberB, body: { email: 'not-an-email', imageDataUrl: png } })).status === 400)
      rec(`${T}: certificate email with no image is refused (400)`, (await call('POST', '/api/game/certificate/send', { token: memberB, body: { email: 'zz-fake-player@example.invalid' } })).status === 400)
      const sent = await call('POST', '/api/game/certificate/send', { token: memberB, body: { email: 'zz-fake-player@example.invalid', imageDataUrl: png } })
      rec(`${T}: certificate email is built and handed to the mail transport`, sent.status === 200 && sent.body.sent === true, `${sent.status} ${sent.body?.error || ''}`)
      rec(`${T}: an empty problem report is refused (400)`, (await call('POST', '/api/game/problem-report', { token: memberB, body: { message: '  ' } })).status === 400)
      const rep = await call('POST', '/api/game/problem-report', { token: memberB, body: { message: 'ZZ regression test report — please ignore' } })
      rec(`${T}: problem report is built and handed to the mail transport`, rep.status === 200 && rep.body.sent === true)
    })
  }

  async function clockStops(T, captain, member) {
    await rec.section(`${T}: clock stops`, async () => {
      const stop = await call('POST', '/api/game/clock/stop', { token: captain })
      rec(`${T}: captain stops the clock`, stop.status === 200 && stop.body.paused === true && stop.body.pausesUsed === 1)
      rec(`${T}: teammates see the clock stopped`, (await call('GET', '/api/game/clock', { token: member })).body.paused === true)
      rec(`${T}: stopping an already-stopped clock is refused (400)`, (await call('POST', '/api/game/clock/stop', { token: captain })).status === 400)
      const hint = await call('POST', '/api/game/clue/hint', { token: captain, body: { hintNumber: 1 } })
      rec(`${T}: no play while the clock is stopped (423)`, hint.status === 423 && hint.body.clockBlocked === true)
      const { rows: [m] } = await db.query('SELECT id FROM players WHERE session_token = $1', [member])
      rec(`${T}: captaincy can't change while the clock is stopped (423)`, (await call('POST', '/api/game/team/captain', { token: captain, body: { newCaptainId: m.id } })).status === 423)
      rec(`${T}: a member can't restart the clock (403)`, (await call('POST', '/api/game/clock/restart', { token: member })).status === 403)
      const before = stop.body.remainingSeconds
      await new Promise((r) => setTimeout(r, 2200))
      const restart = await call('POST', '/api/game/clock/restart', { token: captain })
      rec(`${T}: captain restarts the clock`, restart.status === 200 && restart.body.paused === false)
      rec(`${T}: time stood still while stopped`, Math.abs(restart.body.remainingSeconds - before) <= 1, `${before}s → ${restart.body.remainingSeconds}s`)
      rec(`${T}: restarting a running clock is refused (400)`, (await call('POST', '/api/game/clock/restart', { token: captain })).status === 400)
      const s2 = await call('POST', '/api/game/clock/stop', { token: captain })
      await call('POST', '/api/game/clock/restart', { token: captain })
      rec(`${T}: second stop allowed`, s2.status === 200 && s2.body.pausesUsed === 2)
      const s3 = await call('POST', '/api/game/clock/stop', { token: captain })
      rec(`${T}: a third stop is refused (only 2 per game)`, s3.status === 400 && /all your/i.test(s3.body?.error), s3.body?.error)
    })
  }

  async function narration(T, member, state) {
    let bonus = 0
    await rec.section(`${T}: narration bonus`, async () => {
      const done = state.landmarks.find((l) => l.seq < state.team.currentSequence && l.detail?.audioPath)
      if (!done) return rec.warn(`${T}: no completed landmark with narration to test the bonus on`)
      const before = (await call('GET', '/api/game/clock', { token: member })).body.totalScore
      const a = await call('POST', '/api/game/narration/complete', { token: member, body: { landmarkSequenceOrder: done.seq } })
      rec(`${T}: listening to a landmark's narration to the end earns +1 (any player)`, a.status === 200 && a.body.awarded === true && a.body.totalScore === before + 1)
      const b = await call('POST', '/api/game/narration/complete', { token: member, body: { landmarkSequenceOrder: done.seq } })
      rec(`${T}: the same narration only scores once per team`, b.body.awarded === false && b.body.totalScore === before + 1)
      bonus++
      const { rows: [site] } = await db.query('SELECT s.id FROM sites s JOIN tours t ON t.id = s.tour_id WHERE t.tour_code = $1 AND s.audio_path IS NOT NULL ORDER BY s.id LIMIT 1', [T])
      if (site) {
        const c = await call('POST', '/api/game/narration/complete', { token: member, body: { siteId: Number(site.id) } })
        rec(`${T}: a POI's narration earns +1 too`, c.body.awarded === true)
        bonus++
      }
      rec(`${T}: narration bonus needs a landmark or POI (400)`, (await call('POST', '/api/game/narration/complete', { token: member, body: {} })).status === 400)
      const latest = (await call('GET', '/api/game/narration/latest', { token: member })).body
      rec(`${T}: teammates are told who earned the bonus`, latest.playerName === 'ZZ Test Member B' && latest.totalScore === before + bonus)
    })
    return bonus
  }

  async function timeUpScenario(tour) {
    const T = tour.tour_code
    await rec.section(`${T}: time runs out`, async () => {
      const code = await createTestCode(db, { tourCode: T, maxPlayers: 3, label: 'TIME' })
      const c = (await register(code, 'ZZ Late Captain', 'captain')).body.sessionToken
      await call('POST', '/api/game/team/name', { token: c, body: { name: 'ZZ Slow Team' } })
      await call('POST', '/api/game/coach-complete', { token: c })
      await call('POST', '/api/dev/clock', { token: c, body: { action: 'minutes-left', minutes: 0 } })
      const clk = (await call('GET', '/api/game/clock', { token: c })).body
      rec(`${T}: clock reports time's up at 0 remaining`, clk.timeUp === true && clk.remainingSeconds === 0)
      const h = await call('POST', '/api/game/clue/hint', { token: c, body: { hintNumber: 1 } })
      rec(`${T}: no play once time is up (423)`, h.status === 423 && /time/i.test(h.body?.error), h.body?.error)
      const cert = (await call('GET', '/api/game/certificate', { token: c })).body
      rec(`${T}: a timed-out team still gets a certificate`, cert.timeUp === true && cert.tourComplete === false && cert.landmarksCompleted === 0 && Boolean(cert.completedAt))
      const late = await register(code, 'ZZ Latecomer', 'member')
      rec(`${T}: nobody can join a game whose time is up (400)`, late.status === 400 && /finished/i.test(late.body?.error), late.body?.error)
      const stop = await call('POST', '/api/game/clock/stop', { token: c })
      rec(`${T}: the clock can't be stopped once time is up (400)`, stop.status === 400)
    })
  }
}

// ---- standalone ----
if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const { localDb, deleteTestCodes } = await import('./lib/common.mjs')
  const stack = await import('./lib/stack.mjs')
  const db = await localDb()
  try {
    await stack.startApi()
    const results = await runApiPhase({ api: stack.API, db })
    const failed = results.filter((r) => !r.ok)
    console.log(`\n${results.length - failed.length}/${results.length} passed`)
    process.exitCode = failed.length ? 1 : 0
  } finally {
    await deleteTestCodes(db)
    await db.end()
    stack.stopAll()
  }
}
