import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { playScreenUpdatePing } from '../screenUpdatePing.js'

// Persistent narration player — "Dock Bar" concept settled after the three-way mockup
// comparison (see project_poi_narration_feature memory). Mounted once at the App root (outside
// <Routes>, see App.jsx) so the <audio> element and its playback state survive navigation —
// closing a DetailPopup or hitting its back button must NOT stop or reset playback.
const NarrationPlayerContext = createContext(null)

export function useNarrationPlayer() {
  const ctx = useContext(NarrationPlayerContext)
  if (!ctx) throw new Error('useNarrationPlayer must be used within NarrationPlayerProvider')
  return ctx
}

const SPEEDS = [0.75, 1, 1.25, 1.5]

function fmt(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0
  const m = Math.floor(seconds / 60)
  const r = Math.floor(seconds % 60)
  return `${m}:${r < 10 ? '0' : ''}${r}`
}

// Same speaker glyph everywhere the player appears (entry button, minimised badge, expanded
// header) — settled as "this is the same object in three states", not three different icons.
export function NarrationSpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5L6 9H3v6h3l5 4V5z" fill="currentColor" stroke="none" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18 6a8 8 0 0 1 0 12" />
    </svg>
  )
}
function PlayIcon() {
  return <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
}
function PauseIcon() {
  return <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
}
function Back10Icon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M9 12h6" />
    </svg>
  )
}
function Fwd10Icon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: 'scaleX(-1)' }}>
      <path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M9 12h6M12 9v6" />
    </svg>
  )
}
function ChevronDownIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 9l6 6 6-6" /></svg>
}
function CloseIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
}

export function NarrationPlayerProvider({ children }) {
  const audioRef = useRef(null)
  const [track, setTrack] = useState(null) // { src, title } | null
  const [playerState, setPlayerState] = useState('hidden') // 'hidden' | 'mini' | 'expanded'
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [bonusToast, setBonusToast] = useState(null) // { playerName } | null

  // "Fully listened, not skipped" bonus tracking (see project_poi_narration_feature memory for
  // the coverage-based design this implements). coveredSecondsRef accumulates which integer
  // seconds of the track have actually been played through in real time — a forward skip (seek
  // bar or the ±10 buttons) just leaves a gap uncovered rather than permanently disqualifying the
  // listen, so scrubbing back to fill a gap before the track ends still earns the bonus.
  // reportedRef guards against reporting the same completed listen twice (e.g. if 'ended' fires
  // more than once) and resets only when a genuinely new track loads, not on pause/resume/reopen.
  const coveredSecondsRef = useRef(new Set())
  const lastTimeRef = useRef(0)
  const reportedRef = useRef(false)
  const lastBonusIdRef = useRef(undefined) // undefined = haven't polled yet (don't toast on first load)
  const toastTimeoutRef = useRef(null)

  async function pollLatestBonus() {
    try {
      const data = await api.getLatestNarrationBonus()
      if (lastBonusIdRef.current === undefined) {
        // First poll just establishes the baseline — the team may already have earned bonuses
        // before this device opened the app; those shouldn't retroactively toast/ping.
        lastBonusIdRef.current = data.id
        return
      }
      if (data.id != null && data.id !== lastBonusIdRef.current) {
        lastBonusIdRef.current = data.id
        playScreenUpdatePing()
        clearTimeout(toastTimeoutRef.current)
        setBonusToast({ playerName: data.playerName })
        toastTimeoutRef.current = setTimeout(() => setBonusToast(null), 4000)
        // Tells whichever page is currently mounted (Home/Play) to refetch its own score data —
        // see HomePage.jsx/PlayPage.jsx's own listener for this; simplest way to reach them from
        // here without restructuring their independent data-fetching into a shared context.
        window.dispatchEvent(new CustomEvent('tourz:score-changed', { detail: { totalScore: data.totalScore } }))
      }
    } catch {
      // Transient network hiccup — next poll tries again, nothing to recover here.
    }
  }

  useEffect(() => {
    pollLatestBonus()
    const id = setInterval(pollLatestBonus, 4000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    const onTime = () => {
      const t = audio.currentTime
      setCurrentTime(t)
      const last = lastTimeRef.current
      // Natural timeupdate deltas are small and positive; scale the "still natural playback"
      // ceiling by the current speed so 1.25x/1.5x (explicitly allowed) don't look like skips.
      // Generous (2.5s base) since timeupdate firing isn't perfectly regular.
      const maxNaturalDelta = 2.5 * (audio.playbackRate || 1)
      if (t > last && t - last <= maxNaturalDelta) {
        for (let s = Math.floor(last); s < Math.ceil(t); s++) coveredSecondsRef.current.add(s)
      }
      lastTimeRef.current = t
    }
    const onLoaded = () => setDuration(audio.duration)
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onEnded = () => {
      setIsPlaying(false)
      if (reportedRef.current) return
      const totalSeconds = Math.ceil(audio.duration || 0)
      const coverage = totalSeconds > 0 ? coveredSecondsRef.current.size / totalSeconds : 0
      // 95%, not 100% — the final fraction-of-a-second bucket near a non-integer duration can
      // legitimately never get marked covered by the integer-bucket math above.
      if (coverage >= 0.95 && track?.kind && track?.refId != null) {
        reportedRef.current = true
        api.completeNarrationListen(
          track.kind === 'landmark' ? { landmarkSequenceOrder: track.refId } : { siteId: track.refId }
        ).then((res) => {
          if (res?.awarded) pollLatestBonus() // don't make this device wait up to 4s for its own toast
        }).catch(() => {})
      }
    }
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('loadedmetadata', onLoaded)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('loadedmetadata', onLoaded)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
    }
  }, [track])

  function open({ src, title, kind, refId }) {
    const audio = audioRef.current
    const isSameTrack = track?.src === src
    setTrack({ src, title, kind, refId })
    setPlayerState('expanded')
    if (!isSameTrack) {
      audio.src = src
      audio.currentTime = 0
      audio.playbackRate = playbackRate
      coveredSecondsRef.current = new Set()
      lastTimeRef.current = 0
      reportedRef.current = false
    }
    audio.play()
  }
  function togglePlay() {
    const audio = audioRef.current
    if (audio.paused) audio.play()
    else audio.pause()
  }
  function skip(delta) {
    const audio = audioRef.current
    audio.currentTime = Math.max(0, Math.min(audio.duration || Infinity, audio.currentTime + delta))
  }
  function seekToFraction(frac) {
    const audio = audioRef.current
    if (audio.duration) audio.currentTime = frac * audio.duration
  }
  function setSpeed(rate) {
    audioRef.current.playbackRate = rate
    setPlaybackRate(rate)
  }
  function minimize() { setPlayerState('mini') }
  function expand() { setPlayerState('expanded') }
  function close() {
    const audio = audioRef.current
    audio.pause()
    audio.currentTime = 0
    setPlayerState('hidden')
    setTrack(null)
  }

  const value = { track, playerState, isPlaying, currentTime, duration, playbackRate, open, togglePlay, skip, seekToFraction, setSpeed, minimize, expand, close }
  const frac = duration ? currentTime / duration : 0

  return (
    <NarrationPlayerContext.Provider value={value}>
      {children}
      <audio ref={audioRef} preload="metadata" />
      {bonusToast && (
        <div className="narration-bonus-toast" role="status">
          <NarrationSpeakerIcon />
          <span><strong>{bonusToast.playerName}</strong> listened all the way through — +1 point!</span>
        </div>
      )}
      {playerState !== 'hidden' && track && (
        <div className="narration-player">
          {playerState === 'expanded' ? (
            <div className="narration-panel">
              <div className="narration-top-row">
                <div className="narration-wave"><NarrationSpeakerIcon /></div>
                <div className="narration-meta"><div className="narration-title">{track.title}</div></div>
                <button type="button" data-coach-id="narration-minimize-btn" className="narration-icon-btn narration-min-btn" onClick={minimize} aria-label="Minimise">
                  <ChevronDownIcon />
                </button>
                <button type="button" className="narration-icon-btn narration-close-btn" onClick={close} aria-label="Close">
                  <CloseIcon />
                </button>
              </div>
              <div className="narration-time-row">
                <span className="narration-time">{fmt(currentTime)}</span>
                <div
                  className="narration-progress"
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect()
                    seekToFraction((e.clientX - rect.left) / rect.width)
                  }}
                >
                  <div className="narration-progress-fill" style={{ width: `${frac * 100}%` }} />
                  <div className="narration-progress-thumb" style={{ left: `${frac * 100}%` }} />
                </div>
                <span className="narration-time">{fmt(duration)}</span>
              </div>
              <div className="narration-ctrl-row">
                <button type="button" className="narration-icon-btn narration-skip-btn" onClick={() => skip(-10)} aria-label="Back 10 seconds">
                  <Back10Icon /><span>10</span>
                </button>
                <button type="button" data-coach-id="narration-play-btn" className="narration-icon-btn narration-play-btn" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
                  {isPlaying ? <PauseIcon /> : <PlayIcon />}
                </button>
                <button type="button" className="narration-icon-btn narration-skip-btn" onClick={() => skip(10)} aria-label="Forward 10 seconds">
                  <Fwd10Icon /><span>10</span>
                </button>
              </div>
              <div className="narration-speed-pills" role="group" aria-label="Playback speed">
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`narration-speed-pill${playbackRate === s ? ' active' : ''}`}
                    onClick={() => setSpeed(s)}
                  >
                    {s}&#215;
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="narration-mini" onClick={expand} role="button" aria-label="Expand narration player">
              <NarrationSpeakerIcon />
              <button
                type="button"
                data-coach-id="narration-mini-close-btn"
                className="narration-icon-btn narration-mini-close"
                onClick={(e) => {
                  // The visible badge is only 15px, tucked onto the icon's corner (see
                  // .narration-mini-close) — its full square hit box was closing the player on
                  // taps that were clearly aimed at the icon, not the X. Requiring the tap to land
                  // near the glyph's own center (not just anywhere in the button's box) before
                  // treating it as "close", and otherwise letting the click bubble up to expand()
                  // on .narration-mini, keeps the badge's look/position untouched while fixing that.
                  const rect = e.currentTarget.getBoundingClientRect()
                  const dx = e.clientX - (rect.left + rect.width / 2)
                  const dy = e.clientY - (rect.top + rect.height / 2)
                  if (Math.hypot(dx, dy) <= 5) {
                    e.stopPropagation()
                    close()
                  }
                }}
                aria-label="Close"
              >
                <CloseIcon />
              </button>
            </div>
          )}
        </div>
      )}
    </NarrationPlayerContext.Provider>
  )
}
