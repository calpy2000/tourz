import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { ChevronUp, ChevronDown } from 'lucide-react'
import { api } from '../api.js'
import { API_BASE } from '../apiBase.js'
import GameHeader from '../components/GameHeader.jsx'
import LoadingScreen from '../components/LoadingScreen.jsx'
import ChatPanel from '../components/ChatPanel.jsx'
import mapViewScreenshot from '../assets/instructions-map-view.png'

// Same star mark as MapView's site pins (StarIcon there isn't exported) — shown inline here so
// the "points-of-interest" callout in the instructions text matches the real map marker.
function PoiMarkerIcon() {
  return (
    <span className="instructions-poi-marker">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2 15 9 22 9.5 16.8 14.2 18.3 21 12 17.3 5.7 21 7.2 14.2 2 9.5 9 9Z" />
      </svg>
    </span>
  )
}

function BackArrowVisual() {
  return <span className="instructions-back-visual">&larr; back</span>
}

function LocatorVisual() {
  return <span className="instructions-locator-visual" />
}

// Same Bootstrap Icons "house-fill" glyph as HomePage's real switcher, so this demo matches
// what the player actually sees.
function HouseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8.707 1.5a1 1 0 0 0-1.414 0L.646 8.146a.5.5 0 0 0 .708.708L8 2.207l6.646 6.647a.5.5 0 0 0 .708-.708L13 5.793V2.5a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5v1.293z" />
      <path d="m8 3.293 6 6V13.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5V9.293z" />
    </svg>
  )
}

// The dashed ring called out over the TILE/MAP segment being introduced — left for the tile
// side, right for the map side, matching each segment's own position in the switcher.
function TileRing({ side }) {
  return (
    <svg className="ring-overlay" width="100%" height="100%" preserveAspectRatio="none">
      <ellipse cx={side === 'left' ? '25%' : '75%'} cy="50%" rx="23%" ry="42%" />
    </svg>
  )
}

// animate shows what "tap to switch" looks like on its own, without requiring the reader to tap
// anything — used only for section 2's first introduction of the switcher.
function ViewSwitchDemo({ active, ring, animate }) {
  const [animActive, setAnimActive] = useState(active)
  useEffect(() => {
    if (!animate) return
    const id = setInterval(() => setAnimActive((a) => (a === 'tile' ? 'map' : 'tile')), 2000)
    return () => clearInterval(id)
  }, [animate])
  const current = animate ? animActive : active
  return (
    <div className={ring ? 'view-switch instructions-tile-ring' : 'view-switch'}>
      <button className={current === 'tile' ? 'view-seg view-seg-active' : 'view-seg'}><HouseIcon /><strong>TILE</strong> view</button>
      <button className={current === 'map' ? 'view-seg view-seg-active' : 'view-seg'}><HouseIcon /><strong>MAP</strong> view</button>
      {ring && <TileRing side={current === 'tile' ? 'left' : 'right'} />}
    </div>
  )
}

function TileGridDemo() {
  return (
    <div className="tile-grid">
      <button className="landmark-tile">
        <img src={`${API_BASE}/content-photos/rbs-hq.jpg`} alt="" />
        <span className="tile-number">start</span>
        <div className="tile-scrim"><span className="tile-name">Royal Bank of Scotland Headquarters</span></div>
      </button>
      <button className="landmark-tile landmark-tile-current">
        <span className="tile-number">1</span>
        <div className="tile-scrim tile-scrim-current"><span className="tile-name">In progress</span></div>
      </button>
      <div className="landmark-tile landmark-tile-future">
        <span className="tile-number">2</span>
        <span className="tile-unknown">?</span>
      </div>
    </div>
  )
}

// Section 4 and 7's "tap a tile/marker -> details card" callout, the real DetailPopup markup
// built at its real phone-fill dimensions then shrunk with a single transform: scale so it
// keeps the exact real shape/proportions.
function MiniDetailCardDemo() {
  return (
    <div className="mini-detail-card-frame">
      <div className="mini-detail-card">
        <button className="detail-popup-back" aria-label="Back">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#23201b" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
        </button>
        <img className="detail-popup-image" src={`${API_BASE}/content-photos/rbs-hq-hero.jpg`} alt="" />
        <div className="detail-popup-body">
          <div className="detail-popup-eyebrow">About the building</div>
          <h3>Royal Bank of Scotland Headquarters</h3>
          <p className="poi-popup-address">St Andrew Square, Edinburgh</p>
          <p>Designed by Sir William Chambers and completed in 1774 as a private townhouse for Sir Lawrence Dundas, this Palladian mansion became the Scottish Excise Office in 1795 before the Royal Bank of Scotland acquired it in 1825. It remains the bank&rsquo;s registered head office today.</p>
          <p className="field-label">About its history</p>
          <p>The domed banking hall was added in 1857 by architect John Dick Peddie, its ceiling ringed with star-shaped skylights trimmed in gold. Sir Lawrence Dundas, who commissioned the original house, was one of the wealthiest men in Georgian Scotland &mdash; his fortune was built substantially on the transatlantic slave trade.</p>
          <p><strong>Interesting fact:</strong> The domed ceiling of the banking hall is famous enough to have been featured on Royal Bank of Scotland banknotes.</p>
        </div>
        <div className="detail-popup-footer">
          <a className="primary detail-popup-link" href="#" onClick={(e) => e.preventDefault()} tabIndex={-1}>
            Read more
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#23201b" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline></svg>
          </a>
        </div>
      </div>
    </div>
  )
}

// Section 5's "tap the in-progress tile -> Find it / Solve it page" callout — same shrink-the-
// real-thing technique, scaled to the full shell's own aspect ratio.
function MiniPlayPageDemo() {
  return (
    <div className="mini-play-frame">
      <div className="mini-play-page">
        <header className="landmark-header">
          <button className="ghost back-link" tabIndex={-1}>&larr; back</button>
          <span className="landmark-header-title">Landmark 1: <span className="landmark-unsolved">Unsolved</span></span>
        </header>
        <div className="landmark-body">
          <section className="card">
            <h2>Find it</h2>
            <p>look for the big man in the sky - follow his eyes for just over half a kilometre - you are looking for the green man - dont forget to note what you see on the way, you will need it for the quiz</p>
            <div className="button-row">
              <button className="primary" tabIndex={-1}>Get a hint (2 left)</button>
              <button className="primary btn-reveal" tabIndex={-1}>Reveal location</button>
            </div>
          </section>
          <section className="card">
            <h2>Solve it</h2>
            <p>What year did the green man die? (4 digits please)</p>
            <div className="answer-form">
              <input placeholder="Your answer" readOnly tabIndex={-1} />
              <button className="primary" type="button" tabIndex={-1}>submit</button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function MapPanelDemo({ crop }) {
  return (
    <div className={crop === 'bottom20' ? 'map-panel-demo map-panel-demo-crop-bottom20' : 'map-panel-demo'}>
      <img src={mapViewScreenshot} alt="Map view showing St Andrew Square, the RBS landmark and nearby points of interest" />
      <div className="map-panel-here" />
    </div>
  )
}

function MapToCardVisual() {
  return (
    <div className="map-to-card-visual">
      <div className="map-panel-demo-crop-top">
        <img src={mapViewScreenshot} alt="Map view showing the topmost point of interest marker and the RBS landmark pin" />
      </div>
      <svg className="map-to-card-arrow-overlay" viewBox="0 0 340 154" preserveAspectRatio="none" fill="none">
        <path d="M130 67 C 130 105, 150 122, 150 144" stroke="#b33f2e" strokeWidth="2.2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <polygon points="143,144 157,144 150,152" fill="#b33f2e" />
        <path d="M240 90 C 240 118, 190 122, 190 144" stroke="#b33f2e" strokeWidth="2.2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <polygon points="183,144 197,144 190,152" fill="#b33f2e" />
      </svg>
    </div>
  )
}

function ChatBarDemo() {
  return (
    <div className="home-chat">
      <div className="home-chat-row">
        <button className="chat-icon-btn" aria-label="Expand chat" tabIndex={-1}>
          <ChevronUp size={20} strokeWidth={3} />
        </button>
        <span className="home-chat-label">Chat</span>
        <div className="home-chat-msg">
          <div className="avatar">🐝</div>
          <div className="home-chat-bubble"><div className="msg-text"><strong>Priya</strong>&nbsp;&mdash; On my way, 2 mins!</div></div>
        </div>
        <button className="chat-compose-btn" aria-label="New message" tabIndex={-1}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" /></svg>
        </button>
      </div>
    </div>
  )
}

function ChatSheetDemo() {
  return (
    <div className="chat-sheet-demo">
      <div className="chat-sheet-head">
        <button className="chat-icon-btn" aria-label="Collapse chat" tabIndex={-1}>
          <ChevronDown size={18} strokeWidth={3} />
        </button>
        <span>Chat</span>
      </div>
      <div className="chat-sheet-msgs">
        <div className="chat-row chat-row-mine">
          <div className="chat-bubble"><b>Me</b> &mdash; Nice one, see you there</div>
          <div className="chat-av">🐢</div>
        </div>
        <div className="chat-row chat-row-theirs">
          <div className="chat-av">🐝</div>
          <div className="chat-bubble"><b>Priya</b> &mdash; On my way, 2 mins!</div>
        </div>
      </div>
      <div className="chat-sheet-compose">
        <input placeholder="Message your team…" disabled />
        <button className="chat-send-btn" aria-label="Send" tabIndex={-1}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" /><path d="m21.854 2.147-10.94 10.939" /></svg>
        </button>
      </div>
    </div>
  )
}

// Same dark forest-green as the real coach popup background (see .coach-popup in index.css) —
// shown here so the "navigation coach" callout in the final tips uses the same colour cue the
// player is about to see for real.
function CoachTileDemo() {
  return <span className="instructions-coach-tile" role="img" aria-label="Coach">🤓</span>
}

// Real HelpButton.jsx/HelpMenu.jsx classes/icons, rendered non-interactively — see HelpMenu.jsx
// for the source of the six items and their icons.
function HelpButtonDemo() {
  return <button className="help-btn" tabIndex={-1}>💡 Help</button>
}

function HelpMenuDemo() {
  return (
    <div className="instructions-help-menu-demo">
      <div className="modal-card help-menu">
        <div className="help-menu-label">Help</div>
        <button className="help-menu-item" tabIndex={-1}>
          <span className="help-menu-icon-chip"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.45 1.1 1.2 1.1 2.2h5c0-1 .5-1.75 1.1-2.2A6 6 0 0 0 12 3z" /></svg></span>
          Show instructions
        </button>
        <button className="help-menu-item" tabIndex={-1}>
          <span className="help-menu-icon-chip"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 4.6-1.3c.4.6.4 1.4 0 2-.3.5-.8.8-1.3 1.1-.5.3-.8.7-.8 1.2v.4" /><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" /></svg></span>
          Help on this page
        </button>
        <button className="help-menu-item" tabIndex={-1}>
          <span className="help-menu-icon-chip warn"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3.5 21 19H3L12 3.5z" /><line x1="12" y1="9.5" x2="12" y2="13.5" /><circle cx="12" cy="16.2" r="0.9" fill="currentColor" stroke="none" /></svg></span>
          Report a problem
        </button>
        <button className="help-menu-item" tabIndex={-1}>
          <span className="help-menu-icon-chip"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><line x1="12" y1="11" x2="12" y2="16" /><circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none" /></svg></span>
          About this tour
        </button>
        <button className="help-menu-item" tabIndex={-1}>
          <span className="help-menu-icon-chip"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 18h16M4.5 18 3 8l5 4 4-6 4 6 5-4-1.5 10" /></svg></span>
          Change team captain
        </button>
        <button className="help-menu-item" tabIndex={-1}>
          <span className="help-menu-icon-chip"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" /><path d="M18.5 8v6M15.5 11h6" /></svg></span>
          Add new player
        </button>
      </div>
    </div>
  )
}

function TipsList() {
  return (
    <div className="instructions-tips-list">
      <div className="instructions-tip-item">
        <span className="instructions-tip-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><path d="M16 3.128a4 4 0 0 1 0 7.744" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><circle cx="9" cy="7" r="4" /></svg></span>
        <span className="instructions-tip-text">Be sure all team members are <strong className="instructions-red">registered</strong></span>
      </div>
      <div className="instructions-tip-item">
        <span className="instructions-tip-icon-wrap"><BackArrowVisual /></span>
        <span className="instructions-tip-text">If in doubt, use the <strong className="instructions-red">back button</strong> to go back to the home page</span>
      </div>
      <div className="instructions-tip-item">
        <span className="instructions-tip-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /></svg></span>
        <span className="instructions-tip-text">The home page has 2 views -<br />
          <strong className="instructions-red">Tile view</strong> and <strong className="instructions-red">Map view</strong>
        </span>
      </div>
      <div className="instructions-tip-item">
        <span className="instructions-tip-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" /><circle cx="12" cy="10" r="3" /></svg></span>
        <span className="instructions-tip-text">Use <strong>Tile view</strong> to open the <strong className="instructions-red">in progress</strong> landmark. Use <strong>Map view</strong> to see and tap on <strong className="instructions-red">points of interest cards</strong></span>
      </div>
      <div className="instructions-tip-item">
        <span className="instructions-tip-icon-wrap"><PoiMarkerIcon /></span>
        <span className="instructions-tip-text">Take the time to review the <strong className="instructions-red">points of interest cards</strong> as you pass them &mdash; this will help you learn more and gain quiz points</span>
      </div>
      <div className="instructions-tip-item">
        <span className="instructions-tip-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" /></svg></span>
        <span className="instructions-tip-text"><strong className="instructions-red">Chat</strong> with your team mates</span>
      </div>
      <div className="instructions-tip-item">
        <span className="instructions-tip-icon">💡</span>
        <span className="instructions-tip-text">If you get stuck - tap <strong className="instructions-red">help</strong> <HelpButtonDemo /></span>
      </div>
    </div>
  )
}

// The 12-step onboarding sequence, finalised in design/instructions-pagination-mockup.html and
// ported here verbatim. Section 1 gets the page's only <h1>; the rest open with an <h2>.
function sections() {
  return [
    {
      body: (
        <>
          <h1>Instructions</h1>
          <p>
            Welcome to the tour. These instructions are <strong className="instructions-red">IMPORTANT</strong>{' '}
            so read them well and you will enjoy the tour much more.
          </p>
          <p>
            The aim is to find <strong className="instructions-red">14 landmarks</strong> &mdash; some
            big, some small. For each landmark you can gain up to{' '}
            <strong className="instructions-red">10 points</strong>. Your starting landmark is the
            Royal Bank of Scotland headquarters on St Andrew&rsquo;s Square.
          </p>
          <div className="instructions-landmark-image">
            <img src={`${API_BASE}/content-photos/rbs-hq-hero.jpg`} alt="Royal Bank of Scotland headquarters, St Andrew's Square" />
          </div>
          <p>Hopefully you are there &mdash; if not, go to it now before continuing.</p>
        </>
      ),
    },
    {
      body: (
        <>
          <p>
            The app is simple, there is a <strong className="instructions-red">home page</strong> that
            shows the landmarks that you have found, so to begin with you will see just the starting
            landmark.
          </p>
          <p>
            There are 2 views in the home page, a <strong className="instructions-red">Tile view</strong>{' '}
            and a <strong className="instructions-red">Map view</strong>. You can switch between them
            using a switcher bar at the top of the screen.
          </p>
          <ViewSwitchDemo active="tile" animate />
          <p>
            You can <strong className="instructions-red">always</strong> go back to the home page by
            tapping the <BackArrowVisual /> button at the top left of any page.
          </p>
          <p>
            Next we will take a look at the <strong className="instructions-red">Tile view</strong> and
            then the <strong className="instructions-red">Map view</strong>.
          </p>
        </>
      ),
    },
    {
      body: (
        <>
          <h2>Tile view</h2>
          <p>
            In the <strong className="instructions-red">tile view</strong> you will see a tile for each
            landmark.
          </p>
          <p>
            <strong className="instructions-red">Found</strong> landmarks will show with the image (see
            below left).
          </p>
          <p>
            The <strong className="instructions-red">current</strong> landmark you are trying to find
            will show as <strong className="instructions-red">in progress</strong> (see below centre).
          </p>
          <p>
            <strong className="instructions-red">Future</strong> landmarks will show as{' '}
            <strong>?</strong> &mdash; to be found (see below right).
          </p>
          <ViewSwitchDemo active="tile" ring />
          <TileGridDemo />
        </>
      ),
    },
    {
      body: (
        <>
          <h2>Tile view continued</h2>
          <p>
            When you tap on a tile for a <strong className="instructions-red">found landmark</strong>, you see a
            details card for the landmark (see below).
          </p>
          <ViewSwitchDemo active="tile" ring />
          <TileGridDemo />
          <div className="tile-to-card-arrow">
            <svg width="100%" height="36" viewBox="0 0 454 36" preserveAspectRatio="none" fill="none">
              <path d="M72 2 C 72 20, 227 12, 227 24" stroke="#b33f2e" strokeWidth="2.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              <polygon points="220,24 234,24 227,34" fill="#b33f2e" />
            </svg>
          </div>
          <MiniDetailCardDemo />
        </>
      ),
    },
    {
      body: (
        <>
          <h2>Tile view continued</h2>
          <p>
            When you click on the <strong className="instructions-red">in progress</strong> tile, you
            see the <strong className="instructions-red">Find it</strong> (the clue to landmark
            location) and the <strong className="instructions-red">Solve it</strong> (prove that you
            are there) page.
          </p>
          <ViewSwitchDemo active="tile" ring />
          <TileGridDemo />
          <div className="tile-to-card-arrow center">
            <svg width="16" height="36" viewBox="0 0 16 36" fill="none">
              <path d="M8 2 L8 26" stroke="#b33f2e" strokeWidth="2.5" strokeLinecap="round" />
              <polygon points="1,24 15,24 8,34" fill="#b33f2e" />
            </svg>
          </div>
          <MiniPlayPageDemo />
        </>
      ),
    },
    {
      body: (
        <>
          <h2>Map view</h2>
          <p>
            Switch to <strong className="instructions-red">Map view</strong> using the switcher bar
            below. You will see a map that shows the location of <strong className="instructions-red">landmarks</strong> found so far and markers
            for <strong className="instructions-red">points of interest</strong> <PoiMarkerIcon />.
          </p>
          <p>
            You will also see your <strong className="instructions-red">current location</strong> <LocatorVisual />. For this to work make sure you{' '}
            <strong className="instructions-red">allow location access</strong> when your phone asks
            for it.
          </p>
          <ViewSwitchDemo active="map" ring />
          <MapPanelDemo crop="bottom20" />
        </>
      ),
    },
    {
      body: (
        <>
          <h2>Map view continued</h2>
          <p>
            Tap on a <strong className="instructions-red">point of interest marker</strong> or a{' '}
            <strong className="instructions-red">found landmark</strong> to see the{' '}
            <strong className="instructions-red">details card</strong> (see below).
          </p>
          <ViewSwitchDemo active="map" ring />
          <MapToCardVisual />
          <MiniDetailCardDemo />
        </>
      ),
    },
    {
      body: (
        <>
          <h2>Finding landmarks</h2>
          <p>Click on the <strong className="instructions-red">in progress</strong> tile in the tile view.</p>
          <p>
            You will see a <strong className="instructions-red">Find it clue</strong> to locate the
            landmark. If you can&rsquo;t find it from the clue you can have up to{' '}
            <strong className="instructions-red">2 hints</strong>, and if you still can&rsquo;t find it
            you can <strong className="instructions-red">reveal</strong> it &mdash; but be aware hints
            and reveals mean less points.
          </p>
          <p>
            When you find a landmark you need to <strong className="instructions-red">Solve it</strong>{' '}
            by answering a question &mdash; <strong className="instructions-red">be careful</strong>,
            you only get one go.
          </p>
          <p>
            Once revealed or solved, the landmark is now visible on the tile view and map view home
            page.
          </p>
          <p>
            You will then take a <strong className="instructions-red">quiz</strong> to earn more
            points. <strong className="instructions-red instructions-underline">BE AWARE</strong>{' '}
            &mdash; this might include questions about what you saw on the way &mdash; so keep your
            eyes peeled 👀 and be sure to read the{' '}
            <strong className="instructions-red">point of interest cards</strong> along the way &mdash;
            these hold loads on interesting info, which will{' '}
            <strong className="instructions-red">greatly enrich your tour and help in the quizzes 🤩</strong>
          </p>
        </>
      ),
    },
    {
      body: (
        <>
          <h2>Working as a team</h2>
          <p>
            If you are working as a team, each member should register on the app on their own phone
            &mdash; this makes the tour <strong className="instructions-red">so much better</strong>{' '}
            for each member, who can then look at points of interest and landmark cards independently,
            and see clues, hints and quizzes themselves.
          </p>
          <p>
            So make sure all team members <strong className="instructions-red">register now</strong>.
          </p>
          <p>
            Only the <strong className="instructions-red">team captain</strong> can ask for{' '}
            <strong className="instructions-red">hints</strong>,{' '}
            <strong className="instructions-red">reveal</strong> a landmark,{' '}
            <strong className="instructions-red">solve</strong> a landmark or{' '}
            <strong className="instructions-red">submit</strong> quiz answers. All team members will
            see these updates on their phone.
          </p>
          <p>
            Team members can also communicate via the{' '}
            <strong className="instructions-red">chat function</strong>. We will cover this next.
          </p>
        </>
      ),
    },
    {
      body: (
        <>
          <h2>Chat</h2>
          <p>
            You will see the <strong className="instructions-red">chat panel</strong> at the bottom of
            the screen.
          </p>
          <ChatBarDemo />
          <p>
            It shows the last chat. To enter a chat, tap on the{' '}
            <strong className="instructions-red">pencil icon</strong>
            <span className="instructions-chat-pencil-inline">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" /></svg>
            </span>{' '}
            on the right hand side.
          </p>
          <p>
            To <strong className="instructions-red">expand</strong> the chat panel, tap the expand icon
            <span className="instructions-chat-icon-inline">
              <ChevronUp size={14} strokeWidth={3} />
            </span>{' '}
            on the left hand side. This will then reveal the chat history, like this:
          </p>
          <ChatSheetDemo />
          <p>
            To <strong className="instructions-red">collapse</strong> the chat panel, tap the collapse
            icon
            <span className="instructions-chat-icon-inline instructions-chat-icon-inline-light">
              <ChevronDown size={14} strokeWidth={3} />
            </span>{' '}
            at the top.
          </p>
        </>
      ),
    },
    {
      body: (
        <>
          <h2>Final things to know</h2>
          <p>
            The tour has a time limit of <strong className="instructions-red">6 hours</strong> - you
            will see a timer at the top of the page.
          </p>
          <p>
            There is a <strong className="instructions-red">help function</strong> at the top right of the
            page: <HelpButtonDemo />
          </p>
          <p>
            Use this if you ever get stuck - it has the following{' '}
            <strong className="instructions-red">options</strong>:
          </p>
          <HelpMenuDemo />
        </>
      ),
    },
    {
      body: (
        <div className="instructions-final-tips">
          <h2>Final tips</h2>
          <p><strong className="instructions-red">7 key things</strong> to remember:</p>
          <TipsList />
          <p>
            When you tap on let&rsquo;s start the tour below you will see a green panel with your
            navigation coach - do what they say <CoachTileDemo />
          </p>
        </div>
      ),
    },
  ]
}

export default function InstructionsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  // Reached two different ways: the required onboarding step before /home (no state — full
  // GameHeader, paginated flow, "let's start the tour" as the final step), or opened later from
  // HelpButton's "Show instructions" option (helpMode — simple back button instead, no
  // pagination footer, chat panel visible so the team feed stays reachable). returnTo is
  // wherever the help button was tapped from.
  const helpMode = Boolean(location.state?.helpMode)
  const returnTo = location.state?.returnTo || '/home'
  const returnState = location.state?.returnState
  const [data, setData] = useState(null)
  const [fetchedAt, setFetchedAt] = useState(null)
  const [, setTick] = useState(0)
  const [step, setStep] = useState(0)

  const loadHome = () => api.getHome().then((res) => { setData(res); setFetchedAt(Date.now()) })

  useEffect(() => {
    if (!helpMode) loadHome()
  }, [helpMode])

  // Same live-ticking pattern as HomePage — elapsedSeconds is a snapshot from the last fetch.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  if (!helpMode && !data) return <LoadingScreen />

  const liveElapsedSeconds = data ? data.elapsedSeconds + Math.floor((Date.now() - fetchedAt) / 1000) : 0

  if (helpMode) {
    return (
      <div className="home-shell instructions-shell">
        <header className="landmark-header">
          <button data-coach-id="help-instructions-back-btn" className="back-link" onClick={() => navigate(returnTo, { state: returnState })}>&larr; back</button>
        </header>

        <div className="home-body">
          <div className="instructions-text">
            <h1>Instructions</h1>

            <p>
              Welcome to your Edinburgh walking tour. The aim is to find{' '}
              <strong className="instructions-red">14 landmarks</strong> &mdash; some big, some
              small. For each landmark you can gain up to{' '}
              <strong className="instructions-red">10 points</strong>. You&rsquo;ll have{' '}
              <strong className="instructions-red">6 hours</strong> from the moment you start, so
              keep an eye on the timer at the top of the screen.
            </p>

            <p>
              You can <strong className="instructions-red">always</strong> go back to the home
              page by tapping the <BackArrowVisual /> button at the top left of any page. The home
              page has 2 views, switched using the bar below:
            </p>
            <ViewSwitchDemo active="tile" animate />

            <h2>Tile view</h2>
            <p>
              <strong className="instructions-red">Found</strong> landmarks show with their image
              (below left). The <strong className="instructions-red">current</strong> landmark
              you&rsquo;re trying to find shows as{' '}
              <strong className="instructions-red">in progress</strong> (below centre).{' '}
              <strong className="instructions-red">Future</strong> landmarks show as{' '}
              <strong>?</strong> (below right).
            </p>
            <TileGridDemo />

            <p>
              Tap a <strong className="instructions-red">found</strong> tile to see its details
              card:
            </p>
            <div className="tile-to-card-arrow center">
              <svg width="16" height="36" viewBox="0 0 16 36" fill="none">
                <path d="M8 2 L8 26" stroke="#b33f2e" strokeWidth="2.5" strokeLinecap="round" />
                <polygon points="1,24 15,24 8,34" fill="#b33f2e" />
              </svg>
            </div>
            <MiniDetailCardDemo />

            <p>
              Tap the <strong className="instructions-red">in progress</strong> tile to see the
              Find it / Solve it page:
            </p>
            <div className="tile-to-card-arrow center">
              <svg width="16" height="36" viewBox="0 0 16 36" fill="none">
                <path d="M8 2 L8 26" stroke="#b33f2e" strokeWidth="2.5" strokeLinecap="round" />
                <polygon points="1,24 15,24 8,34" fill="#b33f2e" />
              </svg>
            </div>
            <MiniPlayPageDemo />

            <h2>Map view</h2>
            <p>
              Map view shows the location of landmarks found so far and markers for{' '}
              <strong className="instructions-red">points of interest</strong> <PoiMarkerIcon />,
              plus your <strong className="instructions-red">current location</strong>{' '}
              <LocatorVisual />. For this to work make sure you{' '}
              <strong className="instructions-red">allow location access</strong> when your phone
              asks for it.
            </p>
            <MapPanelDemo crop="bottom20" />

            <p>Tap a point of interest marker or a found landmark to see its details card:</p>
            <MapToCardVisual />
            <MiniDetailCardDemo />

            <h2>Finding landmarks</h2>
            <p>
              Each landmark starts with a <strong className="instructions-red">Find it clue</strong>.
              If you can&rsquo;t find it you can have up to{' '}
              <strong className="instructions-red">2 hints</strong>, and if you still can&rsquo;t
              find it you can <strong className="instructions-red">reveal</strong> it &mdash; but
              hints and reveals mean fewer points.
            </p>
            <p>
              When you find it, <strong className="instructions-red">Solve it</strong> by
              answering a question &mdash; <strong className="instructions-red">be careful</strong>,
              you only get one go.
            </p>
            <p>
              Solving unlocks a <strong className="instructions-red">quiz</strong> for more
              points. <strong className="instructions-red instructions-underline">BE AWARE</strong>{' '}
              &mdash; this might include questions about what you saw on the way, so keep your
              eyes peeled 👀 and read the{' '}
              <strong className="instructions-red">points of interest cards</strong> along the way
              &mdash; they&rsquo;ll{' '}
              <strong className="instructions-red">greatly enrich your tour and help in the quizzes 🤩</strong>
            </p>

            <h2>Working as a team</h2>
            <p>
              Each team member should register on their own phone so they can look at points of
              interest and landmark cards independently, and see clues, hints and quizzes
              themselves.
            </p>
            <p>
              Only the <strong className="instructions-red">team captain</strong> can ask for{' '}
              <strong className="instructions-red">hints</strong>,{' '}
              <strong className="instructions-red">reveal</strong> a landmark,{' '}
              <strong className="instructions-red">solve</strong> a landmark or{' '}
              <strong className="instructions-red">submit</strong> quiz answers &mdash; all team
              members see these updates on their phone.
            </p>

            <h2>Chat</h2>
            <p>
              The <strong className="instructions-red">chat panel</strong> sits at the bottom of
              the screen and shows the last message.
            </p>
            <ChatBarDemo />
            <p>
              Tap the <strong className="instructions-red">pencil icon</strong>
              <span className="instructions-chat-pencil-inline">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" /></svg>
              </span>{' '}
              on the right to send a message, or the expand icon
              <span className="instructions-chat-icon-inline">
                <ChevronUp size={14} strokeWidth={3} />
              </span>{' '}
              on the left to see the full chat history:
            </p>
            <ChatSheetDemo />
            <p>
              Tap the collapse icon
              <span className="instructions-chat-icon-inline instructions-chat-icon-inline-light">
                <ChevronDown size={14} strokeWidth={3} />
              </span>{' '}
              at the top to close it again.
            </p>

            <h2>Final tips</h2>
            <p><strong className="instructions-red">7 key things</strong> to remember:</p>
            <TipsList />

            <p>
              Good luck &mdash; the clock is ticking, so you had better get on with it. Don&rsquo;t
              forget, if in doubt, tap the <BackArrowVisual /> button and head to{' '}
              <strong className="instructions-red">tile view</strong>.
            </p>
          </div>
        </div>

        <ChatPanel />
      </div>
    )
  }

  const allSections = sections()
  const isFirst = step === 0
  const isLast = step === allSections.length - 1

  return (
    <div className="home-shell instructions-shell">
      <GameHeader data={data} elapsedSeconds={liveElapsedSeconds} onReset={loadHome} />

      <div className="instructions-progress">
        <span className="instructions-progress-label">Instructions {step + 1}/{allSections.length}</span>
        <span className="instructions-progress-dots">
          {allSections.map((_, i) => (
            <span key={i} className={i === step ? 'is-active' : i < step ? 'is-done' : ''} />
          ))}
        </span>
      </div>

      <div className="home-body">
        <div className="instructions-text">{allSections[step].body}</div>
      </div>

      <div className="instructions-nav">
        <button className="ghost" disabled={isFirst} onClick={() => setStep((s) => Math.max(0, s - 1))}>&laquo; back</button>
        <button
          className="primary instructions-next-btn"
          onClick={async () => {
            if (!isLast) return setStep((s) => s + 1)
            await api.markInstructionsComplete()
            navigate('/home', { state: { startCoach: true } })
          }}
        >
          {isLast ? "let's start the tour »" : 'i have read this - next »'}
        </button>
      </div>
    </div>
  )
}
