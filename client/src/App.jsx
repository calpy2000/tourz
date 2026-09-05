import { Routes, Route, Navigate } from 'react-router-dom'
import StartPage from './pages/StartPage.jsx'
import WelcomePage from './pages/WelcomePage.jsx'
import InstructionsPage from './pages/InstructionsPage.jsx'
import HomePage from './pages/HomePage.jsx'
import PlayPage from './pages/PlayPage.jsx'
import CertificatePage from './pages/CertificatePage.jsx'
import { getSession } from './localSession.js'
import { APP_VERSION } from './version.js'
import { DEV_MODE } from './devMode.js'

// /home, /play, /instructions all need a real registered player — without a session there's no
// team for the API to resolve, so bounce back to registration rather than showing a broken page.
function RequireSession({ children }) {
  return getSession() ? children : <Navigate to="/" replace />
}

// Landmark and site detail views are no longer routes — they open as a DetailPopup overlay on
// whatever page triggered them (Home, Map, or mid-play) instead of navigating away. See
// project-landmark-detail-feature memory for the design history of the page this replaced.
export default function App() {
  return (
    <>
      {DEV_MODE && <div className="app-version-badge">{APP_VERSION}</div>}
      <Routes>
        <Route path="/" element={<StartPage />} />
        <Route path="/welcome" element={<RequireSession><WelcomePage /></RequireSession>} />
        <Route path="/instructions" element={<RequireSession><InstructionsPage /></RequireSession>} />
        <Route path="/home" element={<RequireSession><HomePage /></RequireSession>} />
        <Route path="/play" element={<RequireSession><PlayPage /></RequireSession>} />
        <Route path="/certificate" element={<RequireSession><CertificatePage /></RequireSession>} />
      </Routes>
    </>
  )
}
