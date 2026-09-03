import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { APIProvider, Map, AdvancedMarker, Polyline, useMap, useMapsLibrary, useAdvancedMarkerRef } from '@vis.gl/react-google-maps'
import { Utensils, Coffee, Martini, Toilet, Plus } from 'lucide-react'
import { api } from '../api.js'
import AnchoredPopup from './AnchoredPopup.jsx'
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

// Placeholder only — real GPS tracking is a post-MVP feature (see project-architecture memory).
// Renders "you are here" a short fixed offset from the most recently solved landmark, so the
// mockup's marker exists visually without pretending to be a live position.
function placeholderHereLocation(solvedLandmarks) {
  if (solvedLandmarks.length === 0) return FALLBACK_CENTER
  const last = solvedLandmarks[solvedLandmarks.length - 1]
  return { lat: last.latitude + 0.0015, lng: last.longitude + 0.001 }
}

// Game start (only the pre-found start landmark solved) should open focused tight on it, not
// zoomed out to fit a bounding box against the "here" placeholder point — tune this once real
// zoom feedback comes in.
const START_LANDMARK_ZOOM = 17

// Below this zoom, Interests/Amenities/POI Drafts render as small plain-color dots instead of
// their full icon pins — standard practice on zooming maps (Google's own POI layer, Airbnb, etc.
// all simplify markers below some threshold rather than letting a dense area turn into a wall of
// overlapping icons). 17 matches START_LANDMARK_ZOOM's already-established "close, street-level"
// feel; not yet tuned against a real dense cluster, adjust after seeing it live. Landmarks are
// deliberately exempt — there are only ever a handful of them, so they never crowd the way
// POIs/amenities can.
const ICON_ZOOM_THRESHOLD = 17

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

// Five amenity icons, all real icons from lucide-react (MIT-licensed) rather than hand-drawn —
// deliberately a small, fixed set (not one per Places sub-type) but enough to tell a restaurant,
// bar and cafe apart at a glance. Toilet renders a touch larger than the others (settled after
// visual review), and pharmacy keeps its plus-sign concept but now Lucide's own clean two-line
// Plus rather than a hand-drawn cross.
const CATEGORY_ICONS = {
  restaurant: () => <Utensils color="#fff" size={16} strokeWidth={2} />,
  cafe: () => <Coffee color="#fff" size={16} strokeWidth={2} />,
  bar: () => <Martini color="#fff" size={16} strokeWidth={2} />,
  toilet: () => <Toilet color="#fff" size={19} strokeWidth={2} />,
  pharmacy: () => <Plus color="#fff" size={16} strokeWidth={2.5} />,
}
const CATEGORY_LABELS = { restaurant: 'Restaurant', cafe: 'Cafe', bar: 'Bar', toilet: 'Toilet', pharmacy: 'Pharmacy' }
// Pharmacy (green) and toilet (blue, rounded square) borrow real-world signage colors/shape —
// same off-palette-exception logic already used for the "here" marker's blue. Everything else
// (restaurant/cafe/bar) shares one brighter red, replacing the original muted-grey treatment.
const CATEGORY_PIN_CLASS = {
  pharmacy: 'map-pin-poi map-pin-poi-pharmacy',
  toilet: 'map-pin-poi map-pin-poi-toilet',
}
// Same category colors, zoomed-out dot form — see ICON_ZOOM_THRESHOLD.
const CATEGORY_DOT_CLASS = {
  pharmacy: 'map-dot map-dot-amenity-pharmacy',
  toilet: 'map-dot map-dot-amenity-toilet',
}

// Buckets Google's specific primaryType (there are ~170 possible Food and Drink sub-types alone)
// down into the 5 icon categories above — a deliberately small, fixed set rather than one icon
// per sub-type, but still enough to distinguish e.g. a restaurant from a bar from a cafe.
function poiCategory(primaryType) {
  const t = primaryType || ''
  if (t === 'public_bathroom' || t === 'public_bath') return 'toilet'
  if (t === 'pharmacy' || t === 'drugstore') return 'pharmacy'
  if (/bar|pub|brewery|wine|cocktail|beer|night_club/.test(t)) return 'bar'
  if (/cafe|coffee|bakery|bagel|tea_house|juice|dessert|ice_cream|donut|pastry|chocolate|candy/.test(t)) return 'cafe'
  return 'restaurant'
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

const BUSINESS_STATUS_LABELS = {
  OPERATIONAL: 'Open',
  CLOSED_TEMPORARILY: 'Temporarily closed',
  CLOSED_PERMANENTLY: 'Permanently closed',
}

// In-progress content-sourcing review layer (see feedback-content-sourcing-process memory) — not
// real game content yet. Deliberately styled off the game's palette (dashed brick outline, plain
// white fill), same "not game content" language already used for the Dev-tools menu, so it can't
// be mistaken for a curated Interest or a live Amenity while scattered on the map for review.
function DraftMarker({ poi, onOpen, showDots }) {
  return (
    <AdvancedMarker position={{ lat: poi.latitude, lng: poi.longitude }} onClick={() => onOpen(poi)}>
      {showDots ? <div className="map-dot map-dot-draft" /> : <div className="map-pin-draft">{poi.interestRating}</div>}
    </AdvancedMarker>
  )
}

// A plain onClick on a <div> nested inside AdvancedMarker is unreliable — the marker's own
// custom-element wrapper can intercept the pointer event before it reaches a nested child (this
// was a real bug: taps silently did nothing). AdvancedMarker's own `onClick` prop is the
// supported, reliable way in (already used for landmark pins) — this needs `useAdvancedMarkerRef`
// too, since the popup needs the marker's actual screen position to anchor itself, which a
// google.maps.marker.AdvancedMarkerClickEvent doesn't hand you directly the way a DOM event would.
function AmenityMarker({ place, onOpen, showDots }) {
  const [markerRef, marker] = useAdvancedMarkerRef()
  const category = poiCategory(place.primaryType)
  const Icon = CATEGORY_ICONS[category]
  const pinClass = CATEGORY_PIN_CLASS[category] || 'map-pin-poi'
  const dotClass = CATEGORY_DOT_CLASS[category] || 'map-dot map-dot-amenity'

  return (
    <AdvancedMarker
      ref={markerRef}
      position={{ lat: place.latitude, lng: place.longitude }}
      onClick={() => {
        const rect = marker.getBoundingClientRect()
        onOpen({ place, category, anchor: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height } })
      }}
    >
      {showDots ? <div className={dotClass} /> : <div className={pinClass}><Icon /></div>}
    </AdvancedMarker>
  )
}

function FilterChip({ active, onClick, children }) {
  return (
    <button className={active ? 'filter-chip filter-chip-active' : 'filter-chip'} onClick={onClick}>
      {active && <span className="filter-chip-tick">&#10003;</span>}
      {children}
    </button>
  )
}

export default function MapView() {
  const navigate = useNavigate()
  const [mapData, setMapData] = useState(null)
  const [routeLegs, setRouteLegs] = useState(null)
  // All three layers default on — landmarks/interests are our own content (free to show), and the
  // amenities layer is meant to feel like the map is "complete" the moment you open it.
  const [filters, setFilters] = useState({ landmarks: true, interests: true, amenities: true, poiDrafts: true })
  const [places, setPlaces] = useState(null)
  const [poiPopup, setPoiPopup] = useState(null)
  const [poiDrafts, setPoiDrafts] = useState(null)
  const [draftPopup, setDraftPopup] = useState(null)
  const [landmarkPopup, setLandmarkPopup] = useState(null)
  const [sitePopup, setSitePopup] = useState(null)
  // Tracks camera zoom so Interests/Amenities/POI Drafts can simplify to dots below
  // ICON_ZOOM_THRESHOLD — seeded from lastCamera so a returning player doesn't get a one-frame
  // flash of the wrong marker style before the first onCameraChanged fires.
  const [zoom, setZoom] = useState(lastCamera?.zoom ?? null)

  function openLandmark(sequenceOrder) {
    api.getLandmarkDetail(sequenceOrder).then((data) => { if (!data.error) setLandmarkPopup(data) })
  }

  function openSite(id) {
    // id isn't echoed back by the API response — stashed alongside it here since the dev-only
    // Set GPS button needs it as the site's reference key.
    api.getSiteDetail(id).then((data) => { if (!data.error) setSitePopup({ ...data, id }) })
  }

  useEffect(() => {
    api.getMap().then(setMapData)
    api.getRoute().then((res) => setRouteLegs(res.legs || []))
    // Amenities layer defaults on, so its data has to load up front too, not just on toggle.
    loadPlaces()
    // POI Drafts also defaults on — it's a review layer, the whole point is seeing it immediately.
    api.getPoiDrafts().then((res) => setPoiDrafts(res.pois))
  }, [])

  // Restaurants/cafes/bars + toilets + pharmacies, one combined Places category — fetched once
  // (on mount, since it defaults on) and kept in state so toggling it off/back on is free.
  async function loadPlaces() {
    const res = await api.getNearbyPlaces('google')
    setPlaces(res.places)
  }

  function toggleFilter(key) {
    setFilters((f) => ({ ...f, [key]: !f[key] }))
    if (key === 'amenities' && places === null) loadPlaces()
  }

  if (!mapData) return <div className="map-shell"><div className="stub-view">Loading map&hellip;</div></div>

  const { solvedLandmarks, sites, currentRevealed } = mapData
  // The revealed-but-in-progress landmark (puzzle solved, quiz pending) counts as "known" for
  // every map-display purpose below — the walking path, the "here" connector, and the initial
  // camera fit all treat it the same as a fully solved landmark. The only thing it deliberately
  // doesn't do is get its own separate marker treatment or affect scoring (see currentRevealed's
  // own marker further down, and the server's currentRevealedLandmark helper).
  const knownLandmarks = currentRevealed ? [...solvedLandmarks, currentRevealed] : solvedLandmarks
  const lastKnown = knownLandmarks[knownLandmarks.length - 1]
  const hereLocation = placeholderHereLocation(knownLandmarks)
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

  return (
    <div className="map-shell">
      <div className="filter-chips">
        <FilterChip active={filters.landmarks} onClick={() => toggleFilter('landmarks')}>Landmarks</FilterChip>
        <FilterChip active={filters.interests} onClick={() => toggleFilter('interests')}>Interests</FilterChip>
        <FilterChip active={filters.amenities} onClick={() => toggleFilter('amenities')}>Amenities</FilterChip>
        <FilterChip active={filters.poiDrafts} onClick={() => toggleFilter('poiDrafts')}>POI Drafts</FilterChip>
      </div>

      <div className="map-container">
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

            {filters.landmarks && (
              <>
                <WalkingPath legs={routeLegs} fallbackPath={pathCoords} />
                {lastKnown && (
                  <Polyline
                    path={[{ lat: lastKnown.latitude, lng: lastKnown.longitude }, hereLocation]}
                    strokeColor="#3d6b8c"
                    strokeOpacity={0}
                    strokeWeight={2}
                    icons={[DASH_ICON]}
                  />
                )}
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
                    <div className="map-pin-landmark" style={{ backgroundImage: `url(/content-photos/${l.imagePath})` }}>
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
                    <div className="map-pin-landmark map-pin-landmark-current" style={{ backgroundImage: `url(/content-photos/${currentRevealed.imagePath})` }}>
                      {!isStartLandmark(currentRevealed.sequenceOrder) && (
                        <div className="map-pin-badge map-pin-badge-current">{landmarkDisplayNumber(currentRevealed.sequenceOrder)}</div>
                      )}
                    </div>
                  </AdvancedMarker>
                )}
                <AdvancedMarker position={hereLocation}>
                  <div className="map-pin-here" />
                </AdvancedMarker>
              </>
            )}

            {filters.interests && sites.map((s) => (
              <AdvancedMarker
                key={s.id}
                position={{ lat: s.latitude, lng: s.longitude }}
                onClick={() => openSite(s.id)}
              >
                {showDots ? <div className="map-dot map-dot-site" /> : (
                  <div className="map-pin-site">
                    <StarIcon />
                  </div>
                )}
              </AdvancedMarker>
            ))}

            {filters.amenities && places && places.map((p) => (
              <AmenityMarker key={p.id} place={p} onOpen={setPoiPopup} showDots={showDots} />
            ))}

            {filters.poiDrafts && poiDrafts && poiDrafts.map((poi, i) => (
              <DraftMarker key={i} poi={poi} onOpen={setDraftPopup} showDots={showDots} />
            ))}
          </Map>
        </APIProvider>
      </div>

      {poiPopup && (
        <AnchoredPopup anchorRect={poiPopup.anchor} onClose={() => setPoiPopup(null)} className="poi-popup">
          <div className="poi-popup-type">{CATEGORY_LABELS[poiPopup.category]}</div>
          <h3>{poiPopup.place.name}</h3>
          {poiPopup.place.address && <p className="poi-popup-address">{poiPopup.place.address}</p>}
          {poiPopup.place.businessStatus && (
            <p className={poiPopup.place.businessStatus === 'OPERATIONAL' ? 'poi-popup-status poi-popup-status-open' : 'poi-popup-status'}>
              {BUSINESS_STATUS_LABELS[poiPopup.place.businessStatus] || poiPopup.place.businessStatus}
            </p>
          )}
          {poiPopup.place.mapsUri && (
            <a className="primary" href={poiPopup.place.mapsUri} target="_blank" rel="noreferrer">View on Google Maps</a>
          )}
        </AnchoredPopup>
      )}

      {draftPopup && (
        <DetailPopup
          title={draftPopup.name}
          address={draftPopup.address}
          imagePath={draftPopup.imagePath}
          sections={[{ label: null, text: draftPopup.description }]}
          interestingFact={draftPopup.interestingFact}
          warning={draftPopup.geocodeConfidence !== 'confirmed' ? `Approximate pin: ${draftPopup.geocodeConfidence}` : null}
          externalLink={draftPopup.externalLink}
          gpsRef={{ type: 'poiDraft', leg: draftPopup.leg }}
          onClose={() => setDraftPopup(null)}
        />
      )}

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
          onClose={() => setSitePopup(null)}
        />
      )}
    </div>
  )
}
