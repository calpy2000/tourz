import { useState } from 'react'
import { DEV_MODE } from '../devMode.js'
import { API_BASE } from '../apiBase.js'
import { rectFromEvent } from '../rect.js'
import { saveGpsCorrection } from '../gpsCorrections.js'
import SetGpsPanel from './SetGpsPanel.jsx'

// Shared detail popup for landmarks, sites ("Interests"), and POI drafts — one format for all
// three, settled after comparing this against the old two-card full-page layout (see
// project-landmark-detail-feature memory for that earlier version). Deliberately self-positioned
// (fixed inset, 12px margin on three sides + clearance above the chat panel) rather than anchored
// to whatever was tapped — at this size it reads as a modal regardless, so callers don't need to
// pass a click position the way the small amenity popup still does.
//
// `gpsRef` (dev mode only) identifies which record a GPS correction captured here belongs to —
// e.g. { type: 'landmark', sequenceOrder } — since landmarks/sites/POI drafts have no shared id
// shape. Omit it for anything the Set GPS button shouldn't appear on.
export default function DetailPopup({ eyebrow, title, address, imagePath, sections, interestingFact, warning, externalLink, gpsRef, onClose }) {
  const [gpsPanelAnchor, setGpsPanelAnchor] = useState(null)
  const [gpsSaved, setGpsSaved] = useState(false)

  function handleGpsSubmit(enteredGps) {
    saveGpsCorrection({ ...gpsRef, name: title, enteredGps, capturedAt: new Date().toISOString() })
    setGpsPanelAnchor(null)
    setGpsSaved(true)
    setTimeout(() => setGpsSaved(false), 1500)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card detail-popup" onClick={(e) => e.stopPropagation()}>
        <button className="detail-popup-back" onClick={onClose} aria-label="Back">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#23201b" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
        </button>

        {imagePath && (
          <img className="detail-popup-image" src={`${API_BASE}/content-photos/${imagePath}`} alt={title} />
        )}

        <div className={imagePath ? 'detail-popup-body' : 'detail-popup-body detail-popup-body-no-image'}>
          {eyebrow && <div className="detail-popup-eyebrow">{eyebrow}</div>}
          <h3>{title}</h3>
          {address && <p className="poi-popup-address">{address}</p>}
          {/* A label is only useful to tell two sections apart — with just one (most sites/POI
              drafts), showing it anyway was the wrong call from the format-comparison mockup:
              it reads as a redundant heading on a single paragraph. Only landmarks/richer sites
              with a genuine second "about" section keep their labels. */}
          {(() => {
            const filled = sections.filter((s) => s.text)
            return filled.map((s, i) => (
              <div key={i}>
                {s.label && filled.length > 1 && <p className="field-label">{s.label}</p>}
                <p>{s.text}</p>
              </div>
            ))
          })()}
          {interestingFact && (
            <p><strong>Interesting fact:</strong> {interestingFact}</p>
          )}
          {warning && <p className="detail-popup-warning">{warning}</p>}
        </div>

        {(externalLink || (DEV_MODE && gpsRef)) && (
          <div className="detail-popup-footer">
            {externalLink && (
              <a className="primary detail-popup-link" href={externalLink} target="_blank" rel="noreferrer">
                Read more
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#23201b" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline></svg>
              </a>
            )}
            {DEV_MODE && gpsRef && (
              <button
                type="button"
                className="primary detail-popup-setgps"
                onClick={(e) => setGpsPanelAnchor(rectFromEvent(e))}
              >
                {gpsSaved ? 'Saved ✓' : 'Set GPS'}
              </button>
            )}
          </div>
        )}

        {gpsPanelAnchor && (
          <SetGpsPanel
            anchorRect={gpsPanelAnchor}
            onSubmit={handleGpsSubmit}
            onClose={() => setGpsPanelAnchor(null)}
          />
        )}
      </div>
    </div>
  )
}
