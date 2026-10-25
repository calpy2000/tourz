// Regression phase 1 — tour content, straight from the local database and the files on disk.
// Catches the content mistakes the app itself can't recover from: a missing photo or MP3, a quiz
// whose right answer isn't among its options, an anagram whose letters don't spell the answer,
// a POI pinned outside its tour's map, narration audio made from out-of-date text.
//
// Read-only. Run on its own:  node scripts/regression/content.mjs

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { makeRecorder, root } from './lib/common.mjs'

const PHOTOS = path.join(root, 'server/content-photos')
const AUDIO = path.join(root, 'server/content-audio')
const exists = (dir, f) => Boolean(f) && fs.existsSync(path.join(dir, f))
const letters = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '').split('').sort().join('')

export async function runContentPhase({ db }) {
  const rec = makeRecorder('content')
  const mapAssets = JSON.parse(fs.readFileSync(path.join(root, 'client/src/map/mapAssets.json'), 'utf8'))
  const { rows: tours } = await db.query('SELECT * FROM tours ORDER BY id')
  rec('there are tours in the local database', tours.length > 0, tours.map((t) => t.tour_code).join(', '))

  for (const tour of tours) {
    const T = tour.tour_code
    await rec.section(`${T}: content`, async () => {
      const { rows: landmarks } = await db.query(
        `SELECT l.*, c.clue_text, p.type AS puzzle_type, p.question_text AS puzzle_question, p.answer_payload AS puzzle_answer, c.id AS clue_id
         FROM landmarks l LEFT JOIN clues c ON c.landmark_id = l.id LEFT JOIN puzzles p ON p.landmark_id = l.id
         WHERE l.tour_id = $1 ORDER BY l.sequence_order`, [tour.id])
      const playable = landmarks.filter((l) => l.puzzle_type)
      rec(`${T}: landmark count matches the tour's planned total`, landmarks.length === tour.total_landmarks, `${landmarks.length}/${tour.total_landmarks}`)
      const seqs = landmarks.map((l) => l.sequence_order)
      rec(`${T}: landmark numbers run 1..N with no gaps`, seqs.every((s, i) => s === i + 1), seqs.join(','))
      rec(`${T}: has a time limit`, tour.time_limit_minutes > 0, `${tour.time_limit_minutes} min`)

      // Map file + bounds
      const map = mapAssets.tours[T]
      rec(`${T}: has a built offline map`, Boolean(map))
      const mapFile = map && path.join(root, 'client/public', map.file)
      rec(`${T}: map file is on disk at the recorded size`, map && fs.existsSync(mapFile) && fs.statSync(mapFile).size === map.bytes, map?.file)
      const inMap = (lat, lng) => !map || (lng >= map.bbox[0] && lng <= map.bbox[2] && lat >= map.bbox[1] && lat <= map.bbox[3])

      // Landmarks
      const problems = []
      const noAudio = []
      for (const l of landmarks) {
        const name = `L${l.sequence_order} ${l.title}`
        if (!l.title?.trim()) problems.push(`${name}: no title`)
        if (!Number.isFinite(Number(l.latitude)) || !inMap(Number(l.latitude), Number(l.longitude))) problems.push(`${name}: pin outside the map (${l.latitude}, ${l.longitude})`)
        const { rows: imgs } = await db.query('SELECT image_path FROM landmark_images WHERE landmark_id = $1', [l.id])
        if (!imgs.length) problems.push(`${name}: no photo`)
        for (const i of imgs) if (!exists(PHOTOS, i.image_path)) problems.push(`${name}: photo file missing ${i.image_path}`)
        if (l.audio_path && !exists(AUDIO, l.audio_path)) problems.push(`${name}: narration file missing ${l.audio_path}`)
        if (!l.audio_path) noAudio.push(name)
        if (!l.about_landmark_text?.trim()) problems.push(`${name}: no "about" text`)
        if (!l.puzzle_type) continue

        if (!l.clue_text?.trim()) problems.push(`${name}: no clue`)
        if (!l.puzzle_question?.trim()) problems.push(`${name}: no Prove it question`)
        const pa = l.puzzle_answer
        if (l.puzzle_type === 'exact_numeric' && (pa?.answer == null || String(pa.answer).trim() === '')) problems.push(`${name}: numeric answer missing`)
        if (l.puzzle_type === 'fuzzy_text' && !(Array.isArray(pa?.accepted) && pa.accepted.length && pa.accepted.every((a) => String(a).trim()))) problems.push(`${name}: no accepted text answers`)
        if (!['exact_numeric', 'fuzzy_text'].includes(l.puzzle_type)) problems.push(`${name}: unknown Prove it type ${l.puzzle_type}`)
        const { rows: hints } = await db.query('SELECT hint_order, hint_text FROM clue_hints WHERE clue_id = $1 ORDER BY hint_order', [l.clue_id])
        if (!hints.length) problems.push(`${name}: no hints`)
        if (!hints.every((h, i) => h.hint_order === i + 1 && h.hint_text?.trim())) problems.push(`${name}: hints not numbered 1..N or blank`)

        const { rows: quiz } = await db.query('SELECT * FROM quiz_questions WHERE landmark_id = $1 AND type = $2 ORDER BY sequence_order', [l.id, l.quiz_format])
        if (!quiz.length) { problems.push(`${name}: no ${l.quiz_format} quiz questions`); continue }
        for (const q of quiz) {
          const qn = `${name} quiz Q${q.sequence_order}`
          const a = q.answer_payload
          if (!q.question_text?.trim()) problems.push(`${qn}: no question text`)
          if (q.type === 'multiple_choice') {
            if (!Array.isArray(a?.options) || a.options.length < 2) problems.push(`${qn}: fewer than 2 options`)
            else if (!a.options.includes(a.correct)) problems.push(`${qn}: right answer "${a.correct}" isn't one of the options`)
            else if (new Set(a.options).size !== a.options.length) problems.push(`${qn}: duplicate options`)
          } else if (q.type === 'five_right') {
            const tiles = a?.tiles || []
            if (tiles.length < 2) problems.push(`${qn}: fewer than 2 tiles`)
            if (!tiles.some((t) => t.correct)) problems.push(`${qn}: no correct tiles`)
            if (new Set(tiles.map((t) => t.id)).size !== tiles.length) problems.push(`${qn}: duplicate tile ids`)
            for (const t of tiles) {
              if (!t.name?.trim()) problems.push(`${qn}: tile ${t.id} has no name`)
              if (t.imagePath && !exists(PHOTOS, t.imagePath)) problems.push(`${qn}: tile photo missing ${t.imagePath}`)
            }
          } else if (q.type === 'anagram') {
            if (!a?.solution || !a?.scrambled) problems.push(`${qn}: solution or scrambled letters missing`)
            else {
              if (letters(a.solution) !== letters(a.scrambled)) problems.push(`${qn}: scrambled letters don't spell "${a.solution}"`)
              if (a.rowCounts && a.rowCounts.reduce((s, n) => s + n, 0) !== a.scrambled.length) problems.push(`${qn}: rowCounts (${a.rowCounts}) don't add up to ${a.scrambled.length} tiles`)
              if (letters(a.solution) === letters(a.scrambled) && a.solution.replace(/\s/g, '').toLowerCase() === a.scrambled.replace(/\s/g, '').toLowerCase()) problems.push(`${qn}: "scrambled" is already the answer`)
            }
          } else problems.push(`${qn}: unknown quiz type ${q.type}`)
        }
        if (l.quiz_format === 'multiple_choice' && quiz.length !== 4) problems.push(`${name}: ${quiz.length} multiple-choice questions (scoring assumes 4)`)
      }
      rec(`${T}: every landmark's clue, hints, Prove it, quiz, photos and pin are valid`, problems.length === 0, problems.length ? `${problems.length} problem(s): ${problems.slice(0, 8).join(' | ')}` : `${landmarks.length} landmarks, ${playable.length} playable`)
      if (noAudio.length) rec.warn(`${T}: landmarks with no narration`, noAudio.join(', '))

      // POIs
      const { rows: sites } = await db.query('SELECT * FROM sites WHERE tour_id = $1 ORDER BY id', [tour.id])
      const siteProblems = []
      const siteNoAudio = []
      const siteNoPhoto = []
      const titles = new Map()
      for (const s of sites) {
        const name = `#${s.id} ${s.title}`
        if (!s.title?.trim()) siteProblems.push(`${name}: no title`)
        if (!inMap(Number(s.latitude), Number(s.longitude))) siteProblems.push(`${name}: pin outside the map`)
        if (s.image_path && !exists(PHOTOS, s.image_path)) siteProblems.push(`${name}: photo missing ${s.image_path}`)
        if (s.audio_path && !exists(AUDIO, s.audio_path)) siteProblems.push(`${name}: narration missing ${s.audio_path}`)
        if (!s.audio_path) siteNoAudio.push(name)
        if (!s.image_path) siteNoPhoto.push(name)
        if (!s.about_site_text?.trim()) siteProblems.push(`${name}: no "about" text`)
        const key = s.title?.trim().toLowerCase()
        titles.set(key, (titles.get(key) || 0) + 1)
      }
      rec(`${T}: every POI has a title, text, a pin on the map, and its photo/audio files`, siteProblems.length === 0, siteProblems.length ? `${siteProblems.length} problem(s): ${siteProblems.slice(0, 8).join(' | ')}` : `${sites.length} POIs`)
      if (siteNoPhoto.length) rec.warn(`${T}: POIs with no photo (the app shows them without one)`, siteNoPhoto.join(', '))
      if (siteNoAudio.length) rec.warn(`${T}: POIs with no narration`, `${siteNoAudio.length}: ${siteNoAudio.slice(0, 5).join(', ')}${siteNoAudio.length > 5 ? '…' : ''}`)
      const dupes = [...titles].filter(([, n]) => n > 1).map(([t]) => t)
      if (dupes.length) rec.warn(`${T}: POIs sharing a title`, dupes.join(', '))

      // Narration audio made from the current text (the project's own check, read-only).
      try {
        const out = execSync(`node scripts/tts-experiments/generate-port-louis-narration.js --check --tour ${T}`, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        rec(`${T}: every narration MP3 matches its current text`, true, out.trim().split('\n').pop())
      } catch (err) {
        rec(`${T}: every narration MP3 matches its current text`, false, (err.stdout || err.message).trim().split('\n').slice(-3).join(' | '))
      }
    })
  }

  await rec.section('files', async () => {
    const { rows: refs } = await db.query(`SELECT image_path AS f FROM sites UNION SELECT image_path FROM landmark_images`)
    const used = new Set(refs.map((r) => r.f))
    const orphans = fs.readdirSync(PHOTOS).filter((f) => /\.(jpe?g|png|webp)$/i.test(f) && !used.has(f))
    if (orphans.length) rec.warn('photos on disk that no landmark or POI uses (harmless, just disk space)', `${orphans.length}`)
    const { rows: dev } = await db.query(`SELECT code FROM game_codes WHERE code = 'DEV-LOCAL'`)
    rec('DEV-LOCAL game code is present (needed by Dev tools and the offline tests)', dev.length === 1)
  })

  return rec.results
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const { localDb } = await import('./lib/common.mjs')
  const db = await localDb()
  const results = await runContentPhase({ db })
  await db.end()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exitCode = failed.length ? 1 : 0
}
