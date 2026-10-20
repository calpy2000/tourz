import { useState, useEffect, useMemo, useRef, lazy, Suspense } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { API_BASE } from '../apiBase.js'
import { useGeolocation } from '../useGeolocation.js'
import { saveGpsCorrection, loadGpsCorrections } from '../gpsCorrections.js'
import { DEV_MODE } from '../devMode.js'
import { useOsmReview, useOsmReviewData, seedPresetVerdicts, REVIEW_COLORS } from '../map/osmReview.js'
import DetailPopup from './DetailPopup.jsx'
import NearbyList from './NearbyList.jsx'
import { isStartLandmark, landmarkDisplayNumber } from '../landmarkNumber.js'
import { getLastFetched, setLastFetched } from '../lastFetched.js'
import { useGameStore } from '../offline/gameStore.js'
import { mapLandmarksView, landmarkDetailView } from '../offline/engine.js'
import { useContentCache, siteDetailFromPack } from '../offline/contentCache.js'
import { useConnection } from '../net/connection.js'

// The map: self-hosted OpenStreetMap drawn by MapLibre (works with no signal). Zoom numbers in this
// file are 256-px-tile zoom levels (MapLibre's own = one less; OsmMapEngine converts). MapLibre is
// large, so the engine is its own chunk.
const OsmMapEngine = lazy(() => import('./map/OsmMapEngine.jsx'))

// Used only if the team has no solved landmarks yet (map needs some center before the first find).
const FALLBACK_CENTER = { lat: 55.9535, lng: -3.197 }

// Module-level (not component state) so it survives MapView unmounting entirely — navigating to
// a landmark/site detail page and back remounts MapView from scratch, and without this the map
// would re-run its initial fit-to-bounds every time instead of reopening exactly where the
// player left it. Resets on a full page reload, which is fine — this is "remember within this
// visit," not something that needs to survive that.
let lastCamera = null // { center: {lat,lng}, zoom }

// Fixed N/E/S/W reference, not a live heading — the map never rotates (no heading/tilt
// interaction is enabled), so north is always straight up and this never needs to move.
// pointer-events: none in CSS so it can't swallow a pan/tap on the map underneath it.
const COMPASS_LETTER = { fontFamily: 'Quicksand', fontWeight: 700, textAnchor: 'middle', dominantBaseline: 'central' }
function MapCompass() {
  return (
    <div className="map-compass" aria-hidden="true">
      <svg width="48" height="48" viewBox="0 0 64 64">
        <circle cx="32" cy="32" r="30" fill="#fffdf8" fillOpacity=".6" stroke="var(--umber)" strokeOpacity=".5" strokeWidth="1.5" />
        <polygon points="32,21 36,32 28,32" fill="#b3402e" />
        <polygon points="32,43 36,32 28,32" fill="#9a9184" />
        <circle cx="32" cy="32" r="1.6" fill="#fffdf8" />
        <text x="32" y="9" fontSize="14" fill="#b3402e" style={COMPASS_LETTER}>N</text>
        <text x="55" y="32" fontSize="12" fill="var(--umber)" style={COMPASS_LETTER}>E</text>
        <text x="32" y="55" fontSize="12" fill="var(--umber)" style={COMPASS_LETTER}>S</text>
        <text x="9" y="32" fontSize="12" fill="var(--umber)" style={COMPASS_LETTER}>W</text>
      </svg>
    </div>
  )
}

// Live distance scale — a map's built-in scale control can't be moved or styled
// (it'd sit tiny beside the bottom attribution), so this recomputes one from zoom + latitude.
// Web Mercator: metres per screen pixel = 156543.03 × cos(lat) / 2^zoom. The label snaps to a
// round 1/2/5 × 10ⁿ distance and the bar takes whatever width that works out to, ≤ max.
const SCALE_BAR_MAX_PX = 280
function MapScaleBar({ zoom, lat }) {
  const metresPerPx = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom)
  const maxMetres = metresPerPx * SCALE_BAR_MAX_PX
  const pow = Math.pow(10, Math.floor(Math.log10(maxMetres)))
  const lead = maxMetres / pow
  const metres = (lead >= 5 ? 5 : lead >= 2 ? 2 : 1) * pow
  return (
    <div className="map-scale" aria-hidden="true">
      <div className="map-scale-label">{metres >= 1000 ? `${metres / 1000} km` : `${metres} m`}</div>
      <div className="map-scale-bar" style={{ width: `${metres / metresPerPx}px` }} />
    </div>
  )
}

// Fallback only — used when the browser's real GPS (useGeolocation) hasn't produced a fix yet,
// or is unsupported/denied. Renders "you are here" a short fixed offset from the most recently
// solved landmark, so the marker exists visually rather than the layer having nothing to show.
function placeholderHereLocation(solvedLandmarks) {
  if (solvedLandmarks.length === 0) return FALLBACK_CENTER
  const last = solvedLandmarks[solvedLandmarks.length - 1]
  return { lat: last.latitude + 0.0015, lng: last.longitude + 0.001 }
}

// OSM review (dev only): the latest Set GPS fix saved on this device for each site / landmark.
function latestGpsFixes() {
  seedPresetVerdicts(loadGpsCorrections, saveGpsCorrection)
  const out = { sites: {}, landmarks: {} }
  for (const c of loadGpsCorrections()) {
    const [lat, lng] = String(c.enteredGps || '').split(',').map((v) => Number(v.trim()))
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
    if (c.type === 'site') out.sites[c.id] = { lat, lng }
    else if (c.type === 'landmark') out.landmarks[c.sequenceOrder] = { lat, lng }
  }
  return out
}

const REVIEW_LABELS = { blue: 'not found in OSM — left as is', green: 'same spot as OSM', amber: 'moved 1–2 m to OSM', red: 'moved over 2 m to OSM' }
function reviewNote(entry, fixed) {
  if (fixed) return 'OSM review: checked by hand (Set GPS or GPS OK)'
  if (!entry) return null
  if (entry.s === 'blue') return `OSM review: ${REVIEW_LABELS.blue}`
  return `OSM review: ${REVIEW_LABELS[entry.s]}${entry.d ? ` · ${entry.d} m ${entry.dir}` : ''}${entry.osm ? ` · matched "${entry.osm}"` : ''} · ${entry.conf} confidence`
}

// Game start (only the pre-found start landmark solved) should open focused tight on it, not
// zoomed out to fit a bounding box against the "here" placeholder point — tune this once real
// zoom feedback comes in.
const START_LANDMARK_ZOOM = 17

// Below this zoom, Interests render as small plain-color dots instead of their full star pin —
// standard practice on zooming maps (big map apps' POI layers, Airbnb, etc. all simplify markers
// below some threshold rather than letting a dense area turn into a wall of overlapping icons).
// 17 matches START_LANDMARK_ZOOM's already-established "close, street-level" feel; not yet tuned
// against a real dense cluster, adjust after seeing it live. Landmarks are deliberately exempt —
// there are only ever a handful of them, so they never crowd the way Interests can.
const ICON_ZOOM_THRESHOLD = 17

// Name labels join a beat later than the icon swap itself — at dense clusters (e.g. St Andrew
// Square, ~40+ Interests) turning on labels at the same zoom as the icon swap produces overlapping
// text. Requiring one more zoom step first thins out how many pins are visible at once before any
// text is drawn.
const LABEL_ZOOM_THRESHOLD = ICON_ZOOM_THRESHOLD + 2

// Initial view should show the whole solved-so-far path at once, not just center on one point —
// otherwise a team a few landmarks in only sees whichever pin happens to be centered.
function boundsFor(points) {
  const lats = points.map((p) => p.lat)
  const lngs = points.map((p) => p.lng)
  return { north: Math.max(...lats), south: Math.min(...lats), east: Math.max(...lngs), west: Math.min(...lngs) }
}

function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2 15 9 22 9.5 16.8 14.2 18.3 21 12 17.3 5.7 21 7.2 14.2 2 9.5 9 9Z" />
    </svg>
  )
}

// Eyebrow label shown above a site's title, keyed by its `type` column — extended from the
// original 3-value set (moved here from the now-deleted SiteDetailPage.jsx) to cover the types
// used by POI.csv once those rows are promoted into real sites (see feedback-content-sourcing-process
// and project-poi-sourcing-process memory).
const SITE_TYPE_LABELS = {
  statue: 'Statue',
  monument: 'Monument',
  famous_person: 'Notable figure',
  building: 'Building',
  religious_building: 'Religious building',
  plaque: 'Plaque',
  history: 'History',
  viewpoint: 'Viewpoint',
  architectural_point: 'Architectural detail',
  quirky: 'Quirky find',
  recurring_feature: 'Recurring feature',
}

// `active` is false while HomePage is kept mounted but hidden behind CURRENT landmark (see
// App.jsx) — the map and its markers stay built so switching back is instant, but GPS pauses.
export default function MapView({ active = true }) {
  const navigate = useNavigate()
  const connection = useConnection()
  // Landmark pins come from the phone's game state; site pins and cards from the tour pack saved
  // at the start of the tour (offline/contentCache.js) — so the whole map's markers and every card
  // work with no signal. Only until the pack has downloaded (the first minute or so of a fresh
  // tour) are sites fetched from GET /api/game/map instead, as before.
  const { state: game } = useGameStore()
  const { pack } = useContentCache()
  const [fallbackSites, setFallbackSites] = useState(() => getLastFetched('map')?.sites || null)
  // Set GPS drag (dev tool) moves a pin for the rest of the session — kept as an override here.
  const [movedSites, setMovedSites] = useState({})
  // Same as movedSites, for landmarks dragged with Set GPS (dev) — keyed by sequenceOrder.
  const [movedLandmarks, setMovedLandmarks] = useState({})
  const mapData = useMemo(() => {
    if (!game) return null
    const baseSites = pack?.sites || fallbackSites
    if (!baseSites) return null
    const sites = baseSites.map((s) => (movedSites[s.id] ? { ...s, ...movedSites[s.id] } : s))
    return { ...mapLandmarksView(game), sites }
  }, [game, pack, fallbackSites, movedSites])
  // Dev-only OSM review colours (see map/osmReview.js) — OSM map only.
  const osmReviewOn = useOsmReview()
  const review = useOsmReviewData(game?.tour?.tourCode, DEV_MODE && osmReviewOn)
  // Bumped on reconnect after a failed map load, to try loading the map again.
  const [mapAttempt, setMapAttempt] = useState(0)
  // The map couldn't load (map file neither saved on the phone yet nor reachable, or no WebGL) —
  // NearbyList stands in for it.
  const [mapFailed, setMapFailed] = useState(false)
  // Set by DetailPopup's "Set GPS" button (Interests/sites) — identifies the one marker currently
  // draggable on the map, compared by id (sitePopup is a separately-fetched object, never the
  // same reference as its entry in mapData.sites). Cleared on drop or Cancel.
  const [gpsDragTarget, setGpsDragTarget] = useState(null)
  const [gpsDragSavedName, setGpsDragSavedName] = useState(null)
  const [landmarkPopup, setLandmarkPopup] = useState(null)
  const [sitePopup, setSitePopup] = useState(null)
  // Tracks camera zoom so Interests can simplify to dots below ICON_ZOOM_THRESHOLD — seeded from
  // lastCamera so a returning player doesn't get a one-frame flash of the wrong marker style
  // before the first onCameraChanged fires.
  const [zoom, setZoom] = useState(lastCamera?.zoom ?? null)
  // Scale bar needs the camera's latitude too (metres-per-pixel shrinks away from the equator).
  const [cameraLat, setCameraLat] = useState(lastCamera?.center.lat ?? null)
  const { location: liveLocation, error: gpsError, reacquiring, stalled } = useGeolocation(active)
  const [gpsHelpDismissed, setGpsHelpDismissed] = useState(false)

  function openLandmark(sequenceOrder) {
    const detail = game && landmarkDetailView(game, sequenceOrder)
    if (detail) setLandmarkPopup(detail)
  }

  function openSite(id) {
    // id is stashed alongside the card since the dev-only Set GPS button needs it as the site's
    // reference key. From the saved tour pack when there is one; otherwise (pack still
    // downloading) from the server.
    const saved = siteDetailFromPack(id)
    if (saved) { setSitePopup({ ...saved, id }); return }
    api.getSiteDetail(id).then((data) => { if (!data.error) setSitePopup({ ...data, id }) }).catch(() => {})
  }

  function finishGpsDrag(name) {
    setGpsDragTarget(null)
    setGpsDragSavedName(name)
    setTimeout(() => setGpsDragSavedName(null), 1500)
  }

  // Fires once, on drop, with the dropped { lat, lng } (each engine reads it from its own drag
  // event). Saves the correction through the same pipeline the paste-text Set GPS flow uses, then
  // optimistically moves the pin to where it was dropped so the map reflects the fix for the rest
  // of this session, rather than snapping back to the old (wrong) position it would otherwise
  // re-render at.
  function handleSiteGpsDragEnd(site, { lat, lng }) {
    saveGpsCorrection({ type: 'site', id: site.id, name: site.title, enteredGps: `${lat}, ${lng}`, capturedAt: new Date().toISOString() })
    setMovedSites((prev) => ({ ...prev, [site.id]: { latitude: lat, longitude: lng } }))
    finishGpsDrag(site.title)
  }

  function handleLandmarkGpsDragEnd(l, title, { lat, lng }) {
    saveGpsCorrection({ type: 'landmark', sequenceOrder: l.sequenceOrder, name: title, enteredGps: `${lat}, ${lng}`, capturedAt: new Date().toISOString() })
    setMovedLandmarks((prev) => ({ ...prev, [l.sequenceOrder]: { lat, lng } }))
    finishGpsDrag(title)
  }

  // Dev "GPS OK": the pin is right where it's drawn now — saved like a Set GPS fix (so it's in the
  // Export and shows purple in OSM review), position = wherever the map currently shows it.
  function confirmGps(ref, name, pos) {
    saveGpsCorrection({ ...ref, name, enteredGps: `${pos.lat}, ${pos.lng}`, confirmed: true, capturedAt: new Date().toISOString() })
    if (ref.type === 'site') setMovedSites((prev) => ({ ...prev, [ref.id]: { latitude: pos.lat, longitude: pos.lng } }))
    else setMovedLandmarks((prev) => ({ ...prev, [ref.sequenceOrder]: { lat: pos.lat, lng: pos.lng } }))
  }

  // Only while the tour pack hasn't been saved yet — sites from the server, as before.
  useEffect(() => {
    if (pack || fallbackSites) return
    api.getMap().then((res) => {
      if (res?.sites) {
        setFallbackSites(res.sites)
        setLastFetched('map', res)
      }
    }).catch(() => {})
  }, [pack, fallbackSites, connection])

  // A map that failed to load (opened with no signal) gets another go once signal is back.
  const prevConnectionRef = useRef(connection)
  useEffect(() => {
    const cameBack = prevConnectionRef.current === 'offline' && connection === 'online'
    prevConnectionRef.current = connection
    if (cameBack && mapFailed) setMapAttempt((n) => n + 1)
  }, [connection, mapFailed])

  if (!mapData) return <div className="map-shell"><div className="stub-view">Loading map&hellip;</div></div>

  const { solvedLandmarks, sites, currentRevealed } = mapData
  // The revealed-but-in-progress landmark (puzzle solved, quiz pending) counts as "known" for
  // every map-display purpose below — the initial camera fit treats it the same as a fully
  // solved landmark. The only thing it deliberately doesn't do is get its own
  // separate marker treatment or affect scoring (see currentRevealed's own marker further down,
  // and the server's currentRevealedLandmark helper).
  const knownLandmarks = currentRevealed ? [...solvedLandmarks, currentRevealed] : solvedLandmarks
  const hereLocation = liveLocation || placeholderHereLocation(knownLandmarks)
  const pathCoords = knownLandmarks.map((l) => ({ lat: l.latitude, lng: l.longitude }))
  const bounds = boundsFor(pathCoords.length > 0 ? [...pathCoords, hereLocation] : [FALLBACK_CENTER])

  // At game start only the pre-found start landmark is known and nothing else is revealed yet —
  // focus tight on it directly rather than fitting bounds against the (fairly nearby) "here"
  // placeholder point, which used to leave the view zoomed further out than intended for a fresh
  // game. Once a second landmark is solved or revealed, this falls through to the normal
  // fit-everything behavior below.
  const isGameStart = pathCoords.length === 1
  const initialCenter = lastCamera ? lastCamera.center
    : isGameStart ? pathCoords[0]
    : { lat: (bounds.north + bounds.south) / 2, lng: (bounds.east + bounds.west) / 2 }
  const initialZoom = lastCamera ? lastCamera.zoom : isGameStart ? START_LANDMARK_ZOOM : 16
  const shouldFitBounds = !lastCamera && !isGameStart
  const showDots = (zoom ?? initialZoom) < ICON_ZOOM_THRESHOLD
  const showLabels = (zoom ?? initialZoom) >= LABEL_ZOOM_THRESHOLD

  // Every marker on the map: `content` is the pin's own markup, `layer` sets its default stacking,
  // and an explicit zIndex wins over that.
  //
  // Landmarks: zIndex explicit and deliberately huge — at least one POI (Frederick Street Castle
  // View) shares exact coordinates with a landmark by design ("same corner" — see POI.csv), and the
  // coincident site's star pin was silently winning every click on top of it — a real bug caught
  // while testing the reveal feature (on the earlier map engine, whose default zIndex was large
  // and latitude-derived — kept huge so landmarks always win).
  // OSM review (dev only): where each pin is drawn, its colour, and the old-position lines.
  // Set GPS fixes (saved this device, any session) win over everything and show purple.
  const reviewLines = []
  const reviewTally = {}
  const fixes = review ? latestGpsFixes() : null
  function reviewPlace(entry, fix, original, osmPos) {
    const status = fix ? 'purple' : entry?.s
    if (status) reviewTally[status] = (reviewTally[status] || 0) + 1
    if (fix) return { ...fix, color: REVIEW_COLORS.purple }
    if (!entry) return { ...original, color: null }
    if (osmPos && (entry.s === 'amber' || entry.s === 'red')) {
      reviewLines.push({ from: original, to: osmPos, color: REVIEW_COLORS[entry.s] })
    }
    return { ...(osmPos || original), color: REVIEW_COLORS[entry.s] }
  }
  function landmarkPlace(l) {
    const moved = movedLandmarks[l.sequenceOrder]
    const original = moved || { lat: l.latitude, lng: l.longitude }
    if (!review) return { ...original, color: null }
    const e = review.landmarks[l.sequenceOrder]
    const osmPos = e && e.dLat != null ? { lat: l.latitude + e.dLat, lng: l.longitude + e.dLng } : null
    return reviewPlace(e, moved || fixes.landmarks[l.sequenceOrder], original, osmPos)
  }
  function sitePlace(s) {
    const original = { lat: s.latitude, lng: s.longitude }
    if (!review) return { ...original, color: null }
    const e = review.sites[s.id]
    const fix = movedSites[s.id] ? original : fixes.sites[s.id]
    return reviewPlace(e, fix, original, e && e.lat != null ? { lat: e.lat, lng: e.lng } : null)
  }

  const markers = [
    // Solved landmarks — never the current/future one, mapData already excludes it.
    ...solvedLandmarks.map((l) => {
      const place = landmarkPlace(l)
      const dragging = gpsDragTarget?.kind === 'landmark' && gpsDragTarget.sequenceOrder === l.sequenceOrder
      return {
      key: `landmark-${l.sequenceOrder}`,
      layer: 'landmark',
      lat: place.lat,
      lng: place.lng,
      zIndex: 999999,
      draggable: dragging,
      onDragEnd: dragging ? (pos) => handleLandmarkGpsDragEnd(l, gpsDragTarget.title, pos) : undefined,
      onClick: () => openLandmark(l.sequenceOrder),
      content: (
        <div
          data-coach-id={isStartLandmark(l.sequenceOrder) ? 'map-rbs-landmark-marker' : undefined}
          className={'map-pin-landmark' + (dragging ? ' map-pin-site-dragging' : '')}
          style={{ backgroundImage: `url(${API_BASE}/content-photos/${l.imagePath})`, ...(place.color && { borderColor: place.color }) }}
        >
          {!isStartLandmark(l.sequenceOrder) && <div className="map-pin-badge">{landmarkDisplayNumber(l.sequenceOrder)}</div>}
        </div>
      ),
    }
    }),
    // Puzzle solved, quiz not finished yet — same "revealed but in progress" state as the Home tile
    // grid. A real pin at its real location, tapping resumes the quiz rather than opening the
    // detail popup.
    ...(currentRevealed ? [(() => {
      const place = landmarkPlace(currentRevealed)
      const dragging = gpsDragTarget?.kind === 'landmark' && gpsDragTarget.sequenceOrder === currentRevealed.sequenceOrder
      return {
      key: 'landmark-current',
      layer: 'landmark',
      lat: place.lat,
      lng: place.lng,
      zIndex: 999999,
      draggable: dragging,
      onDragEnd: dragging ? (pos) => handleLandmarkGpsDragEnd(currentRevealed, gpsDragTarget.title, pos) : undefined,
      onClick: () => navigate('/play'),
      content: (
        <div className="map-pin-landmark map-pin-landmark-current" style={{ backgroundImage: `url(${API_BASE}/content-photos/${currentRevealed.imagePath})`, ...(place.color && { borderColor: place.color }) }}>
          {!isStartLandmark(currentRevealed.sequenceOrder) && (
            <div className="map-pin-badge map-pin-badge-current">{landmarkDisplayNumber(currentRevealed.sequenceOrder)}</div>
          )}
        </div>
      ),
    }
    })()] : []),
    {
      key: 'here',
      layer: 'here',
      lat: hereLocation.lat,
      lng: hereLocation.lng,
      content: (
        <div className={
          !liveLocation ? 'map-pin-here map-pin-here-fallback'
            : reacquiring ? 'map-pin-here map-pin-here-reacquiring'
            : 'map-pin-here'
        } />
      ),
    },
    ...sites.map((s) => {
      const dragging = gpsDragTarget?.kind === 'site' && gpsDragTarget.id === s.id
      const hasPhoto = Boolean(s.imagePath)
      const place = sitePlace(s)
      const reviewStyle = place.color ? { background: place.color } : undefined
      return {
        key: `site-${s.id}`,
        layer: 'site',
        lat: place.lat,
        lng: place.lng,
        draggable: dragging,
        onDragEnd: dragging ? (pos) => handleSiteGpsDragEnd(s, pos) : undefined,
        onClick: () => openSite(s.id),
        zIndex: dragging ? 999999 : undefined,
        content: showDots ? (
          <div
            data-coach-id="map-poi-marker"
            className={
              'map-dot map-dot-site'
              + (hasPhoto ? '' : ' map-dot-site-nophoto')
              + (dragging ? ' map-pin-site-dragging' : '')
            }
            style={reviewStyle}
          />
        ) : (
          <div
            data-coach-id="map-poi-marker"
            className={
              'map-pin-site'
              + (hasPhoto ? '' : ' map-pin-site-nophoto')
              + (dragging ? ' map-pin-site-dragging' : '')
            }
            style={reviewStyle}
          >
            <StarIcon />
            {showLabels && <span className="map-pin-label">{s.title}</span>}
          </div>
        ),
      }
    }),
  ]

  const engineProps = {
    attempt: mapAttempt,
    initialCenter,
    initialZoom,
    // Only auto-fit the very first time this session — once lastCamera exists, initialCenter/
    // initialZoom above already restore exactly where the player left off, and re-fitting would
    // override that with the generic "show everything" view again.
    fitBounds: shouldFitBounds ? bounds : null,
    markers,
    lines: reviewLines,
    onCamera: ({ center, zoom: z }) => { lastCamera = { center, zoom: z }; setZoom(z); setCameraLat(center.lat) },
    onFailedChange: setMapFailed,
  }

  return (
    <div className="map-shell">
      <div className="map-container" data-coach-id="map-navigation-area">
        <Suspense fallback={<div className="stub-view">Loading map&hellip;</div>}>
          <OsmMapEngine tourCode={game.tour?.tourCode} {...engineProps} />
        </Suspense>

        {mapFailed ? (
          <NearbyList
            landmarks={currentRevealed ? [...solvedLandmarks, currentRevealed] : solvedLandmarks}
            sites={sites}
            here={liveLocation}
            typeLabels={SITE_TYPE_LABELS}
            onOpenLandmark={(seq) => (currentRevealed && seq === currentRevealed.sequenceOrder ? navigate('/play') : openLandmark(seq))}
            onOpenSite={openSite}
          />
        ) : (
          <>
            <MapCompass />
            <MapScaleBar zoom={zoom ?? initialZoom} lat={cameraLat ?? initialCenter.lat} />
          </>
        )}

        {!liveLocation && (gpsError === 'denied' || stalled) && !gpsHelpDismissed && (
          <div className="gps-help-banner">
            Your location isn't showing. If you opened this game from a link in WhatsApp or
            another app, tap the <strong>&bull;&bull;&bull;</strong> or Safari icon in that
            browser and choose <strong>Open in Safari</strong>, then reopen the link there.
            <button type="button" className="ghost" onClick={() => setGpsHelpDismissed(true)}>Dismiss</button>
          </div>
        )}
        {DEV_MODE && osmReviewOn && (
          <div className="osm-review-chip">
            {!review ? 'OSM review: no review data for this tour'
              : ['blue', 'green', 'amber', 'red', 'purple'].map((k) => (
                <span key={k}><i style={{ background: REVIEW_COLORS[k] }} />{reviewTally[k] || 0}</span>
              ))}
          </div>
        )}
        {gpsDragTarget && (
          <div className="gps-drag-banner">
            Drag the pin to its correct position
            <button type="button" className="ghost" onClick={() => setGpsDragTarget(null)}>Cancel</button>
          </div>
        )}
        {gpsDragSavedName && (
          <div className="gps-drag-banner">Saved: {gpsDragSavedName} ✓</div>
        )}
      </div>

      {landmarkPopup && (
        <DetailPopup
          eyebrow={isStartLandmark(landmarkPopup.sequenceOrder) ? 'Starting landmark' : `Landmark ${landmarkDisplayNumber(landmarkPopup.sequenceOrder)}`}
          title={landmarkPopup.title}
          address={landmarkPopup.address}
          imagePath={landmarkPopup.imagePath}
          audioPath={landmarkPopup.audioPath}
          sections={[
            { label: landmarkPopup.aboutLandmarkLabel, text: landmarkPopup.aboutLandmarkText },
            { label: landmarkPopup.aboutSubjectLabel, text: landmarkPopup.aboutSubjectText },
          ]}
          interestingFact={landmarkPopup.interestingFact}
          externalLink={landmarkPopup.externalLink}
          devNote={review ? reviewNote(review.landmarks[landmarkPopup.sequenceOrder], movedLandmarks[landmarkPopup.sequenceOrder] || latestGpsFixes().landmarks[landmarkPopup.sequenceOrder]) : null}
          gpsRef={{ type: 'landmark', sequenceOrder: landmarkPopup.sequenceOrder }}
          onConfirmGps={() => {
            const l = knownLandmarks.find((k) => k.sequenceOrder === landmarkPopup.sequenceOrder)
            if (l) confirmGps({ type: 'landmark', sequenceOrder: l.sequenceOrder }, landmarkPopup.title, landmarkPlace(l))
          }}
          onDragToSetGps={() => setGpsDragTarget({ kind: 'landmark', sequenceOrder: landmarkPopup.sequenceOrder, title: landmarkPopup.title })}
          onClose={() => setLandmarkPopup(null)}
        />
      )}

      {sitePopup && (
        <DetailPopup
          eyebrow={SITE_TYPE_LABELS[sitePopup.type] || 'Point of interest'}
          title={sitePopup.title}
          address={sitePopup.address}
          imagePath={sitePopup.imagePath}
          audioPath={sitePopup.audioPath}
          sections={[
            { label: sitePopup.aboutSiteLabel, text: sitePopup.aboutSiteText },
            { label: sitePopup.aboutSubjectLabel, text: sitePopup.aboutSubjectText },
          ]}
          interestingFact={sitePopup.interestingFact}
          externalLink={sitePopup.externalLink}
          devNote={review ? reviewNote(review.sites[sitePopup.id], movedSites[sitePopup.id] || latestGpsFixes().sites[sitePopup.id]) : null}
          gpsRef={{ type: 'site', id: sitePopup.id }}
          onConfirmGps={() => {
            const s = sites.find((x) => x.id === sitePopup.id)
            if (s) confirmGps({ type: 'site', id: s.id }, sitePopup.title, sitePlace(s))
          }}
          onDragToSetGps={() => setGpsDragTarget({ kind: 'site', id: sitePopup.id })}
          onClose={() => setSitePopup(null)}
        />
      )}
    </div>
  )
}
