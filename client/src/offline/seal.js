// Mirror of server/index.js's seededRandom + sealJson — must stay byte-for-byte identical.
// Obfuscation, not security: it only keeps upcoming landmarks' clues and answers out of plain sight
// in the network tab and storage (anything the phone can check with no signal is on the phone).

function seededRandom(seedStr) {
  let h = 2166136261
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  let state = h >>> 0
  return function rand() {
    state |= 0; state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function unsealJson(b64, keyStr) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  const rand = seededRandom(keyStr)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) ^ Math.floor(rand() * 256)
  return JSON.parse(new TextDecoder().decode(bytes))
}
