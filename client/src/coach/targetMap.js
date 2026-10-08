// Maps each step's free-text (location, target) pair — exactly as written in coach-steps.csv —
// to the real data-coach-id used on the actual DOM element(s) for that step. Keeps the CSV
// human-readable (the user writes plain descriptions) while this file owns the technical
// wiring, per the agreed split of labor: "I'll do the precise selector/element-id mapping
// myself."
const key = (location, target) => `${(location || '').trim().toLowerCase()}::${(target || '').trim().toLowerCase()}`

const TARGET_MAP = {
  [key('map view', 'starting landmark')]: 'map-rbs-landmark-marker',
  [key('landmark pop up', 'back button')]: 'detail-popup-back-btn',
  [key('map view', 'map navigation')]: 'map-navigation-area',
  [key('map view', 'any poi marker marker')]: 'map-poi-marker',
  [key('poi pop up', 'back button')]: 'detail-popup-back-btn',
  [key('map view', 'help button')]: 'help-btn',
  [key('help panel', 'see instructions option')]: 'help-menu-show-instructions',
  [key('help see instructions', 'back button')]: 'help-instructions-back-btn',
  [key('map view', 'current landmark')]: 'home-current-landmark-btn',
  [key('find it solve it', 'end')]: '__anywhere__',
}

// Falls back to the raw target string itself (e.g. row 1, which was already authored with the
// real id "home-map-view-btn" directly) if no free-text mapping exists for this (location,
// target) pair.
export function resolveCoachId(step) {
  return TARGET_MAP[key(step.location, step.target)] || step.target
}
