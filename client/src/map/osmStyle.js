import { layers, namedFlavor } from '@protomaps/basemaps'
import { glyphsUrl, spriteUrl } from './mapFiles.js'

// The OSM map's look, picked from the 2026-10-19 prototype: Protomaps' stock "light" style (the
// "Clean" option) with "Defined" buildings — a solid fill plus a crisp outline, instead of the
// stock faint grey — the stock house numbers (zoom 18+), and mapped trees as green dots. OSM's own
// POI icons (cafés, shops…) are left out, as the Google map's were, so they don't compete with our
// own markers.

const SOURCE = 'protomaps'
const BUILDING_FILTER = ['in', 'kind', 'building', 'building_part']

export function osmStyle(mapUrl) {
  const base = layers(SOURCE, namedFlavor('light'), { lang: 'en' }).filter((l) => l.id !== 'pois')
  const i = base.findIndex((l) => l.id === 'buildings')
  base.splice(i, 1,
    { id: 'buildings', type: 'fill', source: SOURCE, 'source-layer': 'buildings', filter: BUILDING_FILTER,
      paint: { 'fill-color': '#dedede' } },
    { id: 'buildings_outline', type: 'line', source: SOURCE, 'source-layer': 'buildings', filter: BUILDING_FILTER, minzoom: 14,
      paint: { 'line-color': '#b9b9b9', 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.3, 18, 1.2] } },
  )
  // Individually mapped trees as small green dots (mostly Edinburgh; added 2026-10-19 at the
  // user's request). Above roads, under every label.
  const t = base.findIndex((l) => l.id === 'roads_bridges_highway') + 1
  base.splice(t || base.length, 0,
    { id: 'trees', type: 'circle', source: SOURCE, 'source-layer': 'pois', minzoom: 15, filter: ['==', ['get', 'kind'], 'tree'],
      paint: { 'circle-color': '#8fbf73', 'circle-opacity': 0.85, 'circle-stroke-color': '#6f9e57', 'circle-stroke-width': 0.6,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 15, 1.5, 19, 6] } },
  )
  return {
    version: 8,
    glyphs: glyphsUrl(),
    sprite: spriteUrl(),
    sources: {
      [SOURCE]: {
        type: 'vector',
        url: `pmtiles://${mapUrl}`,
        attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> · <a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a>',
      },
    },
    layers: base,
  }
}
