// Local store for GPS corrections captured via the POI popup's dev-only "Set GPS" button — see
// project memory for the workflow: captured on-device while walking the live tour, then handed
// off later via the dev-tools Export action as a downloadable .json the user pastes into chat.
// Same "Save now, Export later" split as tools/poi-field-review's own local-save pattern.
const KEY = 'tourz.gpsCorrections'

export function loadGpsCorrections() {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function saveGpsCorrection(entry) {
  const list = loadGpsCorrections()
  list.push(entry)
  localStorage.setItem(KEY, JSON.stringify(list))
}

export function clearGpsCorrections() {
  localStorage.removeItem(KEY)
}
