import { useEffect } from 'react'
import { APIProvider, Map, AdvancedMarker, useMap, useApiLoadingStatus, APILoadingStatus } from '@vis.gl/react-google-maps'

// The original Google map — kept behind the Dev menu's "Map: Google" until the OSM map
// (OsmMapEngine) is proven on a real walk, then deleted along with @vis.gl/react-google-maps and
// the VITE_GOOGLE_MAPS_* keys. Same props as OsmMapEngine; see MapView for what they mean.

// Google's map script can't work with no signal (Google's terms forbid saving its map for offline
// use). Reports when it fails to load — opening the app in a dead spot — so MapView can show the
// NearbyList of cards instead of an empty box. Renders nothing.
function MapLoadStatus({ onFailedChange }) {
  const status = useApiLoadingStatus()
  const failed = status === APILoadingStatus.FAILED || status === APILoadingStatus.AUTH_FAILURE
  useEffect(() => { onFailedChange(failed) }, [failed, onFailedChange])
  return null
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

export default function GoogleMapEngine({ attempt, initialCenter, initialZoom, fitBounds, markers, onCamera, onFailedChange }) {
  return (
    <APIProvider key={attempt} apiKey={import.meta.env.VITE_GOOGLE_MAPS_API_KEY}>
      <MapLoadStatus onFailedChange={onFailedChange} />
      <Map
        mapId={import.meta.env.VITE_GOOGLE_MAPS_MAP_ID}
        // Keeps the google.maps.Map instance (and its already-drawn tiles) in a pool when
        // MapView unmounts and hands it back on the next mount, instead of building a fresh
        // map every MAP <-> CURRENT toggle — a new map with a mapId takes ~1s before any
        // AdvancedMarker can attach, which is the delay this removes.
        reuseMaps
        defaultCenter={initialCenter}
        defaultZoom={initialZoom}
        disableDefaultUI
        gestureHandling="greedy"
        onCameraChanged={(e) => onCamera({ center: e.detail.center, zoom: e.detail.zoom })}
      >
        {fitBounds && <FitBounds bounds={fitBounds} />}
        {markers.map((m) => (
          <AdvancedMarker
            key={m.key}
            position={{ lat: m.lat, lng: m.lng }}
            onClick={m.onClick}
            zIndex={m.zIndex}
            draggable={m.draggable}
            // `event` is the raw google.maps 'dragend' MapMouseEvent — event.latLng is the only
            // place the dropped position is observable (AdvancedMarkerElement doesn't sync its
            // `position` prop while draggable).
            onDragEnd={m.onDragEnd ? (e) => m.onDragEnd({ lat: e.latLng.lat(), lng: e.latLng.lng() }) : undefined}
          >
            {m.content}
          </AdvancedMarker>
        ))}
      </Map>
    </APIProvider>
  )
}
