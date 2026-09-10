import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

function getClientCoords(e) {
  if (e.touches && e.touches.length > 0) return { x: e.touches[0].clientX, y: e.touches[0].clientY }
  if (e.changedTouches && e.changedTouches.length > 0) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY }
  return { x: e.clientX, y: e.clientY }
}

// For a wrong answer, works out which cell-swaps get every cell holding its target letter, as a
// sequence of parallel-safe batches — ported from 6 GAME HUB's SLYDZ reveal engine
// (games/slydz/index.js's computeRevealPlan), simplified for a full-board reveal (every cell is a
// target here, not just a row) so there's no separate "already-settled" target set to protect.
function computeRevealPlan(current, target) {
  const working = current.slice()
  const n = working.length
  const batches = []
  let guard = 0
  while (working.some((letter, i) => letter !== target[i]) && guard++ < n) {
    const usedThisBatch = new Set()
    const batch = []
    for (let cell = 0; cell < n; cell++) {
      if (usedThisBatch.has(cell) || working[cell] === target[cell]) continue
      const need = target[cell]
      // Prefer a source cell that isn't already correct, so a finished cell is never disturbed
      // unless nothing else has the needed letter.
      let source = -1
      for (let c = 0; c < n; c++) {
        if (c === cell || usedThisBatch.has(c) || working[c] === target[c]) continue
        if (working[c] === need) { source = c; break }
      }
      if (source === -1) {
        for (let c = 0; c < n; c++) {
          if (c === cell || usedThisBatch.has(c)) continue
          if (working[c] === need) { source = c; break }
        }
      }
      if (source === -1) continue
      batch.push([cell, source])
      usedThisBatch.add(cell)
      usedThisBatch.add(source)
      ;[working[cell], working[source]] = [working[source], working[cell]]
    }
    batches.push(batch)
  }
  return batches
}

const REVEAL_SLIDE_MS = 550
const REVEAL_EASE = 'cubic-bezier(0.45, 0, 0.2, 1)' // slow start -> fast middle -> slow finish, same as SLYDZ's reveal

// Swaps textContent instantly, then uses a transform to make each tile LOOK like it hasn't moved
// yet, and animates that transform back to zero — so what the eye sees is the LETTER traveling
// between the two cells, even though neither DOM element ever changes which grid slot it belongs
// to. Standard FLIP technique, ported from SLYDZ's slideExchange(). These are raw DOM writes
// outside React's state — safe here because the driving `order` state doesn't change mid-animation
// (only the final setOrder below does), so React has nothing to reconcile away in between.
function slideExchange(elA, elB) {
  const rectA = elA.getBoundingClientRect()
  const rectB = elB.getBoundingClientRect()
  const dx = rectB.left - rectA.left
  const dy = rectB.top - rectA.top
  const letterA = elA.textContent
  const letterB = elB.textContent
  elA.textContent = letterB
  elB.textContent = letterA

  ;[[elA, dx, dy], [elB, -dx, -dy]].forEach(([el, tx, ty]) => {
    el.style.zIndex = '5'
    el.style.transition = 'none'
    el.style.transform = `translate(${tx}px, ${ty}px)`
  })

  requestAnimationFrame(() => requestAnimationFrame(() => {
    ;[elA, elB].forEach((el) => {
      el.style.transition = `transform ${REVEAL_SLIDE_MS}ms ${REVEAL_EASE}`
      el.style.transform = 'translate(0, 0)'
    })
  }))

  setTimeout(() => {
    ;[elA, elB].forEach((el) => {
      el.style.zIndex = ''
      el.style.transition = ''
      el.style.transform = ''
    })
  }, REVEAL_SLIDE_MS + 60)
}

// Drag-to-swap letter tiles for the "anagram" quiz format — ported from 6 GAME HUB's SLYDZ
// mechanic (shared/input/dom-tile-drag.js), unified mouse+touch, elementFromPoint() to find the
// drop target. Tile order lives in this component's own state (uncontrolled) and is only read by
// the parent at submit time via ref — same "don't touch it until submit" pattern PlayPage already
// uses for the other quiz formats' local selection state. Mount with a `key` tied to the question
// id so a new question always starts from a clean board rather than carrying over stale state.
//
// `revealAnswer`: once the player has answered wrong, PlayPage passes the correct solution string
// here and this plays a SLYDZ-style slide reveal — letters travel to their correct cells instead
// of just flipping the tiles red — same reveal engine as SLYDZ's "Reveal solution" assist.
const AnagramBoard = forwardRef(function AnagramBoard({ tiles, rowCounts, locked, resultClass, revealAnswer }, ref) {
  const [order, setOrder] = useState(tiles)
  const boardRef = useRef(null)
  const dragRef = useRef({ activeIndex: null, hoverIndex: null, startX: 0, startY: 0 })
  const hasRevealedRef = useRef(false)

  useImperativeHandle(ref, () => ({
    getAnswer: () => order.join(''),
  }), [order])

  function tileEls() {
    return Array.from(boardRef.current.querySelectorAll('.tile'))
  }

  function onDragStart(e) {
    if (locked) return
    const tileEl = e.target.closest('.tile')
    if (!tileEl || !boardRef.current.contains(tileEl)) return
    const index = Number(tileEl.dataset.index)
    const coords = getClientCoords(e)
    dragRef.current = { activeIndex: index, hoverIndex: null, startX: coords.x, startY: coords.y }
    tileEl.classList.add('is-dragging')
    Object.assign(tileEl.style, { zIndex: '100', transition: 'none', position: 'relative' })
    e.preventDefault()
  }

  function onDragMove(e) {
    const { activeIndex } = dragRef.current
    if (activeIndex === null) return
    e.preventDefault()
    const els = tileEls()
    const activeEl = els[activeIndex]
    const coords = getClientCoords(e)
    const dx = coords.x - dragRef.current.startX
    const dy = coords.y - dragRef.current.startY
    activeEl.style.transform = `translate(${dx}px, ${dy}px)`

    activeEl.style.visibility = 'hidden'
    const elUnderPoint = document.elementFromPoint(coords.x, coords.y)
    activeEl.style.visibility = 'visible'
    const candidate = elUnderPoint ? elUnderPoint.closest('.tile') : null
    const isValidHover = candidate && boardRef.current.contains(candidate) && Number(candidate.dataset.index) !== activeIndex

    const prevHoverIndex = dragRef.current.hoverIndex
    const candidateIndex = isValidHover ? Number(candidate.dataset.index) : null
    if (candidateIndex !== prevHoverIndex) {
      if (prevHoverIndex !== null) els[prevHoverIndex]?.classList.remove('drag-over')
      if (candidateIndex !== null) els[candidateIndex].classList.add('drag-over')
      dragRef.current.hoverIndex = candidateIndex
    }
  }

  function onDragEnd() {
    const { activeIndex, hoverIndex } = dragRef.current
    if (activeIndex === null) return
    const els = tileEls()
    const activeEl = els[activeIndex]
    if (hoverIndex !== null) els[hoverIndex]?.classList.remove('drag-over')

    // Reset the live-drag follow-the-finger transform so the tile snaps back to its grid slot.
    Object.assign(activeEl.style, { transform: 'none', zIndex: '', position: '' })
    activeEl.classList.remove('is-dragging')

    if (hoverIndex !== null) {
      // A manual drag-drop swap gets an instant letter swap plus a quick "pop" flash — same
      // feedback SLYDZ uses for its player-driven swaps (games/slydz/index.js's onSwap). The
      // sliding cross-cell slideExchange() animation is reserved for the auto-reveal-on-wrong-
      // answer sequence only; SLYDZ never uses it for a manual swap either. setOrder still fires
      // the real state update right away; this textContent write is a harmless duplicate of what
      // React will settle on a moment later (same pattern the reveal path already relies on).
      const hoverEl = els[hoverIndex]
      const letterA = activeEl.textContent
      const letterB = hoverEl.textContent
      activeEl.textContent = letterB
      hoverEl.textContent = letterA
      activeEl.classList.add('is-swapped')
      hoverEl.classList.add('is-swapped')
      setTimeout(() => {
        activeEl.classList.remove('is-swapped')
        hoverEl.classList.remove('is-swapped')
      }, 200)

      setOrder((prev) => {
        const next = [...prev]
        ;[next[activeIndex], next[hoverIndex]] = [next[hoverIndex], next[activeIndex]]
        return next
      })
    }

    dragRef.current = { activeIndex: null, hoverIndex: null, startX: 0, startY: 0 }
  }

  useEffect(() => {
    const board = boardRef.current
    if (!board) return
    board.addEventListener('mousedown', onDragStart)
    board.addEventListener('touchstart', onDragStart, { passive: false })
    document.addEventListener('mousemove', onDragMove)
    document.addEventListener('touchmove', onDragMove, { passive: false })
    document.addEventListener('mouseup', onDragEnd)
    document.addEventListener('touchend', onDragEnd)
    return () => {
      board.removeEventListener('mousedown', onDragStart)
      board.removeEventListener('touchstart', onDragStart)
      document.removeEventListener('mousemove', onDragMove)
      document.removeEventListener('touchmove', onDragMove)
      document.removeEventListener('mouseup', onDragEnd)
      document.removeEventListener('touchend', onDragEnd)
    }
  }, [locked])

  // Plays once, the first time a solution to reveal shows up (i.e. right after a wrong answer
  // comes back from the server) — guarded by a ref rather than depending on `order` so a poll
  // refresh landing mid-animation can't retrigger it.
  useEffect(() => {
    if (!revealAnswer || hasRevealedRef.current) return
    hasRevealedRef.current = true
    const target = revealAnswer.split('')
    const startDelay = setTimeout(() => {
      const batches = computeRevealPlan(order, target)
      let i = 0
      function playNext() {
        if (i >= batches.length) { setOrder(target); return }
        batches[i++].forEach(([a, b]) => slideExchange(tileElAt(a), tileElAt(b)))
        setTimeout(playNext, REVEAL_SLIDE_MS + 80)
      }
      playNext()
    }, 600) // a beat to let the player see their own wrong arrangement before it rearranges
    return () => clearTimeout(startDelay)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealAnswer])

  function tileElAt(index) {
    return boardRef.current.querySelector(`.tile[data-index="${index}"]`)
  }

  const row1Count = rowCounts[0]
  const row1 = order.slice(0, row1Count)
  const row2 = order.slice(row1Count)

  return (
    <div className="anagram-board" ref={boardRef}>
      {[row1, row2].map((row, rowIdx) => (
        <div className="tile-row" key={rowIdx}>
          {row.map((letter, i) => {
            const index = rowIdx === 0 ? i : row1Count + i
            return (
              <div
                key={index}
                className={`tile${locked ? ' is-locked' : ''}${resultClass ? ' ' + resultClass : ''}`}
                data-index={index}
              >
                {letter}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
})

export default AnagramBoard
