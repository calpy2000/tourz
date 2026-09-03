import AnchoredPopup from './AnchoredPopup.jsx'

export default function DevMenu({ anchorRect, actions, onClose }) {
  return (
    <AnchoredPopup anchorRect={anchorRect} onClose={onClose} className="dev-menu">
      <div className="dev-menu-label">Dev tools</div>
      {actions.map((action) => (
        <button
          key={action.label}
          className="dev-menu-item"
          onClick={() => {
            onClose()
            action.onClick()
          }}
        >
          {action.label}
        </button>
      ))}
    </AnchoredPopup>
  )
}
