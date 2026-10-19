// Builds the self-hosted OpenStreetMap files the app's map (OSM engine) runs on, so the map works
// with no signal and needs no API key:
//   client/public/map/<tour_code>.pmtiles   — vector map data for the tour's area (Protomaps build)
//   client/public/map/fonts/<stack>/<range>.pbf — only the label-font ranges that area's names use
//   client/public/map/sprites/light*.{json,png} — the style's few icons (one-way arrows, shields)
//   client/src/map/mapAssets.json            — what the app downloads for offline (contentCache.js)
//
// Area = every landmark + site of the tour in the LOCAL database, plus a margin. Rerun after adding
// sites outside the current area, or to refresh the map data (it's a snapshot of OSM).
//
//   node scripts/maps/build-map-assets.mjs                 # every tour in the local DB
//   node scripts/maps/build-map-assets.mjs port-louis      # just one (others' entries are kept)
//   options: --build=20261019 (Protomaps build date; default latest) --margin-m=500
//
// Downloads (cached in scripts/maps/.cache, gitignored): the go-pmtiles CLI, font ranges.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { PMTiles } from 'pmtiles'
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader as Protobuf } from 'pbf'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const CACHE = path.join(here, '.cache')
const OUT = path.join(root, 'client/public/map')
const MANIFEST = path.join(root, 'client/src/map/mapAssets.json')
const PMTILES_VERSION = '1.31.2'
const ASSETS_RAW = 'https://raw.githubusercontent.com/protomaps/basemaps-assets/main'
const MAX_ZOOM = 15 // Protomaps data stops at 15; MapLibre overzooms crisply past it
// The app's map can't zoom out past the city (minZoom in client/src/map/osmStyle.js), so world-view
// tiles are left out — they're also where far-off country names in a dozen scripts come from.
export const MIN_ZOOM = 11
const FONT_STACKS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic', 'Noto Sans Devanagari Regular v1']
const SPRITES = ['light.json', 'light.png', 'light@2x.json', 'light@2x.png']
const UA = { 'User-Agent': 'tourz-map-build' }

const args = process.argv.slice(2)
const opt = (name, dflt) => (args.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || dflt
const onlyTours = args.filter((a) => !a.startsWith('--'))
const marginM = Number(opt('margin-m', 500))

async function download(url, dest) {
  const res = await fetch(url, { headers: UA })
  if (!res.ok) return false
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
  return true
}

async function pmtilesCli() {
  if (process.platform !== 'win32') throw new Error('Only the Windows pmtiles CLI download is wired up — add your platform here.')
  const exe = path.join(CACHE, `pmtiles-${PMTILES_VERSION}`, 'pmtiles.exe')
  if (fs.existsSync(exe)) return exe
  const zip = path.join(CACHE, 'pmtiles.zip')
  const url = `https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Windows_x86_64.zip`
  if (!(await download(url, zip))) throw new Error(`Could not download ${url}`)
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  // Windows' own bsdtar reads .zip; named by full path since Git Bash's GNU tar (often first on
  // PATH) reads "C:" as a remote host.
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  execFileSync(tar, ['-xf', zip, '-C', path.dirname(exe)])
  return exe
}

async function latestBuild() {
  const builds = await (await fetch('https://build-metadata.protomaps.dev/builds.json', { headers: UA })).json()
  return builds.map((b) => b.key.replace('.pmtiles', '')).sort().at(-1)
}

async function tourAreas() {
  const { localPool } = require(path.join(root, 'scripts/db-sync/connections.js'))
  const pool = localPool()
  try {
    const { rows } = await pool.query(`
      SELECT t.tour_code, min(p.lat) s, max(p.lat) n, min(p.lng) w, max(p.lng) e, count(*) pts
      FROM tours t JOIN (
        SELECT tour_id, latitude lat, longitude lng FROM landmarks
        UNION ALL SELECT tour_id, latitude, longitude FROM sites) p ON p.tour_id = t.id
      GROUP BY t.tour_code ORDER BY t.tour_code`)
    return rows.map((r) => {
      const dLat = marginM / 111320
      const dLng = marginM / (111320 * Math.cos(((+r.s + +r.n) / 2) * Math.PI / 180))
      const r4 = (v) => Math.round(v * 1e4) / 1e4
      return { code: r.tour_code, points: Number(r.pts), bbox: [r4(+r.w - dLng), r4(+r.s - dLat), r4(+r.e + dLng), r4(+r.n + dLat)] }
    })
  } finally {
    await pool.end()
  }
}

// Reads a local .pmtiles file for the pmtiles library.
class FileSource {
  constructor(file) { this.fd = fs.openSync(file, 'r'); this.file = file }
  getKey() { return this.file }
  async getBytes(offset, length) {
    const buf = Buffer.alloc(length)
    fs.readSync(this.fd, buf, 0, length, offset)
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + length) }
  }
}

// Every 256-codepoint glyph range a label in this file could need. CJK / Hangul / kana are skipped:
// MapLibre draws those with the phone's own font (localIdeographFontFamily) and never fetches them.
const LOCAL_SCRIPT = [[0x3040, 0x30ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xac00, 0xd7af], [0xf900, 0xfaff]]
// Only the fields the style's labels actually draw (basemaps.layers with lang 'en' — see
// client/src/map/osmStyle.js); the many other-language name:xx tags are never shown.
const TEXT_KEY = /^((pgf:)?name[23]?|name:en|ref(:en)?|shield_text(_\d)?|addr_housenumber)$/
async function glyphRanges(file, bbox) {
  const tiles = new PMTiles(new FileSource(file))
  const ranges = new Set([0, 256, 8192]) // basic Latin, accented Latin, punctuation (’ – …) always
  const lon2x = (lng, z) => Math.floor((lng + 180) / 360 * 2 ** z)
  const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z) }
  const zlib = await import('node:zlib')
  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
    for (let x = lon2x(bbox[0], z); x <= lon2x(bbox[2], z); x++) {
      for (let y = lat2y(bbox[3], z); y <= lat2y(bbox[1], z); y++) {
        const t = await tiles.getZxy(z, x, y)
        if (!t) continue
        let data = Buffer.from(t.data)
        if (data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data)
        const vt = new VectorTile(new Protobuf(data))
        for (const name of Object.keys(vt.layers)) {
          if (name === 'pois') continue // OSM's own POI layer isn't drawn (it'd compete with our markers)
          const layer = vt.layers[name]
          for (let i = 0; i < layer.length; i++) {
            const props = layer.feature(i).properties
            for (const [k, v] of Object.entries(props)) {
              if (!TEXT_KEY.test(k) || typeof v !== 'string') continue
              for (const ch of v) {
                const cp = ch.codePointAt(0)
                if (cp > 0xffff || LOCAL_SCRIPT.some(([a, b]) => cp >= a && cp <= b)) continue
                ranges.add(Math.floor(cp / 256) * 256)
              }
            }
          }
        }
      }
    }
  }
  return ranges
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`
const dirBytes = (dir) => fs.existsSync(dir)
  ? fs.readdirSync(dir, { withFileTypes: true }).reduce((n, d) => n + (d.isDirectory() ? dirBytes(path.join(dir, d.name)) : fs.statSync(path.join(dir, d.name)).size), 0)
  : 0

async function main() {
  const build = opt('build', await latestBuild())
  const cli = await pmtilesCli()
  const prev = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : { tours: {} }
  const areas = (await tourAreas()).filter((a) => !onlyTours.length || onlyTours.includes(a.code))
  if (!areas.length) throw new Error(`No matching tours in the local DB (${onlyTours.join(', ')})`)
  fs.mkdirSync(OUT, { recursive: true })

  const tours = { ...prev.tours }
  for (const a of areas) {
    const file = path.join(OUT, `${a.code}.pmtiles`)
    console.log(`${a.code}: ${a.points} points, bbox ${a.bbox.join(',')} — extracting from Protomaps build ${build}…`)
    execFileSync(cli, ['extract', `https://build.protomaps.com/${build}.pmtiles`, file, `--bbox=${a.bbox.join(',')}`, `--minzoom=${MIN_ZOOM}`, `--maxzoom=${MAX_ZOOM}`], { stdio: 'inherit' })
    const ranges = [...(await glyphRanges(file, a.bbox))].sort((x, y) => x - y)
    tours[a.code] = { file: `/map/${a.code}.pmtiles`, bytes: fs.statSync(file).size, bbox: a.bbox, build, glyphRanges: ranges }
    console.log(`  ${mb(tours[a.code].bytes)}, glyph ranges ${ranges.map((r) => `${r}-${r + 255}`).join(' ')}`)
  }

  // Fonts: the union of every tour's ranges, in each font stack that has that range.
  const allRanges = [...new Set(Object.values(tours).flatMap((t) => t.glyphRanges))].sort((x, y) => x - y)
  fs.rmSync(path.join(OUT, 'fonts'), { recursive: true, force: true })
  const glyphs = []
  for (const stack of FONT_STACKS) {
    // The style only uses this font for labels written in Devanagari (Hindi).
    if (stack.includes('Devanagari') && !allRanges.includes(2304)) continue
    for (const r of allRanges) {
      const name = `${r}-${r + 255}.pbf`
      const cached = path.join(CACHE, 'fonts', stack, name)
      const missingMark = cached + '.missing'
      if (!fs.existsSync(cached) && !fs.existsSync(missingMark)) {
        const ok = await download(`${ASSETS_RAW}/fonts/${encodeURIComponent(stack)}/${name}`, cached)
        if (!ok) { fs.mkdirSync(path.dirname(missingMark), { recursive: true }); fs.writeFileSync(missingMark, '') }
      }
      if (!fs.existsSync(cached)) continue
      fs.mkdirSync(path.join(OUT, 'fonts', stack), { recursive: true })
      fs.copyFileSync(cached, path.join(OUT, 'fonts', stack, name))
      glyphs.push(`/map/fonts/${stack}/${name}`)
    }
  }

  const sprites = []
  for (const f of SPRITES) {
    const dest = path.join(OUT, 'sprites', f)
    if (!fs.existsSync(dest) && !(await download(`${ASSETS_RAW}/sprites/v4/${f}`, dest))) throw new Error(`sprite ${f} download failed`)
    sprites.push(`/map/sprites/${f}`)
  }

  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true })
  fs.writeFileSync(MANIFEST, JSON.stringify({ generatedAt: new Date().toISOString(), tours, glyphs, sprites }, null, 2) + '\n')
  console.log(`\nfonts ${mb(dirBytes(path.join(OUT, 'fonts')))} (${glyphs.length} files), sprites ${mb(dirBytes(path.join(OUT, 'sprites')))}`)
  for (const [code, t] of Object.entries(tours)) console.log(`${code}: map ${mb(t.bytes)}`)
  console.log(`wrote ${path.relative(root, MANIFEST)}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
