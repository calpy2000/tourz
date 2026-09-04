// Shared initial-load state for every page that waits on a first fetch before it has anything to
// render (StartPage, WelcomePage, InstructionsPage, HomePage, PlayPage) — replaces the old bare
// "Loading…" text with a spinner so a slow API call doesn't look like a blank/broken screen.
export default function LoadingScreen() {
  return (
    <div className="screen center">
      <div className="loading-spinner" />
      <p className="loading-text">The tour loading, this should only take a few moments</p>
    </div>
  )
}
