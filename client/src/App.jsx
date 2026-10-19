import { useEffect } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import StartPage from './pages/StartPage.jsx'
import WelcomePage from './pages/WelcomePage.jsx'
import InstructionsPage from './pages/InstructionsPage.jsx'
import HomePage from './pages/HomePage.jsx'
import PlayPage from './pages/PlayPage.jsx'
import CertificatePage from './pages/CertificatePage.jsx'
import { getSession } from './localSession.js'
import { APP_VERSION } from './version.js'
import { DEV_MODE } from './devMode.js'
import { CoachProvider } from './coach/CoachContext.jsx'
import CoachOverlay from './coach/CoachOverlay.jsx'
import GpsGateScreen from './components/GpsGateScreen.jsx'
import DebugOverlay from './components/DebugOverlay.jsx'
import { useGpsPreflightStatus } from './gpsPreflight.js'
import { NarrationPlayerProvider } from './components/NarrationPlayer.jsx'
import { GameClockProvider, GameClockLayer } from './gameClock.jsx'
import ConnectionStatus from './components/ConnectionStatus.jsx'
import { startGameStore, useGameStore } from './offline/gameStore.js'
import { useContentCache, loadTourPack, assetUrlsFor, saveForOffline, rememberUrls } from './offline/contentCache.js'

// Keeps the phone's copy of the game going (offline/gameStore.js) and saves the whole tour onto
// the phone in the background (offline/contentCache.js): the tour pack (every POI card), then
// every photo and narration file the game and the pack refer to — so after the first few minutes
// of a tour nothing static ever needs fetching again. Re-checks whenever the set of landmarks the
// phone holds or the pack itself changes; already-saved files are skipped.
function OfflineKeeper() {
  const { pathname } = useLocation()
  const { state } = useGameStore()
  const { pack } = useContentCache()
  useEffect(() => { if (getSession()) startGameStore() }, [pathname])
  const tourId = state?.tour?.id
  useEffect(() => { if (tourId) loadTourPack(tourId) }, [tourId])
  const landmarkKey = state ? Object.keys(state.landmarks).join(',') : ''
  useEffect(() => {
    if (!state) return
    const urls = assetUrlsFor(state, pack)
    rememberUrls(urls)
    saveForOffline(urls)
  }, [landmarkKey, pack?.version])
  return null
}

const STATUS_PATHS = ['/home', '/play', '/instructions', '/certificate']

// /home, /play, /instructions all need a real registered player — without a session there's no
// team for the API to resolve, so bounce back to registration rather than showing a broken page.
function RequireSession({ children }) {
  return getSession() ? children : <Navigate to="/" replace />
}

// Landmark and site detail views are no longer routes — they open as a DetailPopup overlay on
// whatever page triggered them (Home, Map, or mid-play) instead of navigating away. See
// project-landmark-detail-feature memory for the design history of the page this replaced.
export default function App() {
  const gpsStatus = useGpsPreflightStatus()
  // MAP view (HomePage) stays mounted — just hidden — while CURRENT landmark (/play) is showing,
  // so toggling back is instant: no new map, no re-adding every marker. Rendered outside
  // <Routes> for that reason (a route element always unmounts when its path stops matching).
  // Any other page (instructions, certificate, start) unmounts it as before.
  const { pathname } = useLocation()
  const onHome = pathname === '/home'
  const keepHome = (onHome || pathname === '/play') && getSession()

  return (
    <CoachProvider>
      {DEV_MODE && <div className="app-version-badge">{APP_VERSION}</div>}
      <OfflineKeeper />
      {gpsStatus !== 'ok' ? (
        <GpsGateScreen />
      ) : (
        <NarrationPlayerProvider>
          <GameClockProvider>
          {keepHome && (
            <div style={{ display: onHome ? 'contents' : 'none' }}>
              <HomePage active={onHome} />
            </div>
          )}
          <Routes>
            <Route path="/" element={<StartPage />} />
            <Route path="/welcome" element={<RequireSession><WelcomePage /></RequireSession>} />
            <Route path="/instructions" element={<RequireSession><InstructionsPage /></RequireSession>} />
            {/* Rendered above (kept-alive layer) — this route only keeps the session redirect. */}
            <Route path="/home" element={<RequireSession>{null}</RequireSession>} />
            <Route path="/play" element={<RequireSession><PlayPage /></RequireSession>} />
            <Route path="/certificate" element={<RequireSession><CertificatePage /></RequireSession>} />
          </Routes>
          <GameClockLayer />
          <ConnectionStatus inGame={STATUS_PATHS.includes(pathname) && Boolean(getSession())} />
          <DebugOverlay appWide />
          </GameClockProvider>
        </NarrationPlayerProvider>
      )}
      <CoachOverlay />
    </CoachProvider>
  )
}
