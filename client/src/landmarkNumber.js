// Landmark sequence_order 1 is always the starting landmark — pre-found, no gameplay. Every
// other landmark's user-facing number is offset by 1 so the first real (playable) landmark
// reads as "1", not "2" — used consistently across the Home tile grid, the landmark detail
// page, and the PlayPage header so the same landmark is never numbered differently in two places.
export function isStartLandmark(sequenceOrder) {
  return sequenceOrder === 1
}

export function landmarkDisplayNumber(sequenceOrder) {
  return sequenceOrder - 1
}
