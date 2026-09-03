import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { fireConfetti } from '../confetti.js'
import ResultPopup from '../components/ResultPopup.jsx'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import WhyPopup from '../components/WhyPopup.jsx'
import DevTools from '../components/DevTools.jsx'
import DetailPopup from '../components/DetailPopup.jsx'
import ChatPanel from '../components/ChatPanel.jsx'
import { rectFromEvent } from '../rect.js'
import { isStartLandmark, landmarkDisplayNumber } from '../landmarkNumber.js'
import { getSession } from '../localSession.js'
import { DEV_MODE } from '../devMode.js'

// Find & solve banner copy — re-amended 2026-08-24. A wrong answer is one flat outcome
// regardless of hints (0 points always), so it no longer needs a hints-aware message.
function puzzleBannerText({ points, hintsUsed, revealUsed, correct }) {
  if (!correct) return `Unlucky - you didn't solve it 🙁 no points`
  if (revealUsed) return `You revealed the answer but solved it 🙂 ${points} point`
  if (hintsUsed === 0) return `Congratulations, you found it & solved it with no hints 🥳 ${points} points`
  if (hintsUsed === 1) return `Well done, you found it with 1 hint and solved it 🙂 ${points} points`
  return `Well done, you found it with 2 hints and solved it 🙂 ${points} points`
}

// Quiz completion banner copy — settled 2026-08-24, same tone pattern as the puzzle banner.
function quizBannerText({ correctCount, points }) {
  if (correctCount === 4) return `Congratulations, you got all 4 right 🥳 ${points} points`
  if (correctCount === 3) return `Well done, you got 3 out of 4 right 🙂 ${points} points`
  if (correctCount === 2) return `Nice - you got 2 out of 4 right 🙂 ${points} points`
  if (correctCount === 1) return `Nice - you got 1 out of 4 right 🙂 ${points} point`
  return `Unlucky - you didn't get any right 🙁 no points`
}


export default function PlayPage() {
  const navigate = useNavigate()
  const isCaptain = getSession()?.isCaptain ?? false
  const [state, setState] = useState(null)
  const [answer, setAnswer] = useState('')
  const [showQuiz, setShowQuiz] = useState(false)
  const [selectedOptions, setSelectedOptions] = useState({})
  const [hintConfirmAnchor, setHintConfirmAnchor] = useState(null)
  const [revealConfirmAnchor, setRevealConfirmAnchor] = useState(null)
  const [whyPopup, setWhyPopup] = useState(null) // { text, anchorRect } | null
  const [landmarkPopup, setLandmarkPopup] = useState(null)

  const refresh = () => api.getCurrent().then(setState)

  function openLandmark(sequenceOrder) {
    api.getLandmarkDetail(sequenceOrder).then((res) => { if (!res.error) setLandmarkPopup(res) })
  }

  useEffect(() => {
    refresh()
  }, [])

  // Team members don't trigger any of these mutations themselves (only the captain can), so
  // without polling their screen would just sit stale until they manually reload. Simple interval
  // poll rather than the Socket.io push wired up in the architecture plan — much less to build for
  // what's being asked right now, and fine at this game's scale. Runs for the captain's own device
  // too (harmless — same idempotent GET, and their own actions already refresh immediately anyway).
  useEffect(() => {
    const id = setInterval(refresh, 4000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    setShowQuiz(false)
    setSelectedOptions({})
    setWhyPopup(null)
    setHintConfirmAnchor(null)
    setRevealConfirmAnchor(null)
  }, [state?.sequenceOrder])

  if (!state) return <div className="screen center">Loading&hellip;</div>

  if (state.tourComplete) {
    return (
      <div className="screen center">
        <p className="eyebrow">Tour complete</p>
        <h1>Nice walking.</h1>
        <p className="subtitle">Final score: {state.totalScore} points</p>
        <button className="ghost" onClick={async () => { await api.devReset(); refresh() }}>
          Restart (dev)
        </button>
      </div>
    )
  }

  const { clue, puzzle, quiz, landmarkComplete } = state

  async function handleHint() {
    setHintConfirmAnchor(null)
    await api.requestHint()
    refresh()
  }

  async function handleReveal() {
    setRevealConfirmAnchor(null)
    await api.requestReveal()
    refresh()
  }

  async function handlePuzzleSubmit(e) {
    e.preventDefault()
    const result = await api.submitPuzzleAnswer(answer)
    setAnswer('')
    refresh()
    if (result.correct && result.hintsUsed === 0 && !result.revealUsed) fireConfetti()
  }

  function handleSelectOption(questionId, opt) {
    setSelectedOptions((prev) => ({ ...prev, [questionId]: opt }))
  }

  async function handleQuizSubmit(questionId) {
    const opt = selectedOptions[questionId]
    if (!opt) return
    const result = await api.submitQuizAnswer(questionId, opt)
    refresh()
    if (result.quizComplete && result.correctCount === 4) fireConfetti()
  }

  async function handleContinue() {
    await api.advance()
    refresh()
  }

  return (
    <div className="home-shell">
      <header className="landmark-header">
        <button className="ghost back-link" onClick={() => navigate('/home')}>&larr; back</button>
        <span className="landmark-header-title">
          Landmark {landmarkDisplayNumber(state.sequenceOrder)}:{' '}
          {state.title ? <span className="landmark-name">{state.title}</span> : <span className="landmark-unsolved">Unsolved</span>}
        </span>
        {DEV_MODE && <DevTools onReset={refresh} />}
      </header>

      <div className="landmark-body">
      {(showQuiz || landmarkComplete) && quiz.unlocked ? (
        <section className="card">
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
                    <>
                      <button className="primary quiz-submit" onClick={() => handleQuizSubmit(q.id)} disabled={!isCaptain}>
                        submit
                      </button>
                      {!isCaptain && <p className="captain-only-note">Only your team captain can submit an answer.</p>}
                    </>
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
        </section>
      ) : (
        <>
          <section className="card">
            <h2>Find it</h2>
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
              message="Using a hint means fewer points if you solve it — each hint used lowers your possible score for this landmark."
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
              message="Revealing means you'll only score 1 point on Solve it for this landmark, no matter what you answer."
              cancelLabel="Cancel"
              confirmLabel="Reveal anyway"
              confirmClassName="btn-reveal"
              anchorRect={revealConfirmAnchor}
              onConfirm={handleReveal}
              onCancel={() => setRevealConfirmAnchor(null)}
            />
          )}

          <section className="card">
            <h2>Solve it</h2>
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

      <ChatPanel />

      {whyPopup && <WhyPopup text={whyPopup.text} anchorRect={whyPopup.anchorRect} onClose={() => setWhyPopup(null)} />}

      {landmarkPopup && (
        <DetailPopup
          eyebrow={isStartLandmark(landmarkPopup.sequenceOrder) ? 'Starting landmark' : `Landmark ${landmarkDisplayNumber(landmarkPopup.sequenceOrder)}`}
          title={landmarkPopup.title}
          address={landmarkPopup.address}
          imagePath={landmarkPopup.imagePath}
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
