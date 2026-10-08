import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { api } from '../api.js'
import { API_BASE } from '../apiBase.js'
import GameHeader from '../components/GameHeader.jsx'
import LoadingScreen from '../components/LoadingScreen.jsx'

// One screenshot per tour (captured via scripts/dev/capture-instructions-map-screenshot.mjs), so
// the map-view mockups below show this tour's own landmarks/markers instead of whichever tour was
// last screenshotted. map-view-default.png is the fallback for a tour that hasn't been captured
// yet — better a stale-but-present image than a broken one.
const mapViewScreenshots = import.meta.glob('../assets/instructions/map-view-*.png', { eager: true, import: 'default' })
function mapViewScreenshotFor(tourCode) {
  const key = `../assets/instructions/map-view-${tourCode}.png`
  return mapViewScreenshots[key] || mapViewScreenshots['../assets/instructions/map-view-default.png']
}

// Real POI geography differs per tour, so MapToCardVisual's arrow overlay can't point at one
// fixed pixel spot for every tour — it reads each tour's actual landmark-pin/nearest-POI-marker
// positions (written alongside the screenshot by the capture script) instead. Falls back to
// Edinburgh's captured positions for a tour with no metadata yet, same spirit as the image fallback.
const mapViewMeta = import.meta.glob('../assets/instructions/map-view-*.json', { eager: true, import: 'default' })
function mapViewMetaFor(tourCode) {
  const key = `../assets/instructions/map-view-${tourCode}.json`
  return mapViewMeta[key] || mapViewMeta['../assets/instructions/map-view-default.json'] || {
    landmark: { x: 171, y: 67 },
    poi: { x: 100, y: 101 },
  }
}

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

// The dashed ring called out over the MAP/CURRENT LANDMARK segment being introduced — left for
// the map side, right for the current-landmark side, matching each segment's own position.
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
    const id = setInterval(() => setAnimActive((a) => (a === 'map' ? 'current' : 'map')), 2000)
    return () => clearInterval(id)
  }, [animate])
  const current = animate ? animActive : active
  return (
    <div className={ring ? 'view-switch instructions-tile-ring' : 'view-switch'}>
      <button className={current === 'map' ? 'view-seg view-seg-active' : 'view-seg'}><HouseIcon /><strong>MAP</strong> view</button>
      <button className={current === 'current' ? 'view-seg view-seg-active' : 'view-seg'}><HouseIcon /><strong>CURRENT</strong> landmark</button>
      {ring && <TileRing side={current === 'map' ? 'left' : 'right'} />}
    </div>
  )
}

// "Tap a marker/found landmark -> details card" callout, the real DetailPopup markup built at
// its real phone-fill dimensions then shrunk with a single transform: scale so it keeps the
// exact real shape/proportions.
function MiniDetailCardDemo({ startLandmark }) {
  const aboutSections = [
    { label: startLandmark?.aboutLandmarkLabel, text: startLandmark?.aboutLandmarkText },
    { label: startLandmark?.aboutSubjectLabel, text: startLandmark?.aboutSubjectText },
  ].filter((s) => s.text)

  return (
    <div className="mini-detail-card-frame">
      <div className="mini-detail-card">
        <button className="detail-popup-back" aria-label="Back">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#23201b" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
        </button>
        {startLandmark?.imagePath && (
          <img className="detail-popup-image" src={`${API_BASE}/content-photos/${startLandmark.imagePath}`} alt="" />
        )}
        <div className="detail-popup-body">
          <div className="detail-popup-eyebrow">Starting landmark</div>
          <h3>{startLandmark?.title || 'Your starting landmark'}</h3>
          {startLandmark?.address && <p className="poi-popup-address">{startLandmark.address}</p>}
          {aboutSections.map((s, i) => (
            <div key={i}>
              {s.label && aboutSections.length > 1 && <p className="field-label">{s.label}</p>}
              <p>{s.text}</p>
            </div>
          ))}
          {startLandmark?.interestingFact && (
            <p><strong>Interesting fact:</strong> {startLandmark.interestingFact}</p>
          )}
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

// Section 3's "tap CURRENT LANDMARK -> Find it / Solve it page" callout — same shrink-the-
// real-thing technique, scaled to the full shell's own aspect ratio. No header/back button here,
// matching the real PlayPage — the switcher itself is the only way back to Map view.
function MiniPlayPageDemo() {
  return (
    <div className="mini-play-frame">
      <div className="mini-play-page">
        <div className="landmark-body">
          <div className="view-switch">
            <button className="view-seg" tabIndex={-1}><HouseIcon /><strong>MAP</strong> view</button>
            <button className="view-seg view-seg-active" tabIndex={-1}><HouseIcon /><strong>CURRENT</strong> landmark</button>
          </div>
          <section className="card">
            <h2>Find it</h2>
            <p>follow the clue to find your next landmark - it might send you down a side street or point out a small detail - dont forget to note what you see on the way, you will need it for the quiz</p>
            <div className="button-row">
              <button className="primary" tabIndex={-1}>Get a hint (2 left)</button>
              <button className="primary btn-reveal" tabIndex={-1}>Reveal location</button>
            </div>
          </section>
          <section className="card">
            <h2>Solve it</h2>
            <p>What year was it built? (4 digits please)</p>
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

function MapPanelDemo({ crop, tourCode }) {
  return (
    <div className={crop === 'bottom20' ? 'map-panel-demo map-panel-demo-crop-bottom20' : 'map-panel-demo'}>
      <img src={mapViewScreenshotFor(tourCode)} alt="Map view showing the landmark marker and nearby points of interest" />
      <div className="map-panel-here" />
    </div>
  )
}

// Builds a smooth drop-then-curve path from a marker's actual position (start) down to a fixed
// x position on the card's top edge (endX, always y=144) — same shape family as the original
// hand-authored curves, generalised so it still looks right wherever the marker actually is.
function arrowPath(start, endX) {
  const bendY = start.y + (144 - start.y) * 0.55
  return `M${start.x} ${start.y} C ${start.x} ${bendY}, ${endX} ${bendY}, ${endX} 144`
}

function MapToCardVisual({ tourCode }) {
  const meta = mapViewMetaFor(tourCode)
  const landmarkArrow = arrowPath(meta.landmark, 150)
  const poiArrow = meta.poi ? arrowPath(meta.poi, 190) : null
  return (
    <div className="map-to-card-visual">
      <div className="map-panel-demo-crop-top">
        <img src={mapViewScreenshotFor(tourCode)} alt="Map view showing the topmost point of interest marker and the landmark pin" />
      </div>
      <svg className="map-to-card-arrow-overlay" viewBox="0 0 340 154" preserveAspectRatio="none" fill="none">
        <path d={landmarkArrow} stroke="#b33f2e" strokeWidth="2.2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <polygon points="143,144 157,144 150,152" fill="#b33f2e" />
        {poiArrow && (
          <>
            <path d={poiArrow} stroke="#b33f2e" strokeWidth="2.2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            <polygon points="183,144 197,144 190,152" fill="#b33f2e" />
          </>
        )}
      </svg>
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

// Real GameHeader footer markup/classes, rendered non-interactively with sample numbers — used
// in "final things to know" to show where the points, timer and help button actually live now
// (the bottom of the screen, not the top). No Dev button here — real players never see that one.
function FooterDemo() {
  return (
    <footer className="home-header instructions-footer-demo">
      <div className="home-pills">
        <div className="home-pill home-pill-oat"><span className="stat-line">Found 3/14</span></div>
        <div className="home-pill home-pill-brass"><span className="stat-line">40 pts</span></div>
        <div className="home-pill home-pill-brick"><span className="icon-clock" /><span className="stat-line">01:12</span></div>
        <HelpButtonDemo />
      </div>
    </footer>
  )
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
        <span className="instructions-tip-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /></svg></span>
        <span className="instructions-tip-text">The home page has 2 options -<br />
          <strong className="instructions-red">Map view</strong> and <strong className="instructions-red">Current landmark</strong>
        </span>
      </div>
      <div className="instructions-tip-item">
        <span className="instructions-tip-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" /><circle cx="12" cy="10" r="3" /></svg></span>
        <span className="instructions-tip-text">Use <strong>Current landmark</strong> to open the landmark you're working on. Use <strong>Map view</strong> to see and tap on <strong className="instructions-red">the landmarks you have found</strong> and <strong className="instructions-red">points of interest</strong></span>
      </div>
      <div className="instructions-tip-item">
        <span className="instructions-tip-icon-wrap"><PoiMarkerIcon /></span>
        <span className="instructions-tip-text">Take the time to review the <strong className="instructions-red">points of interest cards</strong> as you pass them &mdash; this will help you learn more and gain quiz points<br />
          <strong className="instructions-red">Top hint</strong> &mdash; share this across the team
        </span>
      </div>
      <div className="instructions-tip-item">
        <span className="instructions-tip-icon">💡</span>
        <span className="instructions-tip-text">If you get stuck - tap <strong className="instructions-red">help</strong> <HelpButtonDemo /></span>
      </div>
    </div>
  )
}

// The paginated onboarding sequence. Section 1 gets the page's only <h1>; the rest open with an
// <h2>. Updated 2026-10-08 when Tile view was removed in favour of a 2-option Map view / Current
// landmark switcher, and the GameHeader moved from a top header to a bottom footer — see
// project-tileview-removal-archive and this session's footer-redesign work for the history.
function sections(data, startLandmark) {
  const playableCount = (data?.totalLandmarks || 1) - 1
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
            The aim is to find <strong className="instructions-red">{playableCount} landmarks</strong> &mdash; some
            big, some small. For each landmark you can gain up to{' '}
            <strong className="instructions-red">10 points</strong>. Your starting landmark is{' '}
            <strong className="instructions-red">{startLandmark?.title}</strong>
            {startLandmark?.address ? `, ${startLandmark.address}` : ''}.
          </p>
          {startLandmark?.imagePath && (
            <div className="instructions-landmark-image">
              <img src={`${API_BASE}/content-photos/${startLandmark.imagePath}`} alt={startLandmark.title} />
            </div>
          )}
          <p>Hopefully you are there &mdash; if not, go to it now before continuing.</p>
        </>
      ),
    },
    {
      body: (
        <>
          <p>
            The app is simple, there is a <strong className="instructions-red">home page</strong> that
            shows what you've found so far on a map, so to begin with you'll just see your starting
            landmark.
          </p>
          <p>
            At the top of the home page is a switcher with 2 options &mdash;{' '}
            <strong className="instructions-red">Map view</strong> and{' '}
            <strong className="instructions-red">Current landmark</strong>.
          </p>
          <ViewSwitchDemo active="map" animate />
          <p>
            Next we will take a look at <strong className="instructions-red">Current landmark</strong>{' '}
            and then <strong className="instructions-red">Map view</strong>.
          </p>
        </>
      ),
    },
    {
      body: (
        <>
          <h2>Current landmark</h2>
          <p>
            Tap <strong className="instructions-red">CURRENT LANDMARK</strong> in the switcher and
            you'll jump straight to the landmark you're working on now.
          </p>
          <p>
            If you haven't cracked it yet, you'll see the <strong className="instructions-red">Find it</strong>{' '}
            (the clue to its location) and <strong className="instructions-red">Solve it</strong> (prove
            you're there) page, shown below. If you've already solved it, you'll see its{' '}
            <strong className="instructions-red">quiz</strong> instead.
          </p>
          <ViewSwitchDemo active="current" ring />
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
            You will also see your <strong className="instructions-red">current location</strong> <LocatorVisual />.
          </p>
          <ViewSwitchDemo active="map" ring />
          <MapPanelDemo crop="bottom20" tourCode={data?.tourCode} />
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
          <MapToCardVisual tourCode={data?.tourCode} />
          <MiniDetailCardDemo startLandmark={startLandmark} />
        </>
      ),
    },
    {
      body: (
        <>
          <h2>Finding landmarks</h2>
          <p>Tap <strong className="instructions-red">CURRENT LANDMARK</strong> in the switcher.</p>
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
            Once revealed or solved, the landmark is now visible on the map view home page.
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
            There are lots of <strong className="instructions-red">points of interest cards</strong> to
            read - so it is a <strong className="instructions-red">VERY</strong> good idea to{' '}
            <strong className="instructions-red">share</strong> this across the team.
          </p>
        </>
      ),
    },
    {
      body: (
        <>
          <h2>Final things to know</h2>
          <p>
            The tour has a time limit of <strong className="instructions-red">6 hours</strong>. Your{' '}
            <strong className="instructions-red">points</strong> and <strong className="instructions-red">timer</strong>{' '}
            live in a bar at the <strong className="instructions-red">bottom</strong> of every page, along
            with the <strong className="instructions-red">help function</strong> (see below):
          </p>
          <FooterDemo />
          <p>
            Tap <HelpButtonDemo /> if you ever get stuck - it has the following{' '}
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
          <p><strong className="instructions-red">5 key things</strong> to remember:</p>
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
  // pagination footer). returnTo is wherever the help button was tapped from.
  const helpMode = Boolean(location.state?.helpMode)
  const returnTo = location.state?.returnTo || '/home'
  const returnState = location.state?.returnState
  const [data, setData] = useState(null)
  const [fetchedAt, setFetchedAt] = useState(null)
  const [, setTick] = useState(0)
  const [step, setStep] = useState(location.state?.step ?? 0)
  // The real starting landmark's full detail (image/about-text/interesting-fact included) — used
  // by the tile/detail-card demo mockups below so they show this tour's actual start landmark
  // instead of a fixed Edinburgh example. sequence_order 1 is always the start landmark.
  const [startLandmark, setStartLandmark] = useState(null)

  const loadHome = () => api.getHome().then((res) => { setData(res); setFetchedAt(Date.now()) })

  useEffect(() => {
    loadHome()
    api.getLandmarkDetail(1).then((res) => { if (!res.error) setStartLandmark(res) })
  }, [helpMode])

  // Same live-ticking pattern as HomePage — elapsedSeconds is a snapshot from the last fetch.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  if (!data) return <LoadingScreen />

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
              Welcome to your {data.tourName}. The aim is to find{' '}
              <strong className="instructions-red">{data.totalLandmarks - 1} landmarks</strong> &mdash; some big, some
              small. For each landmark you can gain up to{' '}
              <strong className="instructions-red">10 points</strong>. You&rsquo;ll have{' '}
              <strong className="instructions-red">6 hours</strong> from the moment you start &mdash;
              your points and timer live in a bar at the bottom of every page.
            </p>

            <p>
              The home page has a switcher with 2 options, <strong className="instructions-red">Map view</strong>{' '}
              and <strong className="instructions-red">Current landmark</strong>:
            </p>
            <ViewSwitchDemo active="map" animate />

            <h2>Current landmark</h2>
            <p>
              Tap <strong className="instructions-red">CURRENT LANDMARK</strong> to jump straight to
              the landmark you're working on now &mdash; its{' '}
              <strong className="instructions-red">Find it</strong> /{' '}
              <strong className="instructions-red">Solve it</strong> page if you haven&rsquo;t cracked
              it yet, or its <strong className="instructions-red">quiz</strong> if you have:
            </p>
            <MiniPlayPageDemo />

            <h2>Map view</h2>
            <p>
              Map view shows the location of landmarks found so far and markers for{' '}
              <strong className="instructions-red">points of interest</strong> <PoiMarkerIcon />,
              plus your <strong className="instructions-red">current location</strong>{' '}
              <LocatorVisual />.
            </p>
            <MapPanelDemo crop="bottom20" tourCode={data?.tourCode} />

            <p>Tap a point of interest marker or a found landmark to see its details card:</p>
            <MapToCardVisual tourCode={data?.tourCode} />
            <MiniDetailCardDemo startLandmark={startLandmark} />

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

            <h2>Final tips</h2>
            <p><strong className="instructions-red">5 key things</strong> to remember:</p>
            <TipsList />

            <p>
              Good luck &mdash; the clock is ticking, so you had better get on with it. Don&rsquo;t
              forget, if in doubt, tap <strong className="instructions-red">MAP view</strong>.
            </p>
          </div>
        </div>
      </div>
    )
  }

  const allSections = sections(data, startLandmark)
  const isFirst = step === 0
  const isLast = step === allSections.length - 1

  return (
    <div className="home-shell instructions-shell">
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

      <GameHeader
        data={data}
        elapsedSeconds={liveElapsedSeconds}
        onReset={loadHome}
        showHelp
        helpReturnState={{ step }}
        pageHelpText={
          <>
            <p>Use <strong>« back</strong> and <strong>next »</strong> to move through these instructions at your own pace.</p>
            <p>Once you've read everything, tap <strong>let's start the tour »</strong> to begin.</p>
          </>
        }
      />
    </div>
  )
}
