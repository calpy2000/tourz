import { API_BASE } from '../apiBase.js'
import { isStartLandmark, landmarkDisplayNumber } from '../landmarkNumber.js'

// Shown in place of the map when Google's map script can't load — i.e. the app was opened (or
// reopened) with no signal, since Google's map can't be saved for offline use. Every card it opens
// is already on the phone (landmarks from the game state, POIs from the tour pack), so without this
// list they'd be saved but unreachable (found on the 2026-10-19 airplane-mode phone test). Sorted
// nearest first from the live GPS position — GPS works with no signal — or, before a fix arrives,
// landmarks in tour order then POIs alphabetically. Interim until a real offline map (see
// project-osm-migration-plan memory).

function distanceMetres(a, b) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function formatDistance(m) {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`
  return `${(m / 1000).toFixed(1)} km`
}

export default function NearbyList({ landmarks, sites, here, typeLabels, onOpenLandmark, onOpenSite }) {
  const items = [
    ...landmarks.map((l) => ({
      key: `l${l.sequenceOrder}`,
      kind: 'landmark',
      ref: l.sequenceOrder,
      title: l.title,
      label: isStartLandmark(l.sequenceOrder) ? 'Starting landmark' : `Landmark ${landmarkDisplayNumber(l.sequenceOrder)}`,
      imagePath: l.imagePath,
      lat: l.latitude,
      lng: l.longitude,
    })),
    ...sites.map((s) => ({
      key: `s${s.id}`,
      kind: 'site',
      ref: s.id,
      title: s.title,
      label: typeLabels[s.type] || 'Point of interest',
      imagePath: s.imagePath,
      lat: s.latitude,
      lng: s.longitude,
    })),
  ].map((item) => ({ ...item, distance: here ? distanceMetres(here, item) : null }))

  if (here) items.sort((a, b) => a.distance - b.distance)
  else items.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'landmark' ? -1 : 1) : a.kind === 'landmark' ? a.ref - b.ref : a.title.localeCompare(b.title)))

  return (
    <div className="nearby-list">
      <p className="nearby-list-intro">
        The map needs signal to load. Here&rsquo;s what&rsquo;s {here ? 'nearest to you' : 'on the tour'} instead &mdash; tap any one for its card.
      </p>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className="nearby-item"
          onClick={() => (item.kind === 'landmark' ? onOpenLandmark(item.ref) : onOpenSite(item.ref))}
        >
          {item.imagePath ? (
            <img className="nearby-item-photo" src={`${API_BASE}/content-photos/${item.imagePath}`} alt="" loading="lazy" />
          ) : (
            <span className="nearby-item-photo nearby-item-photo-none" aria-hidden="true">&#9733;</span>
          )}
          <span className="nearby-item-text">
            <span className="nearby-item-label">{item.label}</span>
            <span className="nearby-item-title">{item.title}</span>
          </span>
          {item.distance != null && <span className="nearby-item-distance">{formatDistance(item.distance)}</span>}
        </button>
      ))}
    </div>
  )
}
