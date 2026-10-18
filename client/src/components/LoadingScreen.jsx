import { useConnection } from '../net/connection.js'

// Shared initial-load state for every page that waits on a first fetch before it has anything to
// render (StartPage, WelcomePage, InstructionsPage, HomePage, PlayPage) — replaces the old bare
// "Loading…" text with a spinner so a slow API call doesn't look like a blank/broken screen.
//
// `debugInfo` (dev-mode callers only, e.g. StartPage's dev-login/resume flow) renders as a small
// on-screen readout of what the stalled load is actually doing/waiting on/failed with — added
// after a real "stuck on this screen forever" report turned out to be a swallowed fetch error
// with nothing visible anywhere (not even a console message filtered differently than expected).
// Real players never pass this prop, so it's always absent outside DEV_MODE.
// With no signal and nothing saved on this phone yet (only possible before the tour has ever
// loaded here), says so instead of spinning silently.
export default function LoadingScreen({ debugInfo }) {
  const connection = useConnection()
  return (
    <div className="screen center">
      <div className="loading-spinner" />
      <p className="loading-text">
        {connection === 'offline'
          ? "No signal — the tour needs a connection the first time it loads on this phone. It'll carry on by itself as soon as you have signal."
          : 'The tour is loading, this should only take a few moments'}
      </p>
      {debugInfo && (
        <p
          style={{
            fontFamily: 'monospace',
            fontSize: 11,
            color: '#8a7a5c',
            background: '#f3ece0',
            border: '1px solid #d9cbb0',
            borderRadius: 6,
            padding: '8px 10px',
            marginTop: 16,
            maxWidth: 320,
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
            textAlign: 'left',
          }}
        >
          [dev debug] {debugInfo}
        </p>
      )}
    </div>
  )
}
