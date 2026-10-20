// Matches every landmark + site of one tour to the same feature in OpenStreetMap, for the dev-only
// "OSM review colours" mode (client/src/map/osmReview.js). Read-only on the database. Writes:
//   db/content/<tour>-tour/gps-reference/<tour>-osm-match-report-<date>.csv — one row per pin
//   client/src/map/osmReview.<tour>.json — pin colours + OSM positions for the app (landmarks as
//                                          offsets only, never coordinates)
// Then add the tour to LOADERS in osmReview.js. Match evidence, strongest first: same Wikipedia
// article, same name, name contained, street address; each with a distance cap. When it can't be
// sure, the pin is "not found" (blue) rather than guessed.
//
//   node scripts/maps/osm-match.mjs port-louis            # OSM data cached in scripts/maps/.cache/
//   node scripts/maps/osm-match.mjs port-louis --refresh  # re-download the OSM data
//   options: --margin-m=300 (OSM area around the pins)
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const args = process.argv.slice(2)
const opt = (name, dflt) => (args.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || dflt
const tourCode = args.find((a) => !a.startsWith('--'))
if (!tourCode) { console.error('Usage: node scripts/maps/osm-match.mjs <tour_code> [--refresh] [--margin-m=300]'); process.exit(1) }
const marginM = Number(opt('margin-m', 300))

// ---------- inputs: the tour's pins (local DB) + OSM features around them (Overpass) ----------
const { localPool } = require(path.join(root, 'scripts/db-sync/connections.js'))
const pool = localPool()
let sites, landmarks
try {
  const tour = (await pool.query('SELECT id FROM tours WHERE tour_code = $1', [tourCode])).rows[0]
  if (!tour) throw new Error(`No tour "${tourCode}" in the local DB`)
  landmarks = (await pool.query('SELECT id, sequence_order seq, title, address, latitude lat, longitude lng, external_link FROM landmarks WHERE tour_id = $1 ORDER BY sequence_order', [tour.id])).rows
  sites = (await pool.query('SELECT id, title, address, type, latitude lat, longitude lng, external_link FROM sites WHERE tour_id = $1 ORDER BY id', [tour.id])).rows
} finally {
  await pool.end()
}
for (const p of [...landmarks, ...sites]) { p.id = String(p.id); p.lat = Number(p.lat); p.lng = Number(p.lng) }
const linkOf = new Map([...sites.map((x) => ['s' + x.id, x.external_link]), ...landmarks.map((x) => ['l' + x.id, x.external_link])])

const all = [...landmarks, ...sites]
const dLat = marginM / 111320, dLng = marginM / (111320 * Math.cos((all[0].lat * Math.PI) / 180))
const bbox = [Math.min(...all.map((p) => p.lat)) - dLat, Math.min(...all.map((p) => p.lng)) - dLng, Math.max(...all.map((p) => p.lat)) + dLat, Math.max(...all.map((p) => p.lng)) + dLng].map((v) => v.toFixed(5)).join(',')
const cacheFile = path.join(here, '.cache', `osm-match-${tourCode}.json`)
if (args.includes('--refresh') || !fs.existsSync(cacheFile)) {
  const q = `[out:json][timeout:240];(nwr["name"](${bbox});nwr["wikipedia"](${bbox});nwr["wikidata"](${bbox});nwr["addr:housenumber"](${bbox});nwr["historic"](${bbox});nwr["tourism"="artwork"](${bbox}););out geom;`
  console.log(`Downloading OSM features in ${bbox} …`)
  const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'User-Agent': 'tourz-osm-match', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) })
  if (!res.ok) throw new Error(`Overpass ${res.status}: ${(await res.text()).slice(0, 300)}`)
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
  fs.writeFileSync(cacheFile, await res.text())
}
const osm = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).elements
console.log(`${landmarks.length} landmarks, ${sites.length} sites, ${osm.length} OSM features`)

// ---------- geometry (local metres) ----------
const R = 6371008.8
const toXY = (lat, lng, lat0) => [((lng * Math.PI) / 180) * R * Math.cos((lat0 * Math.PI) / 180), ((lat * Math.PI) / 180) * R]
const fromXY = (x, y, lat0) => [((y / R) * 180) / Math.PI, ((x / (R * Math.cos((lat0 * Math.PI) / 180))) * 180) / Math.PI]
function hav(a, b) {
  const r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
function bearing(a, b) {
  const r = Math.PI / 180, y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r)
  const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r)
  return (Math.atan2(y, x) / r + 360) % 360
}
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
const compass = (d) => COMPASS[Math.round(d / 22.5) % 16]

// Each OSM element -> { kind: 'point'|'line'|'area', rings/lines in lat/lng }
function shapeOf(e) {
  if (e.type === 'node') return { kind: 'point', pt: [e.lat, e.lon] }
  if (e.type === 'way' && e.geometry) {
    const g = e.geometry.map((p) => [p.lat, p.lon])
    const closed = g.length > 3 && g[0][0] === g.at(-1)[0] && g[0][1] === g.at(-1)[1]
    const t = e.tags || {}
    const area = closed && !(t.highway && t.area !== 'yes') && !t.barrier
    return { kind: area ? 'area' : 'line', rings: [g] }
  }
  if (e.type === 'relation' && e.members) {
    const join = (parts) => {
      const segs = parts.map((g) => g.slice()), out = []
      const same = (a, b) => a[0] === b[0] && a[1] === b[1]
      while (segs.length) {
        let ring = segs.shift(), grew = true
        while (!same(ring[0], ring.at(-1)) && grew) {
          grew = false
          for (let i = 0; i < segs.length; i++) {
            const g = segs[i]
            if (same(ring.at(-1), g[0])) ring = ring.concat(g.slice(1))
            else if (same(ring.at(-1), g.at(-1))) ring = ring.concat(g.slice(0, -1).reverse())
            else continue
            segs.splice(i, 1); grew = true; break
          }
        }
        out.push(ring)
      }
      return out
    }
    const rings = join(e.members.filter((m) => m.type === 'way' && m.geometry && m.role !== 'inner').map((m) => m.geometry.map((p) => [p.lat, p.lon])))
    const inner = join(e.members.filter((m) => m.type === 'way' && m.geometry && m.role === 'inner').map((m) => m.geometry.map((p) => [p.lat, p.lon])))
    if (!rings.length) return null
    const isArea = (e.tags || {}).type === 'multipolygon' || (e.tags || {}).building
    return { kind: isArea ? 'area' : 'line', rings, inner }
  }
  return null
}
function inRing(pt, ring) {
  let c = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j]
    if (yi > pt[0] !== yj > pt[0] && pt[1] < ((xj - xi) * (pt[0] - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}
// Nearest point of a shape to pt; for areas, pt itself if inside, else a point 1.5 m inside the edge.
function nearest(shape, pt) {
  if (shape.kind === 'point') return { pt: shape.pt, inside: false }
  if (shape.kind === 'area' && shape.rings.some((r) => inRing(pt, r)) && !(shape.inner || []).some((r) => inRing(pt, r))) return { pt, inside: true }
  const lat0 = pt[0], P = toXY(pt[0], pt[1], lat0)
  let best = null
  for (const ring of [...shape.rings, ...(shape.inner || [])]) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const A = toXY(ring[i][0], ring[i][1], lat0), B = toXY(ring[i + 1][0], ring[i + 1][1], lat0)
      const dx = B[0] - A[0], dy = B[1] - A[1], L = dx * dx + dy * dy
      const t = L ? Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L)) : 0
      const Q = [A[0] + t * dx, A[1] + t * dy], d = Math.hypot(Q[0] - P[0], Q[1] - P[1])
      if (!best || d < best.d) best = { Q, d }
    }
  }
  let Q = best.Q
  if (shape.kind === 'area' && best.d > 0.01) {
    // step 1.5 m past the edge along the pin->edge direction (lands inside the outline)
    const ux = (Q[0] - P[0]) / best.d, uy = (Q[1] - P[1]) / best.d
    const Q2 = [Q[0] + ux * 1.5, Q[1] + uy * 1.5]
    const ll = fromXY(Q2[0], Q2[1], lat0)
    if (shape.rings.some((r) => inRing(ll, r))) Q = Q2
  }
  return { pt: fromXY(Q[0], Q[1], lat0), inside: false }
}

// ---------- names ----------
const STOP = new Set(['the', 'of', 'an', 'and', 'to', 'in', 'at', 'on', 'for', 'edinburgh', 'mauritius', 'de', 'la', 'le', 'les', 'du', 'des', 'd', 'l', 'et', 'statue', 'monument', 'memorial', 'building', 'church', 'kirk', 'house', 'old', 'former', 'sculpture', 'plaque', 'bust', 'scotland', 'scottish', 'st', 'saint', 'mr', 'sir', 'dr', 'home', 'site', 'by', 'its', 'with', 'grave', 'gravestone', 'tombstone', 'tomb'])
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’'`]s\b/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
const stem = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)
// French -> English so 'Cathédrale Saint-Louis' and 'Saint Louis Cathedral' share words
const FR = { cathedrale: 'cathedral', eglise: 'church', musee: 'museum', jardin: 'garden', jardins: 'gardens', marche: 'market', mosquee: 'mosque', theatre: 'theatre', hotel: 'hotel', statue: 'statue', buste: 'bust', monument: 'monument', place: 'place', pont: 'bridge', rue: 'street', ancien: 'old', ancienne: 'old', mairie: 'town hall', chapelle: 'chapel', temple: 'temple', gare: 'station', cimetiere: 'cemetery', tombe: 'tomb', fontaine: 'fountain', bibliotheque: 'library', banque: 'bank', moulin: 'mill', marchand: 'merchant', center: 'centre', theater: 'theatre' }
const toks = (s, extra) => norm(s).split(' ').flatMap((w) => (FR[w] || w).split(' ')).filter((w) => w && !STOP.has(w) && !(extra && extra.has(w))).map(stem)
// words that only restate what the OSM feature is ("The Mitre Bar" = pub "The Mitre")
function typeWords(t) {
  if (t.amenity === 'pub' || t.amenity === 'bar') return new Set(['bar', 'pub', 'inn', 'tavern', 'lounge'])
  if (t.tourism === 'hotel' || t.tourism === 'hostel') return new Set(['hotel', 'hostel'])
  if (t.building === 'train_station') return new Set(['station'])
  if (t.amenity === 'restaurant' || t.amenity === 'cafe') return new Set(['restaurant', 'cafe'])
  return null
}
// 'exact' = same significant words; 'partial' = every word of the shorter (2+ words) name is in the longer
// a = POI title, b = OSM name. 'partial' = the OSM name is the POI title minus some words (POI more
// specific). 'wider' = the OSM name has extra words, often a different thing ("Thistle Court Primary").
function nameTier(a, b, extra) {
  const A = new Set(toks(a, extra)), B = new Set(toks(b, extra))
  if (!A.size || !B.size) return null
  let common = 0
  for (const w of A) if (B.has(w)) common++
  if (common === A.size && common === B.size) return 'exact'
  const bExtra = [...B].filter((w) => !A.has(w) && !/^[0-9]+$/.test(w)).length
  if (common === B.size && B.size >= 2) return 'partial'
  if (common === A.size && A.size >= 2) return bExtra ? 'wider' : 'partial'
  return null
}
// The title, and the title with any ", qualifier" / "(qualifier)" / " - qualifier" removed
const titleVariants = (title) => [...new Set([title, title.replace(/\s*\(.*?\)\s*/g, ' ').trim(), title.split(/,| - /)[0].trim()])]
const osmNames = (t) => ['name', 'name:en', 'official_name', 'alt_name', 'old_name', 'loc_name', 'short_name', 'inscription', 'subject'].map((k) => t[k]).filter(Boolean).flatMap((v) => v.split(';'))
function wikiTitle(link) {
  const m = /wikipedia\.org\/wiki\/([^#?]+)/.exec(link || '')
  return m ? decodeURIComponent(m[1]).replace(/_/g, ' ').toLowerCase() : null
}
const osmWiki = (t) => ['wikipedia', 'subject:wikipedia', 'memorial:wikipedia'].map((k) => t[k]).filter(Boolean).map((v) => v.replace(/^en:/, '').replace(/_/g, ' ').toLowerCase())

// ---------- candidate pool ----------
const POINTISH = new Set(['statue', 'monument', 'quirky', 'plaque', 'recurring_feature', 'viewpoint'])
const ROADLIKE = /\b(street|close|court|row|lane|wynd|square|steps|stairs|walk|terrace|place|loan|esplanade|bridge|mile|grassmarket|cowgate|lawnmarket|canongate|mound|vennel|rue|avenue|road|quay|alley|promenade)\b/i
const BUSINESS_TYPES = new Set(['pub', 'shop', 'hotel', 'building'])
function kindLabel(t) {
  for (const k of ['historic', 'memorial', 'artwork_type', 'tourism', 'amenity', 'building', 'shop', 'leisure', 'man_made', 'highway', 'landuse', 'place']) if (t[k]) return `${k}=${t[k]}`
  return Object.keys(t)[0] ? `${Object.keys(t)[0]}=${t[Object.keys(t)[0]]}` : ''
}
const EXCLUDE_AMENITY = new Set(['taxi', 'parking', 'parking_entrance', 'parking_space', 'bicycle_parking', 'motorcycle_parking', 'telephone', 'bus_station', 'atm', 'vending_machine', 'waste_basket', 'bench', 'charging_station', 'car_sharing', 'bicycle_rental', 'kick-scooter_rental'])
const BUSINESS_AMENITY = new Set(['pub', 'bar', 'restaurant', 'cafe', 'fast_food', 'nightclub', 'cinema', 'ice_cream', 'school', 'kindergarten', 'community_centre', 'social_facility', 'bank', 'pharmacy', 'dentist', 'doctors'])
const BUSINESS_TOURISM = new Set(['hotel', 'guest_house', 'hostel', 'apartment'])
const feats = []
for (const e of osm) {
  const t = e.tags || {}
  if (t.boundary || t.route || t.public_transport || t.railway || t.type === 'route' || t.type === 'site' || t.type === 'associatedStreet') continue
  if (EXCLUDE_AMENITY.has(t.amenity) || t.leisure === 'playground' || t.location === 'underground' || Object.keys(t).some((k) => k.startsWith('disused:'))) continue
  const shape = shapeOf(e)
  if (!shape) continue
  const pts = shape.kind === 'point' ? [shape.pt] : shape.rings.flat()
  const bb = [Math.min(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[1]))]
  const isBusiness = BUSINESS_AMENITY.has(t.amenity) || Boolean(t.shop) || BUSINESS_TOURISM.has(t.tourism) || Boolean(t.office) || Boolean(t.craft)
  feats.push({ bb, id: `${e.type}/${e.id}`, t, shape, kind: kindLabel(t), isRoad: Boolean(t.highway), isBusiness, isBuilding: Boolean(t.building) })
}

// What the POI title says it is -> which OSM features fit that best (used to break ties)
function semanticFit(title, f) {
  const s = title.toLowerCase(), t = f.t
  if (/\b(grave|gravestone|tombstone|tomb|mausoleum)\b/.test(s)) return t.cemetery === 'grave' || t.historic === 'tomb' || t.historic === 'grave'
  if (/\bhotel\b/.test(s)) return t.tourism === 'hotel'
  if (/\b(bar|pub|inn|tavern|lounge)\b/.test(s)) return t.amenity === 'pub' || t.amenity === 'bar'
  if (/\b(statue|monument|memorial|bust)\b/.test(s)) return Boolean(t.historic === 'memorial' || t.historic === 'monument' || t.tourism === 'artwork' || t.memorial)
  if (/\b(church|kirk|chapel|cathedral)\b/.test(s)) return t.amenity === 'place_of_worship' || t.building === 'church' || t.building === 'cathedral'
  return null
}

// address index
function parseAddr(addr) {
  const m = /^\s*(?:[^,]*,\s*)?(\d+[a-z]?)(?:\s*[-–]\s*(\d+[a-z]?))?\s+([A-Za-z' ]+?(?:Street|Square|Road|Place|Row|Terrace|Bridge|Mile|Lawnmarket|Canongate|Grassmarket|Bank|Wynd|Close|Crescent|Lane|Hill|Way|Walk|Court|Gardens))\b/i.exec(addr || '')
  if (!m) return null
  return { from: parseInt(m[1], 10), to: m[2] ? parseInt(m[2], 10) : parseInt(m[1], 10), street: norm(m[3]) }
}
function addrHits(a, f) {
  const hn = f.t['addr:housenumber'], st = f.t['addr:street']
  if (!hn || !st || norm(st) !== a.street) return false
  return hn.split(/[;,]/).some((part) => {
    const [x, y] = part.split(/[-–]/).map((v) => parseInt(v, 10))
    const lo = x, hi = Number.isNaN(y) || y === undefined ? x : y
    return lo <= a.to && hi >= a.from
  })
}

// ---------- match ----------
// Furthest an OSM feature may be from the current pin and still be accepted, by strength of evidence
const LIMIT = { wiki: 120, 'wiki-partial': 40, exact: 75, partial: 25, wider: 5, address: 40 }
const RANK = { wiki: 0, 'wiki-partial': 1, exact: 2, partial: 3, wider: 4, address: 5 }
function preferOrder(p, f, inside) {
  if (inside) return -1 // pin already inside a matching outline: no move needed
  if (p.roadLike) return f.isRoad ? 0 : 1 // closes/streets/squares: the street itself first
  if (POINTISH.has(p.type)) return f.shape.kind === 'point' ? 0 : f.isBuilding ? 2 : 1
  return f.shape.kind === 'area' ? 0 : 1
}
const GENERIC = new Set(['street', 'cafe', 'hostel', 'garden', 'gardens', 'hall', 'john', 'jame', 'george', 'william', 'robert', 'square', 'close', 'court', 'stone', 'library', 'little', 'black', 'view', 'hotel', 'princes', 'west', 'east', 'north', 'south', 'royal', 'national', 'city', 'bank', 'building', 'lane', 'place', 'rose', 'castle', 'tower', 'gate', 'well', 'museum', 'gallery', 'shop', 'market', 'port', 'louis', 'compagnie', 'armes', 'china', 'town', 'caudan', 'waterfront', 'old', 'new', 'grand', 'petit', 'sainte', 'mosque', 'temple', 'chapel', 'fort'])
function matchOne(p) {
  const cur = [p.lat, p.lng]
  const wt = wikiTitle(linkOf.get(p.key))
  const variants = titleVariants(p.title)
  const titleToks = new Set(variants.flatMap((x) => toks(x)))
  const cands = []
  const near = []
  let weak = null
  for (const f of feats) {
    if (f.isRoad && !p.roadLike) continue
    if (cur[0] < f.bb[0] - 0.003 || cur[0] > f.bb[1] + 0.003 || cur[1] < f.bb[2] - 0.005 || cur[1] > f.bb[3] + 0.005) continue
    const names = osmNames(f.t)
    let how = null, label = ''
    // 1. Same Wikipedia article — and the names share at least one real word (a POI linked to a
    //    broader article, e.g. a pub linked to "Grassmarket", must not match the Grassmarket itself)
    if (wt && osmWiki(f.t).includes(wt)) {
      const other = new Set([...toks(wt), ...names.flatMap((x) => toks(x))])
      const shared = [...titleToks].filter((w) => other.has(w)).length
      if (shared && shared === titleToks.size) { how = 'wiki'; label = `same Wikipedia article "${wt}"` }
      else if (shared) { how = 'wiki-partial'; label = `same Wikipedia article "${wt}" (name only partly matches)` }
    }
    // 2. Name
    if (!how) {
      let best = null, bn = ''
      for (const v of variants) for (const nm of names) {
        const tier = nameTier(v, nm, typeWords(f.t))
        if (tier && (!best || RANK[tier] < RANK[best])) { best = tier; bn = nm }
      }
      // shops/pubs/hotels/cafés only match POIs that are businesses/buildings, or by identical name
      if (best && f.isBusiness && !BUSINESS_TYPES.has(p.type) && best !== 'exact') best = null
      // a POI "on" a street (a viewpoint, post box, cobbles) is not the street itself
      if (best && f.isRoad && best !== 'exact') best = null
      if (best) { how = best; label = best === 'exact' ? `same name "${bn}"` : `name contains "${bn}"` }
    }
    // 3. Street address -> building outline
    if (!how && !f.isRoad && f.shape.kind === 'area' && !POINTISH.has(p.type)) {
      const a = parseAddr(p.address)
      if (a && addrHits(a, f)) { how = 'address'; label = `street address ${f.t['addr:housenumber']} ${f.t['addr:street']}` }
    }
    if (!how) {
      // note-only: a nearby feature sharing a distinctive word, not trusted enough to use
      if (!f.isRoad && names.length && cur[0] > f.bb[0] - 0.0004 && cur[0] < f.bb[1] + 0.0004 && cur[1] > f.bb[2] - 0.0007 && cur[1] < f.bb[3] + 0.0007) {
        const nt = new Set(names.flatMap((x) => toks(x, typeWords(f.t))))
        if ([...titleToks].some((w) => nt.has(w) && w.length > 3 && !GENERIC.has(w))) {
          const d = hav(cur, nearest(f.shape, cur).pt)
          if (d <= 40 && (!weak || d < weak.d)) weak = { d, name: f.t.name || names[0], id: f.id }
        }
      }
      continue
    }
    const n = nearest(f.shape, cur)
    const d = hav(cur, n.pt)
    const c = { f, n, d, how, label, sem: semanticFit(p.title, f) }
    if (d <= LIMIT[how]) cands.push(c); else if (d < 300) near.push(c)
  }
  // address on an address point (not a building) -> the building outline that contains it
  if (!cands.length && !POINTISH.has(p.type)) {
    const a = parseAddr(p.address)
    if (a) {
      for (const f of feats) {
        if (f.shape.kind !== 'point' || !addrHits(a, f)) continue
        if (hav(cur, f.shape.pt) > LIMIT.address) continue
        const b = feats.find((g) => g.isBuilding && g.shape.kind === 'area' && g.shape.rings.some((r) => inRing(f.shape.pt, r)))
        if (!b) continue
        const n = nearest(b.shape, cur)
        if (cands.some((c) => c.f === b)) continue
        cands.push({ f: b, n, d: hav(cur, n.pt), how: 'address', label: `street address ${f.t['addr:housenumber']} ${f.t['addr:street']} (address point inside this building)`, sem: null })
      }
    }
  }
  const semRank = (c) => (c.sem === true ? 0 : 1)
  cands.sort((x, y) => RANK[x.how] - RANK[y.how] || semRank(x) - semRank(y) || preferOrder(p, x.f, x.n.inside) - preferOrder(p, y.f, y.n.inside) || x.d - y.d)
  // Ambiguous: the runner-up is equally good evidence for a DIFFERENT thing in a different place.
  // Several OSM pieces with the same name and kind (a close drawn as 3 segments) are one thing -> nearest wins.
  let ambiguous = false
  if (cands.length > 1) {
    const [a, b] = cands
    const sameThing = a.f.t.name && norm(a.f.t.name) === norm(b.f.t.name) && (a.f.kind === b.f.kind || (a.f.isRoad && b.f.isRoad))
    if (!sameThing && RANK[a.how] === RANK[b.how] && semRank(a) === semRank(b) && preferOrder(p, a.f, a.n.inside) === preferOrder(p, b.f, b.n.inside) && hav(a.n.pt, b.n.pt) > 5) ambiguous = true
  }
  near.sort((x, y) => x.d - y.d)
  return { best: cands[0], ambiguous, alts: cands.slice(1, 3), near: near[0], weak }
}




// ---------- run ----------
const pois = [
  ...landmarks.map((l) => ({ key: 'l' + l.id, kind: 'Landmark', ref: `L${l.seq}`, seq: l.seq, id: l.id, title: l.title, address: l.address, type: 'landmark', lat: l.lat, lng: l.lng, roadLike: ROADLIKE.test(l.title) })),
  ...sites.map((s) => ({ key: 's' + s.id, kind: 'POI', ref: String(s.id), id: s.id, title: s.title, address: s.address, type: s.type, lat: s.lat, lng: s.lng, roadLike: s.type === 'close' || s.type === 'street' || ROADLIKE.test(s.title) })),
]
const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
const head = ['Kind', 'ID', 'Title', 'POI type', 'Current lat (Google pin)', 'Current lng (Google pin)', 'OSM lat', 'OSM lng', 'Difference (m)', 'Direction OSM is from current pin (deg, 0=N clockwise)', 'Direction (compass)', 'Found in OSM as', 'OSM feature', 'OSM link', 'Matched by', 'Confidence', 'Notes']
const rows = [head]
const review = { sites: {}, landmarks: {} }
const counts = { blue: 0, green: 0, amber: 0, red: 0 }
const r6 = (v) => Math.round(v * 1e6) / 1e6
for (const p of pois) {
  const r = matchOne(p)
  let row, entry
  if (!r.best || r.ambiguous) {
    const note = r.ambiguous
      ? `More than one OSM feature fits equally: ${[r.best, ...r.alts].map((c) => `"${c.f.t.name || c.label}" ${c.f.id} ${Math.round(c.d)} m`).join('; ')}`
      : r.near ? `Nearest name/wiki match is ${Math.round(r.near.d)} m away (${r.near.f.t.name || ''} ${r.near.f.id}) — too far to trust`
      : r.weak ? `Possibly "${r.weak.name}" (${r.weak.id}, ${Math.round(r.weak.d)} m) — name too different to be sure, not used` : 'Not in OSM by name'
    row = [p.kind, p.ref, p.title, p.type, p.lat, p.lng, '?', '?', '?', '?', '?', '?', '', '', '', '', note]
    entry = { s: 'blue' }
  } else {
    const b = r.best
    const dm = Math.round(hav([p.lat, p.lng], b.n.pt))
    const br = dm ? Math.round(bearing([p.lat, p.lng], b.n.pt)) % 360 : ''
    const conf = /^(wiki|exact)$/.test(b.how) ? 'High' : 'Medium'
    const shapeNote = b.f.shape.kind === 'point' ? 'OSM point' : b.n.inside ? 'pin is already inside this OSM outline' : b.f.shape.kind === 'area' ? 'moved just inside the nearest edge of this OSM outline' : 'nearest point on this OSM line'
    row = [p.kind, p.ref, p.title, p.type, p.lat, p.lng, b.n.pt[0].toFixed(6), b.n.pt[1].toFixed(6), dm, br, dm ? compass(br) : '', b.f.t.name || b.f.t['name:en'] || '(unnamed)', `${b.f.id} ${b.f.kind}`, `https://www.openstreetmap.org/${b.f.id}`, b.label, conf, shapeNote + (dm > 20 ? ' — LARGE difference, worth a look' : '')]
    const s = dm === 0 ? 'green' : dm <= 2 ? 'amber' : 'red'
    const osmLat = dm ? r6(b.n.pt[0]) : p.lat, osmLng = dm ? r6(b.n.pt[1]) : p.lng
    entry = p.kind === 'Landmark'
      ? { s, dLat: r6(osmLat - p.lat), dLng: r6(osmLng - p.lng), d: dm, dir: dm ? compass(br) : '', conf }
      : { s, lat: osmLat, lng: osmLng, d: dm, dir: dm ? compass(br) : '', osm: b.f.t.name || b.f.t['name:en'] || '(unnamed)', conf }
  }
  counts[entry.s]++
  if (p.kind === 'Landmark') review.landmarks[p.seq] = entry; else review.sites[p.id] = entry
  rows.push(row)
}
const date = new Date().toISOString().slice(0, 10)
const refDir = path.join(root, 'db/content', `${tourCode}-tour`, 'gps-reference')
fs.mkdirSync(refDir, { recursive: true })
const csvPath = path.join(refDir, `${tourCode}-osm-match-report-${date}.csv`)
fs.writeFileSync(csvPath, '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n')
const jsonPath = path.join(root, 'client/src/map', `osmReview.${tourCode}.json`)
fs.writeFileSync(jsonPath, JSON.stringify(review))
console.log(`${pois.length} pins:`, counts)
console.log('Report:', path.relative(root, csvPath))
console.log('App review data:', path.relative(root, jsonPath))
