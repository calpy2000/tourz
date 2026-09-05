// Three-note ascending "marimba" ping for a teammate's screen updating because the captain used a
// hint, revealed the clue, attempted the puzzle, or submitted a quiz answer — distinct in timbre
// from the chat ping (chatPing.js) so the two are never confused by ear.
let audioCtx = null

export function playScreenUpdatePing() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    // Same suspended-context caveat as chatPing.js — by the time a poll picks up a captain action
    // the player has almost always already interacted with the page, so resume() is enough.
    if (audioCtx.state === 'suspended') audioCtx.resume()
    const now = audioCtx.currentTime
    ;[523.25, 659.25, 783.99].forEach((freq, i) => {
      const osc = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      osc.type = 'triangle'
      osc.frequency.value = freq
      const start = now + i * 0.085
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.2, start + 0.006)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22)
      osc.connect(gain).connect(audioCtx.destination)
      osc.start(start)
      osc.stop(start + 0.24)
    })
  } catch {
    // Web Audio unavailable — the screen still updates on its own, just silently
  }
}
