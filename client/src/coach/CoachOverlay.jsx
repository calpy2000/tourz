import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useCoach } from './CoachContext.jsx'
import { API_BASE } from '../apiBase.js'

const MARGIN = 12
const DRAG_THRESHOLD = 20 // px — how far a pointer has to move to count as a "swipe", not a tap

// Echoes the real .map-pin-landmark marker — same photo, same size/forest ring (the start
// landmark is always pre-solved) — shown on its own line below step 1's last sentence. Hardcoded
// to the Port Louis start landmark's real photo, same tour-specific level as the rest of step 1's
// copy (it already names "Blue Penny Museum" directly).
function StartLandmarkMarkerVisual() {
  return (
    <span
      className="coach-marker-visual"
      style={{ backgroundImage: `url(${API_BASE}/content-photos/port-louis-blue-penny-museum.jpg)` }}
    />
  )
}

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
      {line.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
        if (!(part.startsWith('**') && part.endsWith('**'))) return part
        const inner = part.slice(2, -2)
        // The confirmation checkmark gets its own bold-yellow treatment, distinct from the
        // usual bold-brass highlight used for everything else (element names, etc.) — see
        // .coach-checkmark in index.css.
        return inner.trim() === '✓'
          ? <strong key={i} className="coach-checkmark">{inner}</strong>
          : <strong key={i} className="coach-highlight">{inner}</strong>
      })}
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
  // Tagged with the coachId it was measured for, not just a bare array — on the very first render
  // after a step change, this state still holds the PREVIOUS step's rects (its own effect hasn't
  // re-measured yet), and the positioning effect below runs in that same commit. Real bug this
  // caused: the overlap-avoidance decision locked itself in using the old step's (irrelevant,
  // already-hidden) target rects, picked a position that happened to clear THOSE, then froze there
  // — permanently overlapping the new step's real target with no way to recover, since the lock is
  // intentionally never revisited (see the effect below for why). Tagging with coachId lets the
  // positioning effect tell "stale" from "fresh" and simply wait one tick for the real thing.
  const [targetRects, setTargetRects] = useState({ coachId: null, rects: [] })
  const popupRef = useRef(null)
  const [popupStyle, setPopupStyle] = useState({ visibility: 'hidden' })
  const lockedTopRef = useRef(null)
  const lockedStepRef = useRef(null)
  const anchorRef = useRef(null)

  useLayoutEffect(() => {
    if (!active || !currentStep) return
    function measure() {
      setTargetRects({ coachId: currentStep.coachId, rects: findTargetEls(currentStep.coachId).map((el) => el.getBoundingClientRect()) })
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
    // Ignore a still-stale measurement (tagged with the PREVIOUS step's coachId — this state's own
    // effect hasn't re-measured for the new step yet in this same commit). Using it here would let
    // the lock below commit to a position that only clears a target that isn't even on screen
    // anymore; waiting one tick for the real rects costs nothing visible since the popup is at its
    // same centered default either way.
    const freshTargetRects = targetRects.coachId === currentStep.coachId ? targetRects.rects : []

    if (freshTargetRects.length > 0) {
      // Keep re-checking for overlap on every measurement until one is actually found and
      // committed to (mode 'above'/'below') — the target can still be settling into its final
      // position (e.g. the map panning to center on a marker) when it first appears, so a single
      // early "doesn't overlap yet" reading must not be treated as final.
      if (anchorRef.current === null || anchorRef.current.mode === 'none') {
        const defaultRect = { top, bottom: top + cardHeight, left, right: left + cardWidth }
        const overlapping = freshTargetRects.filter((r) => rectsOverlap(defaultRect, r, MARGIN))
        if (overlapping.length > 0) {
          const union = overlapping.reduce(
            (acc, r) => ({ top: Math.min(acc.top, r.top), bottom: Math.max(acc.bottom, r.bottom) }),
            { top: Infinity, bottom: -Infinity },
          )
          // A target spanning most of the viewport (e.g. "map navigation" steps, whose target is
          // the whole map panel) can't be meaningfully dodged above/below — there's no position
          // that both clears it and stays on-screen. Forcing a side anyway (as the fix below's
          // no-clamp behavior now allows) pushes the popup almost entirely off-screen instead of
          // just overlapping it — found via a real user report right after that fix shipped.
          // Falling back to the plain centered position for a target this large is the better
          // trade: still readable, even if it sits over part of a background-sized element.
          if (union.bottom - union.top > viewportHeight / 2) {
            anchorRef.current = { mode: 'none' }
          } else {
            const spaceBelow = viewportHeight - union.bottom - MARGIN
            const spaceAbove = union.top - MARGIN
            anchorRef.current = { mode: spaceBelow >= cardHeight || spaceBelow >= spaceAbove ? 'below' : 'above', top: union.top, bottom: union.bottom }
          }
        } else {
          anchorRef.current = { mode: 'none' }
        }
      }
      // Real bug, found via a user report/screenshot on a tall step-1 popup (4 lines of text plus
      // the marker image): clamping `top` back into "fits fully within the viewport" territory
      // silently defeated the whole point of this block whenever the popup was taller than the
      // room available on its chosen side — it pulled the popup back toward (and over) the exact
      // target it was supposed to avoid. Not clamping here can let the popup's far edge run past
      // the opposite side of the screen in a genuinely tight fit, but that's strictly better than
      // the one thing this block exists to prevent: covering the real target.
      if (anchorRef.current.mode === 'below') {
        top = Math.max(MARGIN, anchorRef.current.bottom + MARGIN)
      } else if (anchorRef.current.mode === 'above') {
        top = Math.min(anchorRef.current.top - MARGIN - cardHeight, viewportHeight - cardHeight - MARGIN)
      }
    }

    setPopupStyle({ position: 'fixed', top, left, visibility: 'visible' })
  }, [active, currentStep, stepIndex, wrongAttempts, targetRects])

  // Gating: for a `tap` step, capture-phase listeners on `document` block any tap that isn't the
  // current step's target — the real page keeps running underneath, only the wrong tap's effect
  // is swallowed (preventDefault + stopPropagation) before it reaches the real handlers. A
  // correct tap is let through untouched so the real page does its real thing, then the step
  // advances on the next tick once that's had a chance to happen.
  //
  // Map markers (`AdvancedMarker`) are a real bug here, not just a hypothetical: Google's marker
  // custom element registers its own `touchstart`/`mousedown`/`click` listeners directly on
  // itself (confirmed via Chrome's `getEventListeners(markerEl)`) and fires `onClick` off a
  // `gmp-click` custom event it dispatches from that internal handling — not from the `click`
  // event bubbling up through this page. So a wrong tap on a marker got the coach's "try again"
  // message (our `click` listener alone still saw and swallowed the bubbled click) while the
  // marker's real DetailPopup opened underneath anyway, since stopPropagation on `click` runs too
  // late — the marker's own `touchstart`/`mousedown` listener had already fired and already
  // dispatched `gmp-click` before our `click` listener ever got a turn (click fires last in the
  // mousedown → mouseup → click / touchstart → touchend → click sequence). Confirmed via a real
  // touch-simulated tap (CDP `Input.dispatchTouchEvent`, not a synthetic `.click()`) during the
  // "tap the landmark marker" step: tapping a POI marker opened its real detail popup while the
  // coach still showed "That's not quite right". Fix: gate on `mousedown`/`touchstart` too — both
  // fire before the marker's own listener gets a chance (capture phase on `document`, an
  // ancestor, always runs before any listener on the marker itself, a descendant) — so a wrong
  // tap is stopped before it can ever reach the marker. `wrongAtRef` just stops the same physical
  // tap's later `click` from counting as a second wrong attempt.
  //
  // Real-device follow-up: a real phone tap still got through to a wrong marker (user report,
  // 2026-10-08) even with the mousedown/touchstart gate above. Per the Pointer/Touch Events specs,
  // `pointerdown` actually fires *before* `touchstart` (and before `mousedown` too, for mouse/
  // trackpad input) — if the marker library listens on `pointerdown` rather than the legacy events
  // this file already gated, the exact same race reopens one event earlier. Headless CDP touch
  // simulation didn't reproduce this (its synthesized event order may not match a real touchscreen
  // exactly), so it couldn't be re-confirmed live the way the original bug was — gating
  // `pointerdown` too is the defensive fix, same reasoning as the mousedown/touchstart one above.
  //
  // Second real bug, found immediately after the fix above (user report, same day): one wrong tap
  // started showing BOTH the error and help text at once, instead of error-then-help across two
  // separate tries. Cause: `pointerdown` doesn't suppress the `mousedown`/`touchstart` that follow
  // it for the very same physical tap (pointerdown and mousedown are independent event streams for
  // mouse/trackpad input; preventDefault on pointerdown doesn't cancel touchstart either) — so one
  // tap now fired `onEarlyEvent` twice (pointerdown, then mousedown or touchstart), each call
  // incrementing `wrongAttempts`, jumping 0 straight to 2. Fixed with the same debounce `onClick`
  // already used for its own click-after-earlyevent case: only the first of a cluster of early
  // events within 500ms actually counts as a wrong attempt.
  useEffect(() => {
    if (!active || !currentStep || currentStep.interaction !== 'tap') return

    const wrongAtRef = { current: 0 }

    function isHit(e) {
      if (currentStep.coachId === '__anywhere__') return true
      return !!e.target.closest(`[data-coach-id="${currentStep.coachId}"]`)
    }

    function onEarlyEvent(e) {
      if (currentStep.coachId === '__anywhere__') return
      if (isHit(e)) return
      e.preventDefault()
      e.stopPropagation()
      const now = Date.now()
      if (now - wrongAtRef.current > 500) registerWrongAttempt()
      wrongAtRef.current = now
    }

    function onClick(e) {
      if (currentStep.coachId === '__anywhere__') { advance(); return }

      if (isHit(e)) {
        setTimeout(() => advance(), 60)
        return
      }

      e.preventDefault()
      e.stopPropagation()
      if (Date.now() - wrongAtRef.current > 500) registerWrongAttempt()
    }

    document.addEventListener('pointerdown', onEarlyEvent, true)
    document.addEventListener('mousedown', onEarlyEvent, true)
    document.addEventListener('touchstart', onEarlyEvent, { capture: true, passive: false })
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('pointerdown', onEarlyEvent, true)
      document.removeEventListener('mousedown', onEarlyEvent, true)
      document.removeEventListener('touchstart', onEarlyEvent, true)
      document.removeEventListener('click', onClick, true)
    }
  }, [active, currentStep, advance, registerWrongAttempt])

  // Non-tap steps (currently just "expand and swipe" on the map): satisfied by any real gesture
  // on the target — a drag past DRAG_THRESHOLD, or any wheel/pinch-zoom event — rather than a
  // specific tap. No wrong-attempt tracking here since there's no meaningful "wrong" gesture to
  // correct.
  useEffect(() => {
    if (!active || !currentStep || currentStep.interaction === 'tap') return
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

  // The map-navigation step is unblocked so real pan/zoom gestures work, but a tap on a landmark
  // or POI marker isn't a gesture — it opens a real DetailPopup, covering the map and stranding
  // the player mid-step (this happened for real: a POI tap while on this step left the "expand
  // the map" popup floating over an unrelated Harvey Nichols detail page). Swallow just those
  // marker taps here, same swallow-and-registerWrongAttempt treatment as a wrong tap-step guess.
  useEffect(() => {
    if (!active || !currentStep || currentStep.coachId !== 'map-navigation-area') return

    // Same pointerdown/touchstart/mousedown-fires-before-click issue as the general tap gate
    // above — gate on those too, or a marker tap here can still open its real DetailPopup
    // underneath (see the general gate's comment for the full explanation, including the
    // debounce below, which stops one physical tap's pointerdown+mousedown/touchstart pair from
    // double-counting as two wrong attempts).
    const wrongAtRef = { current: 0 }

    function isMarkerTap(e) {
      return !!e.target.closest('.map-pin-landmark, [data-coach-id="map-poi-marker"]')
    }

    function onEarlyEvent(e) {
      if (!isMarkerTap(e)) return
      e.preventDefault()
      e.stopPropagation()
      const now = Date.now()
      if (now - wrongAtRef.current > 500) registerWrongAttempt()
      wrongAtRef.current = now
    }

    function onClick(e) {
      if (!isMarkerTap(e)) return
      e.preventDefault()
      e.stopPropagation()
      if (Date.now() - wrongAtRef.current > 500) registerWrongAttempt()
    }

    document.addEventListener('pointerdown', onEarlyEvent, true)
    document.addEventListener('mousedown', onEarlyEvent, true)
    document.addEventListener('touchstart', onEarlyEvent, { capture: true, passive: false })
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('pointerdown', onEarlyEvent, true)
      document.removeEventListener('mousedown', onEarlyEvent, true)
      document.removeEventListener('touchstart', onEarlyEvent, true)
      document.removeEventListener('click', onClick, true)
    }
  }, [active, currentStep, registerWrongAttempt])

  if (!active || !currentStep) return null

  const showError = wrongAttempts >= 1
  const showHelp = wrongAttempts >= 2

  return (
    <>
      {showHelp && targetRects.coachId === currentStep.coachId && targetRects.rects.map((rect, i) => (
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
        {/* Step 1 (index 0) gets the start landmark's real marker image on its own line, right
            below the last sentence (which ends with a colon leading into it). */}
        {stepIndex === 0 && <div className="coach-marker-visual-row"><StartLandmarkMarkerVisual /></div>}
        {showError && currentStep.error_message && renderCoachText(currentStep.error_message)}
        {showHelp && currentStep.help_message &&
          renderCoachText(currentStep.help_message, <> tap where you see this <span className="coach-inline-lozenge" /></>)}
      </div>
    </>
  )
}
