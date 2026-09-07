import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import coachStepsRaw from '../content/coach-steps.csv?raw'
import { parseCsv } from './parseCsv.js'
import { resolveCoachId } from './targetMap.js'
import { api } from '../api.js'

// Row 1's own wording, reused whenever a later row writes "same" in its error_message/
// help_message column instead of retyping the standard text.
const DEFAULT_ERROR_MESSAGE = "That's not quite right — try again."
const DEFAULT_HELP_MESSAGE = 'Not quite — let me help you out.'

function resolveMessage(raw, fallback) {
  const trimmed = (raw || '').trim()
  if (trimmed.toLowerCase() === 'same') return fallback
  if (trimmed.toLowerCase() === 'no need') return ''
  return raw
}

// Augments each raw CSV row with `coachId` (the real data-coach-id to gate on, resolved from the
// row's plain-English location/target text — see targetMap.js) and expands the "same"/"no need"
// shorthand in error_message/help_message so authors don't have to retype the standard copy on
// every row.
const steps = parseCsv(coachStepsRaw).map((row) => ({
  ...row,
  coachId: resolveCoachId(row),
  error_message: resolveMessage(row.error_message, DEFAULT_ERROR_MESSAGE),
  help_message: resolveMessage(row.help_message, DEFAULT_HELP_MESSAGE),
}))

const CoachContext = createContext(null)

// Drives the "coach" guided-navigation tutorial (see project_guided_navigation_tutorial memory).
// Steps are authored in coach-steps.csv, not hardcoded here, so the sequence can grow without
// touching this file. Built into the real pages (data-coach-id attributes on real elements),
// not a separate mimic UI — see that memory for why.
export function CoachProvider({ children }) {
  const [active, setActive] = useState(false)
  const [stepIndex, setStepIndex] = useState(0)
  const [wrongAttempts, setWrongAttempts] = useState(0)

  const start = useCallback(() => {
    setStepIndex(0)
    setWrongAttempts(0)
    setActive(true)
  }, [])

  const stop = useCallback(() => setActive(false), [])

  const advance = useCallback(() => {
    setWrongAttempts(0)
    setStepIndex((i) => {
      const next = i + 1
      if (next >= steps.length) {
        setActive(false)
        api.markCoachComplete().catch(() => {})
        return i
      }
      return next
    })
  }, [])

  const registerWrongAttempt = useCallback(() => setWrongAttempts((n) => n + 1), [])

  const currentStep = steps[stepIndex] || null

  const value = useMemo(
    () => ({ active, steps, stepIndex, currentStep, wrongAttempts, start, stop, advance, registerWrongAttempt }),
    [active, stepIndex, currentStep, wrongAttempts, start, stop, advance, registerWrongAttempt],
  )

  return <CoachContext.Provider value={value}>{children}</CoachContext.Provider>
}

export function useCoach() {
  const ctx = useContext(CoachContext)
  if (!ctx) throw new Error('useCoach must be used within CoachProvider')
  return ctx
}
