// Short "marimba" pings (three triangle-wave notes) for things a teammate's device should notice
// without the player looking: the captain using a hint / revealing the clue / attempting the
// puzzle / submitting a quiz answer (rising), the captain stopping the clock (the same notes
// falling), restarting it (rising again), and the last-30-minutes time alerts (a two-note nudge).
let audioCtx = null

function playNotes(freqs) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    // Browsers suspend a fresh/backgrounded AudioContext until a user gesture unlocks it — by the
    // time a poll picks up a captain action
    // the player has almost always already interacted with the page, so resume() is enough.
    if (audioCtx.state === 'suspended') audioCtx.resume()
    const now = audioCtx.currentTime
    freqs.forEach((freq, i) => {
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

const C5 = 523.25
const E5 = 659.25
const G5 = 783.99

export function playScreenUpdatePing() {
  playNotes([C5, E5, G5])
}

export function playClockStoppedPing() {
  playNotes([G5, E5, C5])
}

export function playClockRestartedPing() {
  playNotes([C5, E5, G5])
}

export function playTimeAlertPing() {
  playNotes([G5, G5])
}
