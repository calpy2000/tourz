import { useEffect, useRef } from 'react'

// Mobile browsers throttle or fully suspend setInterval polling while a tab is backgrounded or
// the screen is locked (see feedback memory on the "app stalls after 10 min idle" bug) — without
// this, a poll-driven screen just sits on whatever it last fetched until its own interval happens
// to fire again. Firing an immediate refresh the moment the tab is foregrounded again closes that
// gap instead of waiting up to a full poll cycle.
export function useRefreshOnResume(callback) {
  const callbackRef = useRef(callback)

  useEffect(() => {
    callbackRef.current = callback
  })

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') callbackRef.current()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])
}
