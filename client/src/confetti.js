// Replicated from the sibling "6 GAME HUB" project's shared/core/shell.js —
// same canvas-confetti library (loaded via CDN in index.html), same four
// randomized celebration variations, same random-pick-one approach.

const CONFETTI_VARIATIONS = [
  // Two little "cannons" in the bottom corners, firing repeatedly toward the middle for ~2s.
  function cannons() {
    const endTime = Date.now() + 2000
    ;(function nextBurst() {
      window.confetti({ particleCount: 4, angle: 60, spread: 55, origin: { x: 0, y: 0.7 } })
      window.confetti({ particleCount: 4, angle: 120, spread: 55, origin: { x: 1, y: 0.7 } })
      if (Date.now() < endTime) requestAnimationFrame(nextBurst)
    })()
  },
  // Individual bursts popping from random spots on the screen over ~3s.
  function fireworks() {
    const endTime = Date.now() + 3000
    ;(function nextFirework() {
      window.confetti({
        particleCount: 90,
        spread: 360,
        startVelocity: 30,
        origin: { x: Math.random(), y: Math.random() * 0.5 },
      })
      if (Date.now() < endTime) setTimeout(nextFirework, 400 + Math.random() * 300)
    })()
  },
  // Same cannon shape as the first variation, but star-shaped particles.
  function stars() {
    const endTime = Date.now() + 2000
    const defaults = { shapes: ['star'], colors: ['#FFD700', '#FFA500', '#FF6347', '#EEE8AA'] }
    ;(function nextBurst() {
      window.confetti(Object.assign({}, defaults, { particleCount: 4, angle: 60, spread: 55, origin: { x: 0, y: 0.7 } }))
      window.confetti(Object.assign({}, defaults, { particleCount: 4, angle: 120, spread: 55, origin: { x: 1, y: 0.7 } }))
      if (Date.now() < endTime) requestAnimationFrame(nextBurst)
    })()
  },
  // A single burst using an emoji as the confetti shape.
  function emoji() {
    const shape = window.confetti.shapeFromText({ text: '🎉', scalar: 3 })
    window.confetti({ shapes: [shape], particleCount: 40, spread: 100, startVelocity: 35, origin: { y: 0.6 }, scalar: 3 })
  },
]

export function fireConfetti() {
  if (typeof window.confetti !== 'function') return // CDN script didn't load — fail silently, not a big deal
  const variation = CONFETTI_VARIATIONS[Math.floor(Math.random() * CONFETTI_VARIATIONS.length)]
  variation()
}
