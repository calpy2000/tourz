// Replicated from the sibling "6 GAME HUB" project's shared/core/shell.js —
// same canvas-confetti library, same four randomized celebration variations, same
// random-pick-one approach. Bundled from npm (pinned 1.9.3, the version the CDN tag used) since
// 2026-10-18 instead of loaded from jsDelivr, so it's part of the app the service worker saves
// and celebrations still fire after reopening the app with no signal.
import confetti from 'canvas-confetti'

const CONFETTI_VARIATIONS = [
  // Two little "cannons" in the bottom corners, firing repeatedly toward the middle for ~2s.
  function cannons() {
    const endTime = Date.now() + 2000
    ;(function nextBurst() {
      confetti({ particleCount: 4, angle: 60, spread: 55, origin: { x: 0, y: 0.7 } })
      confetti({ particleCount: 4, angle: 120, spread: 55, origin: { x: 1, y: 0.7 } })
      if (Date.now() < endTime) requestAnimationFrame(nextBurst)
    })()
  },
  // Individual bursts popping from random spots on the screen over ~3s.
  function fireworks() {
    const endTime = Date.now() + 3000
    ;(function nextFirework() {
      confetti({
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
      confetti(Object.assign({}, defaults, { particleCount: 4, angle: 60, spread: 55, origin: { x: 0, y: 0.7 } }))
      confetti(Object.assign({}, defaults, { particleCount: 4, angle: 120, spread: 55, origin: { x: 1, y: 0.7 } }))
      if (Date.now() < endTime) requestAnimationFrame(nextBurst)
    })()
  },
  // A single burst using an emoji as the confetti shape.
  function emoji() {
    const shape = confetti.shapeFromText({ text: '🎉', scalar: 3 })
    confetti({ shapes: [shape], particleCount: 40, spread: 100, startVelocity: 35, origin: { y: 0.6 }, scalar: 3 })
  },
]

export function fireConfetti() {
  const variation = CONFETTI_VARIATIONS[Math.floor(Math.random() * CONFETTI_VARIATIONS.length)]
  variation()
}
