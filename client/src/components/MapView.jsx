import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { APIProvider, Map, AdvancedMarker, Polyline, useMap, useMapsLibrary } from '@vis.gl/react-google-maps'
import { api } from '../api.js'
import { API_BASE } from '../apiBase.js'
import { useGeolocation } from '../useGeolocation.js'
import { saveGpsCorrection } from '../gpsCorrections.js'
import DetailPopup from './DetailPopup.jsx'
import { isStartLandmark, landmarkDisplayNumber } from '../landmarkNumber.js'

// Used only if the team has no solved landmarks yet (map needs some center before the first find).
const FALLBACK_CENTER = { lat: 55.9535, lng: -3.197 }

// Module-level (not component state) so it survives MapView unmounting entirely — navigating to
// a landmark/site detail page and back remounts MapView from scratch, and without this the map
// would re-run its initial fit-to-bounds every time instead of reopening exactly where the
// player left it. Resets on a full page reload, which is fine — this is "remember within this
// visit," not something that needs to survive that.
let lastCamera = null // { center: {lat,lng}, zoom }

// Google Maps polylines have no native "dashed" stroke — the standard technique is a solid
// line with strokeOpacity 0, plus a short line symbol repeated along the path instead.
const DASH_ICON = { icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 }, offset: '0', repeat: '12px' }

// Fallback only — used when the browser's real GPS (useGeolocation) hasn't produced a fix yet,
// or is unsupported/denied. Renders "you are here" a short fixed offset from the most recently
// solved landmark, so the marker exists visually rather than the layer having nothing to show.
function placeholderHereLocation(solvedLandmarks) {
  if (solvedLandmarks.length === 0) return FALLBACK_CENTER
  const last = solvedLandmarks[solvedLandmarks.length - 1]
  return { lat: last.latitude + 0.0015, lng: last.longitude + 0.001 }
}

// Game start (only the pre-found start landmark solved) should open focused tight on it, not
// zoomed out to fit a bounding box against the "here" placeholder point — tune this once real
// zoom feedback comes in.
const START_LANDMARK_ZOOM = 17

// Below this zoom, Interests render as small plain-color dots instead of their full star pin —
// standard practice on zooming maps (Google's own POI layer, Airbnb, etc. all simplify markers
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

// The Map component's `defaultBounds` prop fits once at mount, before the container has settled
// into its final flex-layout size — it visibly over-zooms-out here as a result. Calling
// map.fitBounds() directly via useMap() runs after the map instance (and its real size) exist,
// which fits correctly. Renders nothing — it's a side-effect-only child of <Map>.
function FitBounds({ bounds }) {
  const map = useMap()
  useEffect(() => {
    if (map) map.fitBounds(bounds, 56)
  }, [map, JSON.stringify(bounds)])
  return null
}

// Real walking-route polyline between solved landmarks, one leg at a time (server sends one
// encoded polyline per consecutive pair — see /api/game/route). Falls back to the straight
// "as the crow flies" line while the route is still loading, or if it fails to load at all, so
// there's always some path shown rather than nothing.
function WalkingPath({ legs, fallbackPath }) {
  const geometry = useMapsLibrary('geometry')

  if (legs && legs.length > 0 && geometry) {
    return legs.map((encoded, i) => (
      <Polyline
        key={i}
        path={geometry.encoding.decodePath(encoded)}
        strokeColor="#b8823a"
        strokeOpacity={0}
        strokeWeight={3}
        icons={[DASH_ICON]}
      />
    ))
  }

  if (fallbackPath.length > 1) {
    return <Polyline path={fallbackPath} strokeColor="#b8823a" strokeOpacity={0} strokeWeight={3} icons={[DASH_ICON]} />
  }

  return null
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

export default function MapView() {
  const navigate = useNavigate()
  const [mapData, setMapData] = useState(null)
  const [routeLegs, setRouteLegs] = useState(null)
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
  const { location: liveLocation, reacquiring } = useGeolocation()

  function openLandmark(sequenceOrder) {
    api.getLandmarkDetail(sequenceOrder).then((data) => { if (!data.error) setLandmarkPopup(data) })
  }

  function openSite(id) {
    // id isn't echoed back by the API response — stashed alongside it here since the dev-only
    // Set GPS button needs it as the site's reference key.
    api.getSiteDetail(id).then((data) => { if (!data.error) setSitePopup({ ...data, id }) })
  }

  function finishGpsDrag(name) {
    setGpsDragTarget(null)
    setGpsDragSavedName(name)
    setTimeout(() => setGpsDragSavedName(null), 1500)
  }

  // Fires once, on drop. `event` is the raw google.maps 'dragend' MapMouseEvent — event.latLng is
  // the only place the corrected position is observable (AdvancedMarkerElement doesn't sync its
  // `position` prop while draggable). Saves the correction through the same pipeline the
  // paste-text Set GPS flow uses, then optimistically moves the pin to where it was dropped so the
  // map reflects the fix for the rest of this session, rather than snapping back to the old
  // (wrong) position it would otherwise re-render at.
  function handleSiteGpsDragEnd(site, event) {
    const lat = event.latLng.lat()
    const lng = event.latLng.lng()
    saveGpsCorrection({ type: 'site', id: site.id, name: site.title, enteredGps: `${lat}, ${lng}`, capturedAt: new Date().toISOString() })
    setMapData((prev) => ({ ...prev, sites: prev.sites.map((s) => (s.id === site.id ? { ...s, latitude: lat, longitude: lng } : s)) }))
    finishGpsDrag(site.title)
  }

  useEffect(() => {
    api.getMap().then(setMapData)
    api.getRoute().then((res) => setRouteLegs(res.legs || []))
  }, [])

  if (!mapData) return <div className="map-shell"><div className="stub-view">Loading map&hellip;</div></div>

  const { solvedLandmarks, sites, currentRevealed } = mapData
  // The revealed-but-in-progress landmark (puzzle solved, quiz pending) counts as "known" for
  // every map-display purpose below — the walking path and the initial camera fit both treat it
  // the same as a fully solved landmark. The only thing it deliberately doesn't do is get its own
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

  return (
    <div className="map-shell">
      <div className="map-container" data-coach-id="map-navigation-area">
        <APIProvider apiKey={import.meta.env.VITE_GOOGLE_MAPS_API_KEY}>
          <Map
            mapId={import.meta.env.VITE_GOOGLE_MAPS_MAP_ID}
            defaultCenter={initialCenter}
            defaultZoom={initialZoom}
            disableDefaultUI
            gestureHandling="greedy"
            onCameraChanged={(e) => { lastCamera = { center: e.detail.center, zoom: e.detail.zoom }; setZoom(e.detail.zoom) }}
          >
            {/* Only auto-fit the very first time this session — once lastCamera exists, the
                defaultCenter/defaultZoom above already restore exactly where the player left off,
                and re-fitting would override that with the generic "show everything" view again. */}
            {shouldFitBounds && <FitBounds bounds={bounds} />}

            <WalkingPath legs={routeLegs} fallbackPath={pathCoords} />
            {/* Solved landmarks — never the current/future one, mapData already excludes it.
                zIndex explicit and deliberately huge: at least one POI (Frederick Street
                Castle View) shares exact coordinates with a landmark by design ("same corner"
                — see POI.csv), and the coincident site's star pin was silently winning every
                click on top of it — a real bug caught while testing the reveal feature.
                Google's own default zIndex (when unset) is computed from latitude and was
                already bigger than a modest explicit value like 10; this has to clear that. */}
            {solvedLandmarks.map((l) => (
              <AdvancedMarker
                key={l.sequenceOrder}
                position={{ lat: l.latitude, lng: l.longitude }}
                onClick={() => openLandmark(l.sequenceOrder)}
                zIndex={999999}
              >
                <div
                  data-coach-id={isStartLandmark(l.sequenceOrder) ? 'map-rbs-landmark-marker' : undefined}
                  className="map-pin-landmark"
                  style={{ backgroundImage: `url(${API_BASE}/content-photos/${l.imagePath})` }}
                >
                  {!isStartLandmark(l.sequenceOrder) && <div className="map-pin-badge">{landmarkDisplayNumber(l.sequenceOrder)}</div>}
                </div>
              </AdvancedMarker>
            ))}
            {/* Puzzle solved, quiz not finished yet — same "revealed but in progress" state
                as the Home tile grid. A real pin at its real location (kept separate from
                solvedLandmarks so it doesn't extend the walking path), tapping resumes the
                quiz rather than opening the detail popup. */}
            {currentRevealed && (
              <AdvancedMarker
                position={{ lat: currentRevealed.latitude, lng: currentRevealed.longitude }}
                onClick={() => navigate('/play')}
                zIndex={999999}
              >
                <div className="map-pin-landmark map-pin-landmark-current" style={{ backgroundImage: `url(${API_BASE}/content-photos/${currentRevealed.imagePath})` }}>
                  {!isStartLandmark(currentRevealed.sequenceOrder) && (
                    <div className="map-pin-badge map-pin-badge-current">{landmarkDisplayNumber(currentRevealed.sequenceOrder)}</div>
                  )}
                </div>
              </AdvancedMarker>
            )}
            <AdvancedMarker position={hereLocation}>
              <div className={
                !liveLocation ? 'map-pin-here map-pin-here-fallback'
                  : reacquiring ? 'map-pin-here map-pin-here-reacquiring'
                  : 'map-pin-here'
              } />
            </AdvancedMarker>

            {sites.map((s) => {
              const dragging = gpsDragTarget?.kind === 'site' && gpsDragTarget.id === s.id
              return (
                <AdvancedMarker
                  key={s.id}
                  position={{ lat: s.latitude, lng: s.longitude }}
                  draggable={dragging}
                  onDragEnd={dragging ? (e) => handleSiteGpsDragEnd(s, e) : undefined}
                  onClick={() => openSite(s.id)}
                  zIndex={dragging ? 999999 : undefined}
                >
                  {showDots ? <div data-coach-id="map-poi-marker" className={dragging ? 'map-dot map-dot-site map-pin-site-dragging' : 'map-dot map-dot-site'} /> : (
                    <div data-coach-id="map-poi-marker" className={dragging ? 'map-pin-site map-pin-site-dragging' : 'map-pin-site'}>
                      <StarIcon />
                      {showLabels && <span className="map-pin-label">{s.title}</span>}
                    </div>
                  )}
                </AdvancedMarker>
              )
            })}
          </Map>
        </APIProvider>

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
          sections={[
            { label: landmarkPopup.aboutLandmarkLabel, text: landmarkPopup.aboutLandmarkText },
            { label: landmarkPopup.aboutSubjectLabel, text: landmarkPopup.aboutSubjectText },
          ]}
          interestingFact={landmarkPopup.interestingFact}
          externalLink={landmarkPopup.externalLink}
          gpsRef={{ type: 'landmark', sequenceOrder: landmarkPopup.sequenceOrder }}
          onClose={() => setLandmarkPopup(null)}
        />
      )}

      {sitePopup && (
        <DetailPopup
          eyebrow={SITE_TYPE_LABELS[sitePopup.type] || 'Point of interest'}
          title={sitePopup.title}
          address={sitePopup.address}
          imagePath={sitePopup.imagePath}
          sections={[
            { label: sitePopup.aboutSiteLabel, text: sitePopup.aboutSiteText },
            { label: sitePopup.aboutSubjectLabel, text: sitePopup.aboutSubjectText },
          ]}
          interestingFact={sitePopup.interestingFact}
          externalLink={sitePopup.externalLink}
          gpsRef={{ type: 'site', id: sitePopup.id }}
          onDragToSetGps={() => setGpsDragTarget({ kind: 'site', id: sitePopup.id })}
          onClose={() => setSitePopup(null)}
        />
      )}
    </div>
  )
}
