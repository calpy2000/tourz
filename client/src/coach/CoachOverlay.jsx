import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useCoach } from './CoachContext.jsx'

const MARGIN = 12
const DRAG_THRESHOLD = 20 // px — how far a pointer has to move to count as a "swipe", not a tap

function findTargetEls(coachId) {
  if (!coachId || coachId === '__anywhere__') return []
  return Array.from(document.querySelectorAll(`[data-coach-id="${coachId}"]`))
}

function rectsOverlap(a, b, margin = 0) {
  return !(a.right + margin <= b.left || a.left - margin >= b.right || a.bottom + margin <= b.top || a.top - margin >= b.bottom)
}

// Coach copy marks the element name it's referring to with **double asterisks** (e.g. "Tap on
// the **MAP view**.") so it renders bold and gold, same idea as the plain-text CSV content
// elsewhere in this app not being able to carry real JSX. Embedded newlines (multi-line CSV
// cells) are separate authored sentences, not just a wrap point — each becomes its own <p> (with
// the shared .coach-popup-text + .coach-popup-text CSS rule spacing them apart) so that spacing
// stays distinct from the tight line-height a single sentence gets when it word-wraps within one
// <p>. `trailing` (used for the help message's "tap where you see this ‹lozenge›") is appended
// to the last line rather than starting a new paragraph of its own.
function renderCoachText(text, trailing) {
  const lines = (text || '').replace(/\r\n?/g, '\n').split('\n')
  return lines.map((line, li) => (
    <p key={li} className="coach-popup-text">
      {line.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
        part.startsWith('**') && part.endsWith('**')
          ? <strong key={i} className="coach-highlight">{part.slice(2, -2)}</strong>
          : part,
      )}
      {li === lines.length - 1 ? trailing : null}
    </p>
  ))
}

// Renders the coach popup (defaults to screen-center, top locked per step so it only grows
// downward as attempts add lines) plus, once the player has gotten a step wrong twice, a glowing
// dashed-red lozenge around the real target element(s) and a matching inline lozenge in the
// popup. A step's target can match more than one real element at once (e.g. "tap any point of
// interest marker") — every match gets its own lozenge.
//
// Gating: for a `tap` step, a capture-phase click listener on `document` blocks any tap that
// isn't the current step's target — the real page keeps running underneath, only the wrong tap's
// effect is swallowed (preventDefault + stopPropagation) before it reaches the real onClick
// handlers. A correct tap is let through untouched so the real page does its real thing, then the
// step advances on the next tick once that's had a chance to happen. A non-`tap` step (currently
// just "expand and swipe" on the map) is NOT click-gated at all — blocking normal interaction
// would defeat the point of a step that's teaching free map exploration — instead it's satisfied
// by any real drag or wheel/pinch gesture on the target element.
export default function CoachOverlay() {
  const { active, currentStep, stepIndex, wrongAttempts, advance, registerWrongAttempt } = useCoach()
  const [targetRects, setTargetRects] = useState([])
  const popupRef = useRef(null)
  const [popupStyle, setPopupStyle] = useState({ visibility: 'hidden' })
  const lockedTopRef = useRef(null)
  const lockedStepRef = useRef(null)
  const anchorRef = useRef(null)
  const [disabledBlockerRect, setDisabledBlockerRect] = useState(null)

  useLayoutEffect(() => {
    if (!active || !currentStep) return
    function measure() {
      setTargetRects(findTargetEls(currentStep.coachId).map((el) => el.getBoundingClientRect()))
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    // Coach steps span real page transitions (view switches, popups opening) triggered by the
    // player's own taps, not by anything this component controls — a light poll catches the
    // target moving/appearing without needing a MutationObserver for a handful of steps.
    const id = setInterval(measure, 300)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
      clearInterval(id)
    }
  }, [active, currentStep])

  useLayoutEffect(() => {
    const card = popupRef.current
    if (!active || !currentStep || !card) return
    const cardHeight = card.offsetHeight
    const cardWidth = card.offsetWidth
    const viewportHeight = window.innerHeight
    const viewportWidth = window.innerWidth

    // Default position is always screen-center, not anchored to the target — and the top is
    // locked the moment a step first appears (before any wrong-attempt lines exist), so the
    // popup only grows downward as attempts add lines instead of re-centering (and visibly
    // jumping) on every new line. Keyed on stepIndex (not the CSV's own `step` text column,
    // which is blank on most rows) so it re-locks reliably on every step change.
    if (lockedStepRef.current !== stepIndex) {
      lockedStepRef.current = stepIndex
      lockedTopRef.current = Math.max(MARGIN, viewportHeight / 2 - cardHeight / 2)
      anchorRef.current = null
    }

    let left = viewportWidth / 2 - cardWidth / 2
    left = Math.max(MARGIN, Math.min(left, viewportWidth - cardWidth - MARGIN))

    let top = Math.min(lockedTopRef.current, viewportHeight - cardHeight - MARGIN)

    // Don't let the popup visually cover the real target — even though it's pointer-events:none
    // (so a tap still reaches the element underneath), an opaque popup sitting on top of it means
    // the player can't SEE what they're meant to tap. The first time a target rect is known for
    // this step, check whether the default centered position overlaps it; if so, pin the popup
    // above or below the target instead (decided once per step so it doesn't jump around as the
    // popup grows with extra attempt lines).
    if (targetRects.length > 0) {
      // Keep re-checking for overlap on every measurement until one is actually found and
      // committed to (mode 'above'/'below') — the target can still be settling into its final
      // position (e.g. the map panning to center on a marker) when it first appears, so a single
      // early "doesn't overlap yet" reading must not be treated as final.
      if (anchorRef.current === null || anchorRef.current.mode === 'none') {
        const defaultRect = { top, bottom: top + cardHeight, left, right: left + cardWidth }
        const overlapping = targetRects.filter((r) => rectsOverlap(defaultRect, r, MARGIN))
        if (overlapping.length > 0) {
          const union = overlapping.reduce(
            (acc, r) => ({ top: Math.min(acc.top, r.top), bottom: Math.max(acc.bottom, r.bottom) }),
            { top: Infinity, bottom: -Infinity },
          )
          const spaceBelow = viewportHeight - union.bottom - MARGIN
          const spaceAbove = union.top - MARGIN
          anchorRef.current = { mode: spaceBelow >= cardHeight || spaceBelow >= spaceAbove ? 'below' : 'above', top: union.top, bottom: union.bottom }
        } else {
          anchorRef.current = { mode: 'none' }
        }
      }
      if (anchorRef.current.mode === 'below') {
        top = Math.max(MARGIN, Math.min(anchorRef.current.bottom + MARGIN, viewportHeight - cardHeight - MARGIN))
      } else if (anchorRef.current.mode === 'above') {
        top = Math.max(MARGIN, Math.min(anchorRef.current.top - MARGIN - cardHeight, viewportHeight - cardHeight - MARGIN))
      }
    }

    setPopupStyle({ position: 'fixed', top, left, visibility: 'visible' })
  }, [active, currentStep, stepIndex, wrongAttempts, targetRects])

  useEffect(() => {
    if (!active || !currentStep || currentStep.interaction !== 'tap') return

    function onClick(e) {
      if (currentStep.coachId === '__anywhere__') { advance(); return }

      const hitTarget = e.target.closest(`[data-coach-id="${currentStep.coachId}"]`)
      if (hitTarget) {
        setTimeout(() => advance(), 60)
        return
      }

      e.preventDefault()
      e.stopPropagation()
      registerWrongAttempt()
    }

    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [active, currentStep, advance, registerWrongAttempt])

  // "type" steps (currently just the chat draft box): satisfied once the target input actually
  // has text in it, not by a tap. While active, any tap outside the input is blocked at
  // mousedown/touchstart — before the browser's default focus-shift happens — so the compose box
  // can't lose focus and collapse from a stray tap elsewhere on the page. The chat send button is
  // a deliberate exception: it's disabled while the draft is empty (so it never fires a real
  // click at all), but a tap on it here is still caught and treated as a wrong attempt, same as
  // a mis-tap on a `tap` step, so the player gets the "try again" escalation instead of the tap
  // just silently doing nothing.
  useEffect(() => {
    if (!active || !currentStep || currentStep.interaction !== 'type') return
    const els = findTargetEls(currentStep.coachId)
    if (els.length === 0) return

    function onInput(e) {
      if (e.target.value && e.target.value.trim().length > 0) advance()
    }
    els.forEach((el) => el.addEventListener('input', onInput))

    // mousedown/touchstart fire (and can be prevented) before the browser's default focus-shift
    // — that's what stops an outside tap from blurring the input. Click fires afterward as an
    // independent event, so it needs its own block too, or a tap on something like the Help
    // button would still open it even with the input never losing focus.
    function onDown(e) {
      if (els.some((el) => el.contains(e.target))) return
      e.preventDefault()
      e.stopPropagation()
      if (e.target.closest('[data-coach-id="chat-send-btn"]')) registerWrongAttempt()
    }
    function onClick(e) {
      if (els.some((el) => el.contains(e.target))) return
      e.preventDefault()
      e.stopPropagation()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('touchstart', onDown, { capture: true, passive: false })
    document.addEventListener('click', onClick, true)

    return () => {
      els.forEach((el) => el.removeEventListener('input', onInput))
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('touchstart', onDown, true)
      document.removeEventListener('click', onClick, true)
    }
  }, [active, currentStep, advance, registerWrongAttempt])

  // A `disabled` button never dispatches mousedown/click at all in Chrome (not even to
  // ancestors) — the browser drops the event entirely rather than just skipping the button's own
  // handler — so the "tap send while empty = wrong attempt" logic above can never see a tap that
  // actually lands on the real (disabled) send button. Fix: while on a `type` step, track that
  // button's rect and render an invisible, non-disabled, real-DOM-order-topmost overlay exactly
  // over it (below), tagged with the same data-coach-id — a tap there hits the overlay instead,
  // which DOES dispatch normal events the onDown/onClick handlers above can catch.
  useEffect(() => {
    if (!active || !currentStep || currentStep.interaction !== 'type') return
    function measure() {
      const el = document.querySelector('[data-coach-id="chat-send-btn"]')
      setDisabledBlockerRect(el ? el.getBoundingClientRect() : null)
    }
    measure()
    const id = setInterval(measure, 300)
    return () => { clearInterval(id); setDisabledBlockerRect(null) }
  }, [active, currentStep])

  // Non-tap, non-type steps: satisfied by any real gesture on the target — a drag past
  // DRAG_THRESHOLD, or any wheel/pinch-zoom event — rather than a specific tap. No wrong-attempt
  // tracking here since there's no meaningful "wrong" gesture to correct.
  useEffect(() => {
    if (!active || !currentStep || currentStep.interaction === 'tap' || currentStep.interaction === 'type') return
    const els = findTargetEls(currentStep.coachId)
    if (els.length === 0) return

    let dragStart = null
    function onPointerDown(e) { dragStart = { x: e.clientX, y: e.clientY } }
    function onPointerUp(e) {
      if (!dragStart) return
      const dx = e.clientX - dragStart.x
      const dy = e.clientY - dragStart.y
      dragStart = null
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) advance()
    }
    function onWheel() { advance() }

    els.forEach((el) => {
      el.addEventListener('pointerdown', onPointerDown)
      el.addEventListener('pointerup', onPointerUp)
      el.addEventListener('wheel', onWheel, { passive: true })
    })
    return () => {
      els.forEach((el) => {
        el.removeEventListener('pointerdown', onPointerDown)
        el.removeEventListener('pointerup', onPointerUp)
        el.removeEventListener('wheel', onWheel)
      })
    }
  }, [active, currentStep, advance])

  if (!active || !currentStep) return null

  const showError = wrongAttempts >= 1
  const showHelp = wrongAttempts >= 2

  return (
    <>
      {disabledBlockerRect && (
        <div
          data-coach-id="chat-send-btn"
          style={{
            position: 'fixed',
            top: disabledBlockerRect.top,
            left: disabledBlockerRect.left,
            width: disabledBlockerRect.width,
            height: disabledBlockerRect.height,
            zIndex: 9998,
          }}
        />
      )}
      {showHelp && targetRects.map((rect, i) => (
        <div
          key={i}
          className="coach-target-lozenge"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
          }}
        />
      ))}
      <div ref={popupRef} className="coach-popup" style={popupStyle}>
        <div className="coach-popup-header">
          <span className="coach-emoji" role="img" aria-label="Coach">🤓</span>
          <span className="coach-popup-label">Coach</span>
        </div>
        {/* Each attempt adds a line rather than replacing the last one, so the player never
            loses the original instruction while they're being corrected. */}
        {renderCoachText(currentStep.first_message)}
        {showError && currentStep.error_message && renderCoachText(currentStep.error_message)}
        {showHelp && currentStep.help_message &&
          renderCoachText(currentStep.help_message, <> tap where you see this <span className="coach-inline-lozenge" /></>)}
      </div>
    </>
  )
}
