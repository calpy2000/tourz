// Two-tone synthesised "ping" for an incoming team chat message — no audio asset to ship, and it
// stays in tune with the brass/forest identity better than a stock notification sound would.
let audioCtx = null

export function playChatPing() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    // Browsers suspend a fresh/backgrounded AudioContext until a user gesture unlocks it — by the
    // time a poll finds a new message the player has almost always already tapped something, so
    // this resume() is enough; if it isn't, the ping is just silently skipped for that message.
    if (audioCtx.state === 'suspended') audioCtx.resume()
    const now = audioCtx.currentTime
    ;[1318.5, 1760].forEach((freq, i) => {
      const osc = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const start = now + i * 0.07
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.16, start + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32)
      osc.connect(gain).connect(audioCtx.destination)
      osc.start(start)
      osc.stop(start + 0.34)
    })
  } catch {
    // Web Audio unavailable — the visual sweep still fires on its own
  }
}
