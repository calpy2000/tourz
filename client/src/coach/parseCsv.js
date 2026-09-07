// Minimal RFC4180 CSV parser for hand-authored content files (quoted fields, embedded commas,
// "" for a literal quote inside a quoted field). Returns an array of row objects keyed by the
// header row's column names.
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let i = 0

  const pushField = () => { row.push(field); field = '' }
  const pushRow = () => { pushField(); rows.push(row); row = [] }

  while (i < text.length) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i += 1; continue
      }
      field += c; i += 1; continue
    }
    if (c === '"') { inQuotes = true; i += 1; continue }
    if (c === ',') { pushField(); i += 1; continue }
    if (c === '\r') { i += 1; continue }
    if (c === '\n') { pushRow(); i += 1; continue }
    field += c; i += 1
  }
  if (field.length > 0 || row.length > 0) pushRow()

  const [header, ...body] = rows
  return body
    .filter((r) => r.length > 1 || r[0] !== '')
    .map((r) => Object.fromEntries(header.map((h, idx) => [h.trim(), (r[idx] ?? '').trim()])))
}
