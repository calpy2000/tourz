// The game, run on the phone. Pure functions over a "game state" (GET /api/game/state, with the
// sealed landmark packages unsealed — see gameStore.js), so the app plays identically with or
// without signal: every screen is built from this state, and every player action is applied here
// first (instant result, even in a dead spot) and queued to be replayed on the server by
// POST /api/game/sync, which stays the source of truth.
//
// MIRRORS server/index.js — puzzlePoints/quizPoints/normalize/ANAGRAM_POINTS, the act* functions,
// clockState, and the response shapes of /api/game/current, /home, /map, /landmark/:n and
// /certificate. A rule change there must be made here too. scripts/offline/engine-parity.mjs
// checks the view builders against the real endpoints.
//
// No browser or React imports, so the parity script can run this under Node.

export const ANAGRAM_POINTS = 5

export function puzzlePoints(hintsUsed, revealUsed, correct) {
  if (!correct) return 0
  if (revealUsed) return 1
  return Math.max(1, 5 - hintsUsed)
}

export function quizPoints(correctCount) {
  return { 4: 5, 3: 3, 2: 2, 1: 1, 0: 0 }[correctCount] ?? 0
}

export function normalize(text) {
  return String(text).trim().toLowerCase().replace(/\s+/g, ' ')
}

function puzzleIsCorrect(type, payload, answer) {
  if (type === 'exact_numeric') return String(answer).trim() === String(payload.answer).trim()
  if (type === 'fuzzy_text') return payload.accepted.some((a) => normalize(a) === normalize(answer))
  return false
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// ---- reading the state -----------------------------------------------------------------------

function eventsAt(state, seq) {
  return state.events.filter((e) => e.seq === seq)
}

function completedEvents(state) {
  return state.events.filter((e) => e.type === 'landmark_completed')
}

export function tourIsComplete(state) {
  const last = state.tour.lastPlayableSequence
  return last == null || state.team.currentSequence > last
}

// Same maths as the server's clockState, at server-time `now` (ms).
export function computeClock(state, now) {
  const c = state.clock
  const limitSeconds = c.limitSeconds
  const completed = completedEvents(state)
  const playableCount = state.tour.playableCount
  const completedCount = completed.length
  const allCompleted = playableCount > 0 && completedCount >= playableCount
  const completedAt = completed.length ? Math.max(...completed.map((e) => e.createdAt)) : null
  const base = { allCompleted, completedCount, playableCount, limitSeconds }
  if (!c.startedAt || c.startedAt > now) {
    return { ...base, started: false, paused: false, timeUp: false, elapsedSeconds: 0, remainingSeconds: limitSeconds }
  }
  const pausedAt = c.pausedAt && c.pausedAt <= now ? c.pausedAt : null
  const endPoint = allCompleted && completedAt && completedAt <= now ? completedAt : pausedAt ?? now
  const elapsed = Math.max(0, Math.floor((endPoint - c.startedAt) / 1000) - c.pausedSeconds)
  const remaining = Math.max(0, limitSeconds - elapsed)
  return {
    ...base,
    started: true,
    paused: Boolean(pausedAt),
    timeUp: !allCompleted && remaining <= 0,
    elapsedSeconds: Math.min(elapsed, limitSeconds),
    remainingSeconds: remaining,
  }
}

function clockBlockError(state, at) {
  const clock = computeClock(state, at)
  if (clock.allCompleted) return null
  if (!clock.started) return "The tour clock hasn't started yet — it starts when your captain finishes the app walkthrough."
  if (clock.timeUp) return "Time's up — your tour has ended."
  if (clock.paused) return 'The clock is stopped — your captain needs to restart it before you can carry on.'
  return null
}

// Shape of GET /api/game/clock.
export function clockView(state, now) {
  const clock = computeClock(state, now)
  return {
    gameId: state.clock.gameId,
    started: clock.started,
    paused: clock.paused,
    timeUp: clock.timeUp,
    tourComplete: clock.allCompleted,
    remainingSeconds: clock.remainingSeconds,
    limitSeconds: clock.limitSeconds,
    pausesUsed: state.clock.pausesUsed,
    maxStops: state.clock.maxStops,
    isCaptain: state.player.isCaptain,
    captainName: state.clock.captainName,
    coachComplete: state.player.coachComplete,
    landmarksCompleted: clock.completedCount,
    totalLandmarks: clock.playableCount,
    totalScore: state.team.totalScore,
  }
}

// Shape of GET /api/game/current, plus `waitingForContent` when the team has advanced past every
// landmark this phone holds (it carries the current one + state.lookahead more).
export function currentView(state) {
  const seq = state.team.currentSequence
  const base = { totalScore: state.team.totalScore, isCaptain: state.player.isCaptain }
  if (tourIsComplete(state)) return { tourComplete: true, ...base }
  const lm = state.landmarks[seq]
  if (!lm || !lm.clue) return { waitingForContent: true, sequenceOrder: seq, ...base }

  const events = eventsAt(state, seq)
  const hintsRevealed = events.filter((e) => e.type === 'clue_hint_used').map((e) => e.payload.hintText)
  const clueRevealed = events.find((e) => e.type === 'clue_reveal_used')
  const puzzleSolvedEvent = events.find((e) => e.type === 'puzzle_solved')
  const quizAnswered = events.filter((e) => e.type === 'quiz_answered')
  const quizCompletedEvent = events.find((e) => e.type === 'quiz_completed')

  const quizQuestions = !puzzleSolvedEvent ? [] : lm.quiz.map((q) => {
    const answered = quizAnswered.find((e) => Number(e.payload.questionId) === Number(q.id))
    if (q.type === 'five_right') {
      return {
        id: q.id,
        type: q.type,
        questionText: q.questionText,
        title: q.payload.title || null,
        instructions: q.payload.instructions || null,
        tiles: q.payload.tiles.map((t) => ({ id: t.id, name: t.name, imagePath: t.imagePath, correct: answered ? t.correct : null })),
        answered: Boolean(answered),
        pickedTileIds: answered ? answered.payload.picked : null,
        score: answered ? answered.payload.score : null,
        explanation: answered ? q.explanation : null,
      }
    }
    if (q.type === 'anagram') {
      return {
        id: q.id,
        type: q.type,
        questionText: q.questionText,
        title: q.payload.title || null,
        rowCounts: q.payload.rowCounts,
        tiles: answered ? null : q.payload.scrambled.split(''),
        submittedTiles: answered ? answered.payload.submitted.split('') : null,
        answered: Boolean(answered),
        wasCorrect: answered ? answered.payload.correct : null,
        correctAnswer: answered ? q.payload.solution : null,
        explanation: answered ? q.explanation : null,
      }
    }
    return {
      id: q.id,
      type: q.type,
      questionText: q.questionText,
      options: q.payload.options || null,
      answered: Boolean(answered),
      wasCorrect: answered ? answered.payload.correct : null,
      correctAnswer: answered ? q.payload.correct : null,
      explanation: answered ? q.explanation : null,
    }
  })

  const quizCompleted = quizQuestions.length > 0 && quizQuestions.every((q) => q.answered)
  return {
    sequenceOrder: seq,
    title: puzzleSolvedEvent ? lm.title : null,
    ...base,
    clue: {
      type: lm.clue.type,
      text: lm.clue.text,
      hintsRevealed,
      hintsRemaining: lm.hints.length - hintsRevealed.length,
      revealed: Boolean(clueRevealed),
      reveal: clueRevealed ? { title: lm.title, address: lm.address, latitude: lm.latitude, longitude: lm.longitude } : null,
    },
    puzzle: {
      questionText: lm.puzzle.question,
      solved: Boolean(puzzleSolvedEvent),
      correct: puzzleSolvedEvent ? puzzleSolvedEvent.payload?.correct : null,
      submittedAnswer: puzzleSolvedEvent ? puzzleSolvedEvent.payload?.answer : null,
      pointsEarned: puzzleSolvedEvent ? puzzleSolvedEvent.pointsDelta : null,
      hintsUsed: hintsRevealed.length,
      revealUsed: Boolean(clueRevealed),
      correctAnswer: puzzleSolvedEvent ? lm.puzzle.readable : null,
      explanation: puzzleSolvedEvent ? lm.puzzle.explanation : null,
    },
    quiz: {
      unlocked: Boolean(puzzleSolvedEvent),
      questions: quizQuestions,
      completed: quizCompleted,
      correctCount: quizCompleted ? quizQuestions.filter((q) => q.wasCorrect).length : null,
      pointsEarned: quizCompletedEvent ? quizCompletedEvent.pointsDelta : null,
    },
    landmarkComplete: Boolean(quizCompletedEvent),
  }
}

function currentRevealed(state) {
  const seq = state.team.currentSequence
  const lm = state.landmarks[seq]
  if (!lm || !lm.title) return null
  if (!eventsAt(state, seq).some((e) => e.type === 'puzzle_solved')) return null
  return lm
}

function solvedLandmarks(state) {
  return Object.values(state.landmarks)
    .filter((l) => l.seq < state.team.currentSequence)
    .sort((a, b) => a.seq - b.seq)
}

// Shape of GET /api/game/home.
export function homeView(state) {
  const solved = solvedLandmarks(state)
  const completed = completedEvents(state).slice().sort((a, b) => a.createdAt - b.createdAt)
  let previousTime = state.clock.startedAt || state.tour.activatedAt
  const landmarks = solved.map((l) => {
    const completedEvent = completed.find((e) => e.seq === l.seq)
    const completedAt = completedEvent ? completedEvent.createdAt : null
    const secondsTaken = completedAt ? Math.round((completedAt - previousTime) / 1000) : null
    if (completedAt) previousTime = completedAt
    return {
      sequenceOrder: l.seq,
      title: l.title,
      address: l.address,
      imagePath: l.tileImage,
      points: eventsAt(state, l.seq).reduce((sum, e) => sum + (e.pointsDelta || 0), 0),
      secondsTaken,
    }
  })
  const revealed = currentRevealed(state)
  return {
    teamName: state.team.name,
    tourName: state.tour.name,
    tourCode: state.tour.tourCode,
    foundCount: landmarks.length,
    totalLandmarks: state.tour.totalLandmarks,
    currentSequence: state.team.currentSequence,
    totalScore: state.team.totalScore,
    maxScore: state.tour.maxScore,
    timeLimitMinutes: state.tour.timeLimitMinutes,
    landmarks,
    currentRevealed: revealed && { sequenceOrder: revealed.seq, title: revealed.title, imagePath: revealed.tileImage },
  }
}

// GET /api/game/map's landmark half (sites come from the tour pack — see contentCache.js).
export function mapLandmarksView(state) {
  const pin = (l) => ({ sequenceOrder: l.seq, title: l.title, latitude: l.latitude, longitude: l.longitude, imagePath: l.tileImage })
  const revealed = currentRevealed(state)
  return {
    solvedLandmarks: solvedLandmarks(state).map(pin),
    currentRevealed: revealed ? pin(revealed) : null,
  }
}

// Shape of GET /api/game/landmark/:n — null where the server would 403 (not yet reached) or the
// phone simply doesn't hold it.
export function landmarkDetailView(state, sequenceOrder) {
  const seq = Number(sequenceOrder)
  const lm = state.landmarks[seq]
  if (!lm || !lm.title) return null
  const current = state.team.currentSequence
  if (seq >= current && !(seq === current && currentRevealed(state))) return null
  return {
    sequenceOrder: seq,
    isCurrent: seq === current,
    title: lm.title,
    address: lm.address,
    imagePath: lm.heroImage,
    ...lm.detail,
    audioBonusEarned: state.narration.some((n) => n.landmarkSeq === seq),
  }
}

// Shape of GET /api/game/certificate.
export function certificateView(state, now) {
  const complete = tourIsComplete(state)
  const clock = computeClock(state, now)
  if (!complete && !clock.timeUp) {
    return { tourComplete: false, timeUp: false, instructionsComplete: state.player.instructionsComplete, coachComplete: state.player.coachComplete }
  }
  const completed = completedEvents(state)
  const lastCompletedAt = completed.length ? Math.max(...completed.map((e) => e.createdAt)) : null
  const finishedAt = complete
    ? lastCompletedAt || now
    : state.clock.startedAt + (state.clock.pausedSeconds + clock.limitSeconds) * 1000
  return {
    tourComplete: complete,
    timeUp: !complete,
    playerName: state.player.name,
    teamName: state.team.name,
    tourName: state.tour.name,
    totalScore: state.team.totalScore,
    elapsedSeconds: clock.elapsedSeconds,
    landmarksCompleted: clock.completedCount,
    totalLandmarks: clock.playableCount,
    completedAt: new Date(finishedAt).toISOString(),
  }
}

// ---- applying actions ------------------------------------------------------------------------
// applyAction(state, action) -> { state, result } on success, { error } if the server would refuse
// it. `action.clientTime` (server-time ms) is the moment it's judged at, as on the server. Never
// mutates the state passed in.

function withEvent(state, seq, type, pointsDelta, payload, at, actionId) {
  return {
    ...state,
    events: [...state.events, { id: `local-${actionId}-${type}`, seq, type, pointsDelta: pointsDelta || 0, payload, createdAt: at, pending: true }],
  }
}

function addScore(state, points) {
  return points ? { ...state, team: { ...state.team, totalScore: state.team.totalScore + points } } : state
}

function captainGate(state, at) {
  if (!state.player.isCaptain) return { error: 'Only your team captain can do this.' }
  const clockError = clockBlockError(state, at)
  if (clockError) return { error: clockError, clockBlocked: true }
  if (tourIsComplete(state)) return { error: 'Your tour is already complete.' }
  const seq = state.team.currentSequence
  const lm = state.landmarks[seq]
  if (!lm || !lm.clue) return { error: "The next clue hasn't downloaded to this phone yet — it will as soon as you're back in signal." }
  return { seq, lm, events: eventsAt(state, seq) }
}

const ACTIONS = {
  hint(state, payload, at, id) {
    const g = captainGate(state, at)
    if (g.error) return g
    const used = g.events.filter((e) => e.type === 'clue_hint_used')
    const wanted = Number(payload.hintNumber) || used.length + 1
    if (wanted <= used.length) return { state, result: { hintText: used[wanted - 1].payload.hintText, duplicate: true } }
    if (wanted > used.length + 1) return { error: 'Hints must be used in order.' }
    const hintText = g.lm.hints[wanted - 1]
    if (hintText == null) return { error: 'No more hints available.' }
    return { state: withEvent(state, g.seq, 'clue_hint_used', 0, { hintText }, at, id), result: { hintText } }
  },

  reveal(state, payload, at, id) {
    const g = captainGate(state, at)
    if (g.error) return g
    const next = g.events.some((e) => e.type === 'clue_reveal_used') ? state : withEvent(state, g.seq, 'clue_reveal_used', 0, null, at, id)
    return { state: next, result: { title: g.lm.title, address: g.lm.address } }
  },

  puzzle(state, payload, at, id) {
    const g = captainGate(state, at)
    if (g.error) return g
    if (g.events.some((e) => e.type === 'puzzle_solved')) return { error: 'This puzzle has already been answered.' }
    const answer = payload.answer ?? ''
    const correct = puzzleIsCorrect(g.lm.puzzle.type, g.lm.puzzle.answer, answer)
    const hintsUsed = g.events.filter((e) => e.type === 'clue_hint_used').length
    const revealUsed = g.events.some((e) => e.type === 'clue_reveal_used')
    const pointsEarned = puzzlePoints(hintsUsed, revealUsed, correct)
    const next = addScore(withEvent(state, g.seq, 'puzzle_solved', pointsEarned, { correct, answer }, at, id), pointsEarned)
    return { state: next, result: { correct, correctAnswer: g.lm.puzzle.readable, pointsEarned, hintsUsed, revealUsed } }
  },

  quiz(state, payload, at, id) {
    const g = captainGate(state, at)
    if (g.error) return g
    if (!g.events.some((e) => e.type === 'puzzle_solved')) return { error: 'Answer the Prove it question first.' }
    const questionId = Number(payload.questionId)
    if (g.events.some((e) => e.type === 'quiz_answered' && Number(e.payload.questionId) === questionId)) {
      return { error: 'This question has already been answered.' }
    }
    const question = g.lm.quiz.find((q) => Number(q.id) === questionId)
    if (!question) return { error: "That question isn't part of your current landmark." }

    const answer = payload.answer
    let correct = null
    let fiveRightScore = null
    let next
    if (question.type === 'five_right') {
      const picked = Array.isArray(answer) ? answer.map(Number) : []
      fiveRightScore = question.payload.tiles.reduce((score, t) => (picked.includes(t.id) ? score + (t.correct ? 1 : -1) : score), 0)
      next = withEvent(state, g.seq, 'quiz_answered', 0, { questionId, picked, score: fiveRightScore }, at, id)
    } else if (question.type === 'anagram') {
      correct = normalize(question.payload.solution) === normalize(answer)
      next = withEvent(state, g.seq, 'quiz_answered', 0, { questionId, correct, submitted: answer }, at, id)
    } else {
      correct = normalize(question.payload.correct) === normalize(answer)
      next = withEvent(state, g.seq, 'quiz_answered', 0, { questionId, correct }, at, id)
    }

    // The package only carries the landmark's active quiz_format, so "every question in it" is
    // exactly the server's "every question of this type".
    const answered = eventsAt(next, g.seq).filter((e) => e.type === 'quiz_answered')
    const quizComplete = g.lm.quiz.every((q) => answered.some((e) => Number(e.payload.questionId) === Number(q.id)))
    let quizPointsEarned = null
    let correctCount = null
    if (quizComplete) {
      quizPointsEarned = question.type === 'five_right'
        ? fiveRightScore
        : question.type === 'anagram'
          ? (correct ? ANAGRAM_POINTS : 0)
          : quizPoints((correctCount = answered.filter((e) => e.payload.correct).length))
      next = withEvent(next, g.seq, 'quiz_completed', quizPointsEarned, null, at, id)
      next = withEvent(next, g.seq, 'landmark_completed', 0, null, at, id)
      next = addScore(next, quizPointsEarned)
    }
    return { state: next, result: { type: question.type, correct, score: fiveRightScore, quizComplete, correctCount, quizPointsEarned } }
  },

  advance(state, payload, at) {
    const g = captainGate(state, at)
    if (g.error) return g
    if (!g.events.some((e) => e.type === 'landmark_completed')) return { error: 'This landmark is not complete yet.' }
    return { state: { ...state, team: { ...state.team, currentSequence: state.team.currentSequence + 1 } }, result: { advanced: true } }
  },

  clock_stop(state, payload, at) {
    if (!state.player.isCaptain) return { error: 'Only your team captain can do this.' }
    const clock = computeClock(state, at)
    if (!clock.started || clock.timeUp || clock.allCompleted) return { error: "The clock isn't running." }
    if (clock.paused) return { error: 'The clock is already stopped.' }
    if (state.clock.pausesUsed >= state.clock.maxStops) return { error: "You've used all your clock stops." }
    return { state: { ...state, clock: { ...state.clock, pausedAt: at, pausesUsed: state.clock.pausesUsed + 1 } }, result: { ok: true } }
  },

  clock_restart(state, payload, at) {
    if (!state.player.isCaptain) return { error: 'Only your team captain can do this.' }
    if (!state.clock.pausedAt) return { error: "The clock isn't stopped." }
    const extra = Math.max(0, Math.floor((at - state.clock.pausedAt) / 1000))
    return { state: { ...state, clock: { ...state.clock, pausedAt: null, pausedSeconds: state.clock.pausedSeconds + extra } }, result: { ok: true } }
  },

  // Any team member. Not an error when the clock isn't running — the listen just doesn't score.
  narration(state, payload, at, id) {
    const clock = computeClock(state, at)
    if (!clock.started || clock.paused || clock.timeUp) return { state, result: { awarded: false } }
    const landmarkSeq = payload.landmarkSequenceOrder != null ? Number(payload.landmarkSequenceOrder) : null
    const siteId = payload.siteId != null ? Number(payload.siteId) : null
    if (landmarkSeq == null && siteId == null) return { error: 'landmarkSequenceOrder or siteId required.' }
    const already = state.narration.some((n) => (landmarkSeq != null ? n.landmarkSeq === landmarkSeq : n.siteId === siteId))
    if (already) return { state, result: { awarded: false } }
    const next = {
      ...state,
      narration: [...state.narration, { id: `local-${id}`, landmarkSeq, siteId, playerName: state.player.name, pending: true }],
    }
    return { state: addScore(next, 1), result: { awarded: true } }
  },

  coach_complete(state, payload, at) {
    let next = { ...state, player: { ...state.player, coachComplete: true } }
    if (state.player.isCaptain && !state.clock.startedAt) next = { ...next, clock: { ...next.clock, startedAt: at } }
    return { state: next, result: { ok: true } }
  },

  instructions_complete(state) {
    return { state: { ...state, player: { ...state.player, instructionsComplete: true } }, result: { ok: true } }
  },

  problem_report(state, payload) {
    if (!String(payload.message || '').trim()) return { error: 'Enter a description of the problem.' }
    return { state, result: { queued: true } }
  },

  certificate_send(state, payload) {
    if (!payload.email || !EMAIL_RE.test(String(payload.email).trim())) return { error: 'Enter a valid email address.' }
    if (typeof payload.imageDataUrl !== 'string' || !payload.imageDataUrl.startsWith('data:image/png;base64,')) {
      return { error: 'Missing certificate image.' }
    }
    return { state, result: { queued: true } }
  },
}

export const ACTION_TYPES = Object.keys(ACTIONS)

export function applyAction(state, action) {
  const fn = ACTIONS[action.type]
  if (!fn) return { error: 'Unknown action.' }
  return fn(state, action.payload || {}, action.clientTime, action.id)
}
