import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { API_BASE } from '../apiBase.js'
import { useGameStore, enqueue, syncNow } from '../offline/gameStore.js'
import { currentView, homeView, landmarkDetailView } from '../offline/engine.js'
import { fireConfetti } from '../confetti.js'
import ResultPopup from '../components/ResultPopup.jsx'
import AnagramBoard from '../components/AnagramBoard.jsx'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import WhyPopup from '../components/WhyPopup.jsx'
import GameHeader from '../components/GameHeader.jsx'
import DetailPopup from '../components/DetailPopup.jsx'
import { playScreenUpdatePing } from '../screenUpdatePing.js'
import TourCompletePopup from '../components/TourCompletePopup.jsx'
import LoadingScreen from '../components/LoadingScreen.jsx'
import { rectFromEvent } from '../rect.js'
import { isStartLandmark, landmarkDisplayNumber } from '../landmarkNumber.js'
import { getSession } from '../localSession.js'
import { DEV_MODE } from '../devMode.js'
import { useWakeLock } from '../useWakeLock.js'

// Find & solve banner copy — re-amended 2026-08-24. A wrong answer is one flat outcome
// regardless of hints (0 points always), so it no longer needs a hints-aware message.
function puzzleBannerText({ points, hintsUsed, revealUsed, correct }) {
  if (!correct) return `Unlucky - you didn't prove you were there 🙁 no points`
  if (revealUsed) return `You revealed the answer but still proved you were there 🙂 ${points} point`
  if (hintsUsed === 0) return `Congratulations, you found it & proved it with no hints 🥳 ${points} points`
  if (hintsUsed === 1) return `Well done, you found it with 1 hint and proved it 🙂 ${points} points`
  return `Well done, you found it with 2 hints and proved it 🙂 ${points} points`
}

// Quiz completion banner copy — settled 2026-08-24, same tone pattern as the puzzle banner.
function quizBannerText({ correctCount, points }) {
  if (correctCount === 4) return `Congratulations, you got all 4 right 🥳 ${points} points`
  if (correctCount === 3) return `Well done, you got 3 out of 4 right 🙂 ${points} points`
  if (correctCount === 2) return `Nice - you got 2 out of 4 right 🙂 ${points} points`
  if (correctCount === 1) return `Nice - you got 1 out of 4 right 🙂 ${points} point`
  return `Unlucky - you didn't get any right 🙁 no points`
}

// Content-authored emphasis for plain-text fields (e.g. quiz_five_right.csv's `instructions`
// column) — `**word**` renders bold, same convention as markdown, without pulling in a markdown
// parser for what's otherwise ordinary player-facing copy.
function renderWithBold(text) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part))
}

// "5 right" completion banner copy — same tone as quizBannerText, but scored -4..+5 rather than
// bucketed by correctCount, so the tiers are by score instead.
function fiveRightBannerText(score) {
  if (score === 5) return `Congratulations, you got all 5 right 🥳 +5 points`
  if (score > 0) return `Well done, that's ${score} point${score === 1 ? '' : 's'} 🙂`
  if (score === 0) return `Even split — 0 points 🙂`
  return `Unlucky - that's ${score} point${Math.abs(score) === 1 ? '' : 's'} 🙁`
}

// Anagram completion banner copy — single question, flat pass/fail, same tone as the other banners.
function anagramBannerText(points) {
  if (points > 0) return `Correct! 🥳 ${points} points`
  return `Unlucky - not quite right 🙁 no points`
}

// Captures just the fields that change when the captain uses a hint, reveals the clue, attempts
// the puzzle, or submits a quiz answer — compared poll-to-poll so teammates get a ping for those
// specific actions without also pinging on an ordinary unchanged refresh.
function actionSignal(state) {
  if (!state || state.tourComplete) return null
  return {
    sequenceOrder: state.sequenceOrder,
    hints: state.clue.hintsRevealed.length,
    revealed: state.clue.revealed,
    solved: state.puzzle.solved,
    quizAnswered: state.quiz.questions.filter((q) => q.answered).length,
  }
}

// Bootstrap Icons' "house-fill" — same icon/markup as HomePage's view-switch, since this page
// carries the same switcher (just landed on its other tab).
function HouseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8.707 1.5a1 1 0 0 0-1.414 0L.646 8.146a.5.5 0 0 0 .708.708L8 2.207l6.646 6.647a.5.5 0 0 0 .708-.708L13 5.793V2.5a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5v1.293z" />
      <path d="m8 3.293 6 6V13.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5V9.293z" />
    </svg>
  )
}

// Everything on this page is built on the phone from the shared game state (offline/engine.js —
// same shape GET /api/game/current used to return), and every button is applied on the phone first
// and queued for the server (offline/gameStore.js), so the page works the same with no signal:
// right/wrong and points show instantly, and the server confirms when it next hears from the phone.
// Teammates' screens update from the same state, which the store keeps polling while there's
// signal — no per-page polling any more.
export default function PlayPage() {
  const navigate = useNavigate()
  const { state: game } = useGameStore()
  const isCaptain = game?.player.isCaptain ?? getSession()?.isCaptain ?? false
  const state = useMemo(() => (game ? currentView(game) : null), [game])
  const headerData = useMemo(() => (game ? homeView(game) : null), [game])
  const [actionError, setActionError] = useState('')
  const [answer, setAnswer] = useState('')
  const [showQuiz, setShowQuiz] = useState(false)
  const [selectedOptions, setSelectedOptions] = useState({})
  const [fiveRightPicks, setFiveRightPicks] = useState({}) // { [questionId]: Set<tileId> }
  const [hintConfirmAnchor, setHintConfirmAnchor] = useState(null)
  const [revealConfirmAnchor, setRevealConfirmAnchor] = useState(null)
  const [whyPopup, setWhyPopup] = useState(null) // { text, anchorRect } | null
  const [landmarkPopup, setLandmarkPopup] = useState(null)
  // Only the captain's device can take the hint/reveal/puzzle/quiz actions (server-gated), so on a
  // non-captain device any change here between state refreshes is by definition the captain's
  // doing, never our own action bouncing back.
  const prevSignalRef = useRef(null)
  const anagramBoardRef = useRef(null)

  const refresh = () => syncNow()

  function openLandmark(sequenceOrder) {
    const detail = game && landmarkDetailView(game, sequenceOrder)
    if (detail) setLandmarkPopup(detail)
  }

  // Applies one captain action (see enqueue). Returns the engine's result, or null after showing
  // why it was refused.
  function act(type, payload) {
    const res = enqueue(type, payload)
    if (res.error) {
      setActionError(res.error)
      return null
    }
    setActionError('')
    return res.result
  }

  useWakeLock()

  // Fires the screen-update ping on a teammate's device when a poll picks up one of the captain's
  // four gated actions. Skipped entirely on the captain's own device (they see the result of their
  // own tap immediately, no ping needed) and on the very first signal for a landmark (the baseline,
  // not a change) — same "prime before firing" shape as the captain-sync effect below.
  useEffect(() => {
    if (isCaptain) return
    const sig = actionSignal(state)
    const prev = prevSignalRef.current
    if (prev && sig && prev.sequenceOrder === sig.sequenceOrder) {
      const changed = sig.hints > prev.hints
        || (sig.revealed && !prev.revealed)
        || (sig.solved && !prev.solved)
        || sig.quizAnswered > prev.quizAnswered
      if (changed) playScreenUpdatePing()
    }
    prevSignalRef.current = sig
  }, [state, isCaptain])

  // (A captain handoff by a teammate reaches this phone through the game state — gameStore.js
  // keeps the cached session's isCaptain in step with it.)

  // Also runs on first load (sequenceOrder null -> N): arriving at a landmark whose puzzle is
  // already solved (e.g. back via the CURRENT landmark toggle) skips straight to the quiz instead
  // of re-showing the solved puzzle + its "Take the quiz" popup. Solving it while on this page
  // doesn't change sequenceOrder, so that still shows the popup as before.
  useEffect(() => {
    setShowQuiz(Boolean(state?.puzzle?.solved))
    setSelectedOptions({})
    setFiveRightPicks({})
    setWhyPopup(null)
    setHintConfirmAnchor(null)
    setRevealConfirmAnchor(null)
  }, [state?.sequenceOrder])

  if (!state || !headerData) return <LoadingScreen />

  if (state.tourComplete) {
    return (
      <div className="screen center">
        <p className="eyebrow">Tour complete</p>
        <h1>Nice walking.</h1>
        <p className="subtitle">Final score: {state.totalScore} points</p>
        {DEV_MODE && (
          <button className="ghost" onClick={async () => { try { await api.devReset() } catch { /* no signal */ } refresh() }}>
            Restart (dev)
          </button>
        )}
        <TourCompletePopup />
      </div>
    )
  }

  // The team has gone further than the landmarks this phone holds — only possible if the server
  // is sending a rolling window rather than the whole tour (see LOOKAHEAD_LANDMARKS there).
  if (state.waitingForContent) {
    return (
      <div className="home-shell">
        <div className="landmark-body">
          <section className="card waiting-content-card">
            <h2>Next clue on its way</h2>
            <p>Your next clue hasn&rsquo;t downloaded to this phone yet. It will appear here as soon as you&rsquo;re back in signal.</p>
          </section>
        </div>
        <GameHeader data={headerData} onReset={refresh} showHelp />
      </div>
    )
  }

  const { clue, puzzle, quiz, landmarkComplete } = state

  function handleHint() {
    setHintConfirmAnchor(null)
    act('hint', { hintNumber: clue.hintsRevealed.length + 1 })
  }

  function handleReveal() {
    setRevealConfirmAnchor(null)
    act('reveal')
  }

  function handlePuzzleSubmit(e) {
    e.preventDefault()
    const result = act('puzzle', { answer })
    if (!result) return
    setAnswer('')
    if (result.correct && result.hintsUsed === 0 && !result.revealUsed) fireConfetti()
  }

  function handleSelectOption(questionId, opt) {
    setSelectedOptions((prev) => ({ ...prev, [questionId]: opt }))
  }

  function handleQuizSubmit(questionId) {
    const opt = selectedOptions[questionId]
    if (!opt) return
    const result = act('quiz', { questionId, answer: opt })
    if (result?.quizComplete && result.correctCount === 4) fireConfetti()
  }

  function toggleFiveRightTile(questionId, tileId) {
    setFiveRightPicks((prev) => {
      const next = new Set(prev[questionId])
      if (next.has(tileId)) next.delete(tileId)
      else next.add(tileId)
      return { ...prev, [questionId]: next }
    })
  }

  function handleFiveRightSubmit(questionId) {
    const picked = Array.from(fiveRightPicks[questionId] || [])
    const result = act('quiz', { questionId, answer: picked })
    if (result?.quizComplete && result.score === 5) fireConfetti()
  }

  function handleAnagramSubmit(questionId) {
    const answerText = anagramBoardRef.current?.getAnswer()
    if (!answerText) return
    const result = act('quiz', { questionId, answer: answerText })
    if (result?.correct) fireConfetti()
  }

  function handleContinue() {
    act('advance')
  }

  // Same condition that decides which section renders below — the help popup needs to match
  // whichever one is actually on screen, not always describe the find/solve flow.
  const inQuizView = (showQuiz || landmarkComplete) && quiz.unlocked

  return (
    <div className="home-shell">
      <div className="landmark-body">
      <div className="view-switch">
        <button className="view-seg" onClick={() => navigate('/home')}><HouseIcon /><strong>MAP</strong> view</button>
        <button className="view-seg view-seg-active" onClick={() => navigate('/play')}><HouseIcon /><strong>CURRENT</strong> landmark</button>
      </div>
      {actionError && <p className="form-error" role="alert">{actionError}</p>}
      {(showQuiz || landmarkComplete) && quiz.unlocked ? (
        <section className={quiz.questions[0]?.type === 'five_right' ? 'five-right-section' : 'card'}>
          {quiz.questions[0]?.type === 'anagram' ? (
            <>
              <h2>{quiz.questions[0].title}</h2>
              <p>{quiz.questions[0].questionText}</p>
              {(() => {
                const q = quiz.questions[0]
                // A wrong answer keeps the tiles' normal colour — the slide reveal itself (and the
                // "Not quite" text below) already carries that signal, no need to also flip red.
                const resultClass = q.answered && q.wasCorrect ? 'result-correct' : null
                return (
                  <AnagramBoard
                    key={q.id}
                    ref={anagramBoardRef}
                    tiles={q.answered ? q.submittedTiles : q.tiles}
                    rowCounts={q.rowCounts}
                    locked={q.answered}
                    resultClass={resultClass}
                    revealAnswer={q.answered && !q.wasCorrect ? q.correctAnswer : undefined}
                  />
                )
              })()}
              {!quiz.questions[0].answered ? (
                isCaptain ? (
                  <button className="primary quiz-submit" onClick={() => handleAnagramSubmit(quiz.questions[0].id)}>
                    submit
                  </button>
                ) : (
                  <p className="captain-only-note">Only the captain can submit answers.</p>
                )
              ) : (
                <div className="quiz-result">
                  <p className={quiz.questions[0].wasCorrect ? 'feedback ok' : 'feedback bad'}>
                    {quiz.questions[0].wasCorrect ? 'Correct!' : `Not quite — it's ${quiz.questions[0].correctAnswer}`}
                  </p>
                  {quiz.questions[0].explanation && (
                    <button className="why-link" onClick={(e) => setWhyPopup({ text: quiz.questions[0].explanation, anchorRect: rectFromEvent(e) })}>
                      why?
                    </button>
                  )}
                </div>
              )}
              {landmarkComplete && (
                <ResultPopup
                  text={anagramBannerText(quiz.pointsEarned)}
                  buttonLabel="Head to next landmark"
                  onContinue={handleContinue}
                  disabled={!isCaptain}
                  disabledNote="Only your team captain can advance to the next landmark."
                />
              )}
            </>
          ) : quiz.questions[0]?.type === 'five_right' ? (
            <>
              <h2>{quiz.questions[0].title}</h2>
              {quiz.questions.map((q) => {
                const picks = fiveRightPicks[q.id] || new Set()
                return (
                  <div key={q.id} className="five-right-block">
                    <p>{renderWithBold(q.instructions)}</p>
                    <div className="five-right-grid">
                      {q.tiles.map((tile) => {
                        const picked = q.answered ? (q.pickedTileIds || []).includes(tile.id) : picks.has(tile.id)
                        return (
                          <button
                            key={tile.id}
                            type="button"
                            className={`five-right-tile${tile.imagePath ? '' : ' is-text-tile'}`}
                            disabled={q.answered}
                            onClick={() => toggleFiveRightTile(q.id, tile.id)}
                          >
                            {tile.imagePath ? (
                              <>
                                <img src={`${API_BASE}/content-photos/${tile.imagePath}`} alt={tile.name} />
                                <span className="five-right-tile-name">{tile.name}</span>
                              </>
                            ) : (
                              <span className="five-right-tile-text">{tile.name}</span>
                            )}
                            <span className="five-right-checkbox" aria-hidden="true">
                              {picked && <span className="five-right-checkbox-mark">&#10003;</span>}
                            </span>
                            {q.answered && (
                              <span
                                className={tile.correct ? 'five-right-correct-mark is-correct' : 'five-right-correct-mark is-wrong'}
                                aria-hidden="true"
                              >
                                {tile.correct ? '✓' : '✗'}
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                    {!q.answered ? (
                      <>
                        <p className="five-right-count">{picks.size} tile{picks.size === 1 ? '' : 's'} selected</p>
                        {isCaptain ? (
                          <button className="primary quiz-submit" onClick={() => handleFiveRightSubmit(q.id)}>
                            submit
                          </button>
                        ) : (
                          <p className="captain-only-note">Only the captain can submit answers.</p>
                        )}
                      </>
                    ) : (
                      <div className="quiz-result">
                        <p className={q.score > 0 ? 'feedback ok' : q.score < 0 ? 'feedback bad' : 'feedback'}>
                          {q.score > 0 ? `+${q.score}` : q.score} point{Math.abs(q.score) === 1 ? '' : 's'}
                        </p>
                      </div>
                    )}
                  </div>
                )
              })}
              {landmarkComplete && (
                <ResultPopup
                  text={fiveRightBannerText(quiz.pointsEarned)}
                  buttonLabel="Head to next landmark"
                  onContinue={handleContinue}
                  disabled={!isCaptain}
                  disabledNote="Only your team captain can advance to the next landmark."
                />
              )}
            </>
          ) : (
            <>
              <h2>What did you notice?</h2>
              {quiz.questions.map((q) => {
                const selected = selectedOptions[q.id]
                return (
                  <div key={q.id} className="quiz-question">
                    <p>{q.questionText}</p>
                    <div className="opt-row">
                      {q.options.map((opt) => {
                        let cls = 'quiz-opt'
                        if (q.answered) {
                          if (opt === q.correctAnswer) cls += ' quiz-opt-correct'
                          else if (opt === selected) cls += ' quiz-opt-wrong'
                        } else if (opt === selected) {
                          cls += ' quiz-opt-selected'
                        }
                        return (
                          <button key={opt} disabled={q.answered} className={cls} onClick={() => handleSelectOption(q.id, opt)}>
                            {opt}
                          </button>
                        )
                      })}
                    </div>
                    {!q.answered ? (
                      selected && (
                        isCaptain ? (
                          <button className="primary quiz-submit" onClick={() => handleQuizSubmit(q.id)}>
                            submit
                          </button>
                        ) : (
                          <p className="captain-only-note">Only the captain can submit answers.</p>
                        )
                      )
                    ) : (
                      <div className="quiz-result">
                        <p className={q.wasCorrect ? 'feedback ok' : 'feedback bad'}>
                          {q.wasCorrect ? 'Correct!' : `Not quite — it's ${q.correctAnswer}`}
                        </p>
                        {q.explanation && (
                          <button className="why-link" onClick={(e) => setWhyPopup({ text: q.explanation, anchorRect: rectFromEvent(e) })}>
                            why?
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
              {landmarkComplete && (
                <ResultPopup
                  text={quizBannerText({ correctCount: quiz.correctCount, points: quiz.pointsEarned })}
                  buttonLabel="Head to next landmark"
                  onContinue={handleContinue}
                  disabled={!isCaptain}
                  disabledNote="Only your team captain can advance to the next landmark."
                />
              )}
            </>
          )}
        </section>
      ) : (
        <>
          <section className="card">
            <h2>Find it clue</h2>
            <p>{clue.text}</p>

            {clue.hintsRevealed.map((hint, i) => (
              <p key={i} className="hint">
                Hint {i + 1}: {hint}
              </p>
            ))}

            {clue.reveal && (
              <p className="hint reveal">
                {clue.reveal.title} &mdash; {clue.reveal.address}
              </p>
            )}

            <div className="button-row">
              {clue.hintsRemaining > 0 && !clue.revealed && (
                <button className="primary" onClick={(e) => setHintConfirmAnchor(rectFromEvent(e))} disabled={!isCaptain}>Get a hint ({clue.hintsRemaining} left)</button>
              )}
              {!clue.revealed && (
                <button className="primary btn-reveal" onClick={(e) => setRevealConfirmAnchor(rectFromEvent(e))} disabled={!isCaptain}>
                  Reveal location
                </button>
              )}
            </div>
            {!isCaptain && !clue.revealed && <p className="captain-only-note">Only your team captain can request a hint or reveal the location.</p>}
          </section>

          {hintConfirmAnchor && (
            <ConfirmDialog
              title="Use a hint?"
              message="Using a hint means fewer Find It points when you find the landmark."
              cancelLabel="Cancel"
              confirmLabel="Use hint"
              confirmClassName="btn-hint"
              anchorRect={hintConfirmAnchor}
              onConfirm={handleHint}
              onCancel={() => setHintConfirmAnchor(null)}
            />
          )}

          {revealConfirmAnchor && (
            <ConfirmDialog
              title="Reveal the location?"
              message="Revealing the landmark means you get zero Find It points, but you can still earn 1 point if you can prove you were there."
              cancelLabel="Cancel"
              confirmLabel="Reveal anyway"
              confirmClassName="btn-reveal"
              anchorRect={revealConfirmAnchor}
              onConfirm={handleReveal}
              onCancel={() => setRevealConfirmAnchor(null)}
            />
          )}

          <section className="card">
            <h2>Prove it (that you were actually there)</h2>
            <p>{puzzle.questionText}</p>
            {!puzzle.solved ? (
              <>
                <form onSubmit={handlePuzzleSubmit} className="answer-form">
                  <input
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    placeholder="Your answer"
                  />
                  <button className="primary" type="submit" disabled={!isCaptain}>
                    submit
                  </button>
                </form>
                {!isCaptain && <p className="captain-only-note">Only your team captain can submit an answer.</p>}
              </>
            ) : (
              <>
                <div className="quiz-result">
                  <p className={puzzle.correct ? 'feedback ok' : 'feedback bad'}>
                    {puzzle.correct
                      ? `${puzzle.submittedAnswer} is Correct!`
                      : `${puzzle.submittedAnswer} is wrong - the answer is ${puzzle.correctAnswer}`}
                  </p>
                  {puzzle.explanation && (
                    <button className="why-link" onClick={(e) => setWhyPopup({ text: puzzle.explanation, anchorRect: rectFromEvent(e) })}>
                      why?
                    </button>
                  )}
                </div>
                <ResultPopup
                  title={state.title}
                  text={puzzleBannerText({
                    points: puzzle.pointsEarned,
                    hintsUsed: puzzle.hintsUsed,
                    revealUsed: puzzle.revealUsed,
                    correct: puzzle.correct,
                  })}
                  buttonLabel="Take the quiz"
                  onContinue={() => setShowQuiz(true)}
                  secondaryLabel="See landmark"
                  onSecondary={() => openLandmark(state.sequenceOrder)}
                />
              </>
            )}
          </section>
        </>
      )}
      </div>

      <GameHeader
        data={headerData}
        onReset={() => { refresh(); loadHeaderData() }}
        showHelp
        pageHelpText={
          inQuizView ? (
            <>
              <p>Answer a few quick questions about things you should have noticed along the way — points of interest, details on the route, that kind of thing.</p>
              <p>Only your team captain can submit an answer, and each question can only be answered once, so make sure of your choice before submitting.</p>
              <p>Once all questions are answered you'll move on to the next landmark.</p>
            </>
          ) : (
            <>
              <p><strong>Find it:</strong> work out where the clue is pointing you and head there. Only your team captain can ask for a hint or reveal the location — each hint lowers the points you can earn here, and revealing caps this landmark at 1 point.</p>
              <p><strong>Prove it:</strong> once you're confident, answer the question — only the captain can submit, and you only get one attempt.</p>
              <p>After solving, you'll take a short quiz on things you should have noticed on the way, then move on to the next landmark.</p>
            </>
          )
        }
      />

      {whyPopup && <WhyPopup text={whyPopup.text} anchorRect={whyPopup.anchorRect} onClose={() => setWhyPopup(null)} />}

      {landmarkPopup && (
        <DetailPopup
          eyebrow={isStartLandmark(landmarkPopup.sequenceOrder) ? 'Starting landmark' : `Landmark ${landmarkDisplayNumber(landmarkPopup.sequenceOrder)}`}
          title={landmarkPopup.title}
          address={landmarkPopup.address}
          imagePath={landmarkPopup.imagePath}
          audioPath={landmarkPopup.audioPath}
          sections={[
            { label: landmarkPopup.aboutLandmarkLabel, text: landmarkPopup.aboutLandmarkText },
            { label: landmarkPopup.aboutSubjectLabel, text: landmarkPopup.aboutSubjectText },
          ]}
          interestingFact={landmarkPopup.interestingFact}
          externalLink={landmarkPopup.externalLink}
          gpsRef={{ type: 'landmark', sequenceOrder: landmarkPopup.sequenceOrder }}
          onClose={() => setLandmarkPopup(null)}
        />
      )}
    </div>
  )
}
