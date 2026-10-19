import MAP_ASSETS from './mapAssets.json'

// The self-hosted map files (built by scripts/maps/build-map-assets.mjs into client/public/map/):
// one vector map per tour, plus the label fonts and style icons every tour shares. Absolute URLs,
// since that's how they're saved in (and looked up from) the offline content cache.

const abs = (p) => new URL(p, location.origin).href

// null when this tour has no map built yet — Map view then falls back to the nearby list.
export function tourMapUrl(tourCode) {
  const t = MAP_ASSETS.tours[tourCode]
  return t ? abs(t.file) : null
}

export function tourMapBounds(tourCode) {
  return MAP_ASSETS.tours[tourCode]?.bbox || null // [west, south, east, north]
}

// Everything the phone needs to draw this tour's map with no signal — added to the background
// "save tour" download (offline/contentCache.js).
export function mapAssetUrls(tourCode) {
  const t = MAP_ASSETS.tours[tourCode]
  if (!t) return []
  const ranges = new Set(t.glyphRanges.map((r) => `/${r}-${r + 255}.pbf`))
  return [t.file, ...MAP_ASSETS.glyphs.filter((g) => ranges.has(g.slice(g.lastIndexOf('/')))), ...MAP_ASSETS.sprites].map(abs)
}

// Plain string, not abs(): new URL() would encode the {fontstack}/{range} placeholders as %7B…%7D
// and MapLibre would reject the whole style (blank map, markers only).
export const glyphsUrl = () => `${location.origin}/map/fonts/{fontstack}/{range}.pbf`
export const spriteUrl = () => `${location.origin}/map/sprites/light`
