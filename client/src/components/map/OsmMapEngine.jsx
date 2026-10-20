import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { PMTiles, Protocol } from 'pmtiles'
import { osmStyle } from '../../map/osmStyle.js'
import { tourMapUrl, tourMapBounds } from '../../map/mapFiles.js'

// Map view drawn from self-hosted OpenStreetMap data (MapLibre GL + one .pmtiles file per tour,
// built by scripts/maps/build-map-assets.mjs). It needs no API key and works
// with no signal: the map file, fonts and icons are saved on the phone with the rest of the tour
// (offline/contentCache.js) and served from there by the service worker.
//
// Zoom in and out of this component is in 256-px-tile zoom units (the web-map convention MapView's
// thresholds, scale bar and remembered camera were built in). MapLibre draws 512px tiles, so
// MapLibre zoom = that zoom − 1.
const ZOOM_OFFSET = 1
const FIT_PADDING = 56
// The tour's map file covers its landmarks + sites plus a margin; panning is kept to about that
// area (a little beyond, so a pin at the edge can still be centred) — past it there's no map data.
const PAN_MARGIN_DEG = 0.01
// Matches build-map-assets.mjs's MIN_ZOOM (the file has nothing below it).
const MIN_ZOOM = 11

// Stacking within the map: sites under the "you are here" dot under landmarks. A marker's own
// zIndex (landmarks, the pin being dragged by Set GPS) wins over this.
const LAYER_Z = { site: 1, here: 2, landmark: 3 }

// --- Map file: fetched whole, kept in memory ---
// pmtiles normally reads a map file in byte ranges straight from the server. Loading the whole
// (1–3 MB) file once instead means no dependency on the host or the service worker answering
// Range requests, a reopened map draws instantly, and with no signal the one request is answered
// from the phone's saved copy.
const fileLoads = new Map() // url -> Promise<ArrayBuffer>

function loadMapFile(url) {
  if (!fileLoads.has(url)) {
    const p = fetch(url).then(async (res) => {
      if (!res.ok) throw new Error(`map file ${res.status}`)
      const buf = await res.arrayBuffer()
      // A missing file on Cloudflare comes back as the app's own HTML page, with status 200.
      if (new TextDecoder().decode(buf.slice(0, 7)) !== 'PMTiles') throw new Error('not a map file')
      return buf
    })
    p.catch(() => fileLoads.delete(url)) // so a retry with signal back fetches again
    fileLoads.set(url, p)
  }
  return fileLoads.get(url)
}

class WholeFileSource {
  constructor(url) { this.url = url }
  getKey() { return this.url }
  async getBytes(offset, length) {
    const buf = await loadMapFile(this.url)
    return { data: buf.slice(offset, offset + length) }
  }
}

const protocol = new Protocol()
maplibregl.addProtocol('pmtiles', protocol.tile)
const registered = new Set()
function registerMapFile(url) {
  if (registered.has(url)) return
  registered.add(url)
  protocol.add(new PMTiles(new WholeFileSource(url)))
}

// --- Markers ---
// MapLibre positions a marker's element itself (position: absolute + a transform). Our pin classes
// set position: relative (for badges and labels), which would override that and drop every pin
// into normal page flow, hundreds of px from its spot — so each pin renders (via a portal) inside a
// plain wrapper div that MapLibre owns.
function OsmMarker({ map, marker: m }) {
  const [el] = useState(() => document.createElement('div'))
  const markerRef = useRef(null)
  const latest = useRef(m)
  latest.current = m

  useEffect(() => {
    // Bottom-centre on the coordinate — every saved position (incl. Set GPS drags) was placed by eye
    // with that convention; a centre anchor would draw every pin half its height lower.
    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([m.lng, m.lat]).addTo(map)
    const onClick = (e) => {
      e.stopPropagation()
      latest.current.onClick?.()
    }
    el.addEventListener('click', onClick)
    marker.on('dragend', () => {
      const p = marker.getLngLat()
      latest.current.onDragEnd?.({ lat: p.lat, lng: p.lng })
    })
    markerRef.current = marker
    return () => {
      el.removeEventListener('click', onClick)
      marker.remove()
      markerRef.current = null
    }
  }, [map, el])

  useEffect(() => { markerRef.current?.setLngLat([m.lng, m.lat]) }, [m.lng, m.lat])
  useEffect(() => { markerRef.current?.setDraggable(Boolean(m.draggable)) }, [m.draggable])
  useEffect(() => {
    el.style.zIndex = String(m.zIndex ?? LAYER_Z[m.layer] ?? 0)
    el.style.cursor = m.onClick ? 'pointer' : ''
  }, [el, m.zIndex, m.layer, Boolean(m.onClick)])

  return createPortal(m.content, el)
}

// --- Shift lines (dev-only OSM review) ---
// Thin line + small dot from a pin's old position to where it's drawn now. Drawn by MapLibre
// itself (not DOM markers), so it sits under every pin and stays glued to the map.
const SHIFT_SOURCE = 'review-shifts'
function shiftGeoJson(lines) {
  return {
    type: 'FeatureCollection',
    features: lines.flatMap((l) => [
      { type: 'Feature', properties: { color: l.color }, geometry: { type: 'LineString', coordinates: [[l.from.lng, l.from.lat], [l.to.lng, l.to.lat]] } },
      { type: 'Feature', properties: { color: l.color }, geometry: { type: 'Point', coordinates: [l.from.lng, l.from.lat] } },
    ]),
  }
}
function useShiftLines(map, lines) {
  const key = JSON.stringify(lines || [])
  useEffect(() => {
    if (!map) return
    const apply = () => {
      const data = shiftGeoJson(lines || [])
      const src = map.getSource(SHIFT_SOURCE)
      if (src) { src.setData(data); return }
      if (!lines?.length) return
      map.addSource(SHIFT_SOURCE, { type: 'geojson', data })
      map.addLayer({ id: 'review-shift-lines', type: 'line', source: SHIFT_SOURCE, filter: ['==', '$type', 'LineString'], paint: { 'line-color': ['get', 'color'], 'line-width': 1.5 } })
      map.addLayer({ id: 'review-shift-dots', type: 'circle', source: SHIFT_SOURCE, filter: ['==', '$type', 'Point'], paint: { 'circle-color': ['get', 'color'], 'circle-radius': 3.5, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 } })
    }
    if (map.isStyleLoaded()) apply()
    else map.once('load', apply)
    return () => { map.off('load', apply) }
  }, [map, key]) // eslint-disable-line react-hooks/exhaustive-deps
}

export default function OsmMapEngine({ tourCode, attempt, initialCenter, initialZoom, fitBounds, markers, lines, onCamera, onFailedChange }) {
  const containerRef = useRef(null)
  const [map, setMap] = useState(null)
  // Read once, at creation — later changes to these are the player's own panning, not ours.
  const initial = useRef({ initialCenter, initialZoom, fitBounds })
  const onCameraRef = useRef(onCamera)
  onCameraRef.current = onCamera

  useEffect(() => {
    const url = tourMapUrl(tourCode)
    if (!url) { onFailedChange(true); return }
    let cancelled = false
    let created = null

    loadMapFile(url).then(() => {
      if (cancelled) return
      onFailedChange(false)
      registerMapFile(url)
      const { initialCenter: c, initialZoom: z, fitBounds: fb } = initial.current
      const [w, s, e, n] = tourMapBounds(tourCode)
      // Throws if the phone can't give MapLibre WebGL (rare: very old or locked-down devices) —
      // caught below, so the nearby list stands in rather than an empty box.
      const m = new maplibregl.Map({
        container: containerRef.current,
        style: osmStyle(url),
        center: [c.lng, c.lat],
        zoom: z - ZOOM_OFFSET,
        minZoom: MIN_ZOOM,
        maxZoom: 20,
        maxBounds: [[w - PAN_MARGIN_DEG, s - PAN_MARGIN_DEG], [e + PAN_MARGIN_DEG, n + PAN_MARGIN_DEG]],
        // North always up and never tilted — MapView's fixed N/E/S/W compass
        // relies on it.
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        maxPitch: 0,
        attributionControl: { compact: true },
      })
      m.touchZoomRotate.disableRotation()
      m.keyboard.disableRotation()

      // First-visit fit to the solved landmarks. Waits for the container to have a real size —
      // Map view can be created while hidden (HomePage kept mounted behind CURRENT landmark).
      let fitted = !fb
      const fit = () => {
        if (fitted || !containerRef.current?.clientWidth) return
        fitted = true
        m.fitBounds([[fb.west, fb.south], [fb.east, fb.north]], { padding: FIT_PADDING, duration: 0, maxZoom: 19 - ZOOM_OFFSET })
      }
      fit()
      m.on('resize', fit)

      // Camera changes reported at most once per frame (a pinch fires 'move' far more often).
      let frame = 0
      m.on('move', () => {
        if (frame) return
        frame = requestAnimationFrame(() => {
          frame = 0
          const center = m.getCenter()
          onCameraRef.current({ center: { lat: center.lat, lng: center.lng }, zoom: m.getZoom() + ZOOM_OFFSET })
        })
      })

      created = m
      setMap(m)
    }).catch(() => {
      if (!cancelled) onFailedChange(true)
    })

    return () => {
      cancelled = true
      if (created) created.remove()
      setMap(null)
    }
  }, [tourCode, attempt])

  useShiftLines(map, lines)

  return (
    <div ref={containerRef} className="osm-map">
      {map && markers.map((m) => <OsmMarker key={m.key} map={map} marker={m} />)}
    </div>
  )
}
