import { useLayoutEffect, useRef, useState } from 'react'

const GAP = 8
const MARGIN = 12

// General rule for every popup in the game: open just below the element that triggered it,
// or above it if there isn't room below. anchorRect is a plain {top,bottom,left,width,height}
// snapshot (from the trigger's getBoundingClientRect()) taken at click time.
export default function AnchoredPopup({ anchorRect, onClose, className = '', children }) {
  const cardRef = useRef(null)
  const [style, setStyle] = useState({ visibility: 'hidden' })

  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card || !anchorRect) return

    const cardHeight = card.offsetHeight
    const cardWidth = card.offsetWidth
    const viewportHeight = window.innerHeight
    const viewportWidth = window.innerWidth

    const spaceBelow = viewportHeight - anchorRect.bottom
    const spaceAbove = anchorRect.top
    const placeBelow = spaceBelow >= cardHeight + GAP || spaceBelow >= spaceAbove

    const top = placeBelow
      ? Math.min(anchorRect.bottom + GAP, viewportHeight - cardHeight - MARGIN)
      : Math.max(anchorRect.top - GAP - cardHeight, MARGIN)

    let left = anchorRect.left + anchorRect.width / 2 - cardWidth / 2
    left = Math.max(MARGIN, Math.min(left, viewportWidth - cardWidth - MARGIN))

    setStyle({ position: 'fixed', top, left, visibility: 'visible' })
  }, [anchorRect])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={cardRef} className={`modal-card ${className}`} style={style} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}
