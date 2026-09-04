import { useEffect } from 'react'

// Keeps the screen from auto-locking while an active gameplay screen is open in the foreground —
// screen-lock is one of the two triggers (along with switching to another app, which this can't
// do anything about) that makes mobile browsers suspend GPS/polling entirely, per feedback memory
// on the "app stalls after 10 min idle" bug. Unsupported browsers and denied/interrupted requests
// (e.g. battery saver) just silently proceed without it — there's no fallback that makes sense
// here beyond the resume-recovery this is paired with.
export function useWakeLock() {
  useEffect(() => {
    let sentinel = null

    async function acquire() {
      try {
        if ('wakeLock' in navigator) sentinel = await navigator.wakeLock.request('screen')
      } catch {
        // Not fatal — the resume-recovery handling elsewhere covers the case where the screen
        // locked anyway.
      }
    }
    acquire()

    // The lock is auto-released by the browser whenever the tab is hidden — re-acquire once the
    // player comes back rather than leaving the rest of the session unprotected.
    function onVisible() {
      if (document.visibilityState === 'visible' && !sentinel) acquire()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      sentinel?.release().catch(() => {})
    }
  }, [])
}
