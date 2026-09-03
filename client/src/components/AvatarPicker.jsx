import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Picker } from 'emoji-mart'
import emojiData from '@emoji-mart/data'

// Three curated rows shown by default — a shared skin-tone row (below) drives the People row;
// Smileys and Fun extras don't carry skin tones so they're plain static lists.
const TOP_PEOPLE_TYPES = [
  { base: '🧑', name: 'Person' },
  { base: '👩', name: 'Woman' },
  { base: '👨', name: 'Man' },
  { base: '👧', name: 'Girl' },
  { base: '👦', name: 'Boy' },
  { base: '👵', name: 'Older woman' },
  { base: '👴', name: 'Older man' },
  { base: '🧔', name: 'Bearded person' },
]
const ROW_SMILEYS = ['😀', '😎', '🥳', '🤠', '🥸', '🤓', '😇', '🤩']
const ROW_FUN = ['🦁', '🐯', '🐨', '🦊', '🦄', '🐙', '🧙', '👑']

// Hair-style variants (person/woman/man × red/curly/white/bald/blond, plus beard) are ZWJ
// sequences — the tone modifier has to land right after the base character and *before* the ZWJ
// join, e.g. 🧑🏽‍🦰 not 🧑‍🦰🏽 — so each entry carries the join as a separate `suffix` appended
// after the tone instead of baking it into `base`.
const ZWJ = '‍'
const MALE_SIGN = '♂️'
const FEMALE_SIGN = '♀️'
const RED_HAIR = '\u{1F9B0}'
const CURLY_HAIR = '\u{1F9B1}'
const WHITE_HAIR = '\u{1F9B3}'
const BALD = '\u{1F9B2}'

// Matches the set shown in Windows' own emoji picker: the 18 person/woman/man hair variants,
// then bearded person, older person, old man/woman, and girl.
const PEOPLE_BASES = [
  { id: 'person', base: '🧑', name: 'Person', suffix: '' },
  { id: 'person_red', base: '🧑', name: 'Person: red hair', suffix: ZWJ + RED_HAIR },
  { id: 'person_curly', base: '🧑', name: 'Person: curly hair', suffix: ZWJ + CURLY_HAIR },
  { id: 'person_white', base: '🧑', name: 'Person: white hair', suffix: ZWJ + WHITE_HAIR },
  { id: 'person_bald', base: '🧑', name: 'Person: bald', suffix: ZWJ + BALD },
  { id: 'person_blond', base: '👱', name: 'Person: blond hair', suffix: '' },
  { id: 'woman_blond', base: '👱', name: 'Woman: blond hair', suffix: ZWJ + FEMALE_SIGN },
  { id: 'man_blond', base: '👱', name: 'Man: blond hair', suffix: ZWJ + MALE_SIGN },
  { id: 'woman', base: '👩', name: 'Woman', suffix: '' },
  { id: 'woman_red', base: '👩', name: 'Woman: red hair', suffix: ZWJ + RED_HAIR },
  { id: 'woman_curly', base: '👩', name: 'Woman: curly hair', suffix: ZWJ + CURLY_HAIR },
  { id: 'woman_white', base: '👩', name: 'Woman: white hair', suffix: ZWJ + WHITE_HAIR },
  { id: 'woman_bald', base: '👩', name: 'Woman: bald', suffix: ZWJ + BALD },
  { id: 'man', base: '👨', name: 'Man', suffix: '' },
  { id: 'man_red', base: '👨', name: 'Man: red hair', suffix: ZWJ + RED_HAIR },
  { id: 'man_curly', base: '👨', name: 'Man: curly hair', suffix: ZWJ + CURLY_HAIR },
  { id: 'man_white', base: '👨', name: 'Man: white hair', suffix: ZWJ + WHITE_HAIR },
  { id: 'man_bald', base: '👨', name: 'Man: bald', suffix: ZWJ + BALD },
  { id: 'beard', base: '🧔', name: 'Bearded person', suffix: '' },
  { id: 'man_beard', base: '🧔', name: 'Man: beard', suffix: ZWJ + MALE_SIGN },
  { id: 'woman_beard', base: '🧔', name: 'Woman: beard', suffix: ZWJ + FEMALE_SIGN },
  { id: 'older_person', base: '🧓', name: 'Older person', suffix: '' },
  { id: 'old_man', base: '👴', name: 'Old man', suffix: '' },
  { id: 'old_woman', base: '👵', name: 'Old woman', suffix: '' },
  { id: 'girl', base: '👧', name: 'Girl', suffix: '' },
]
const SKIN_MODIFIERS = ['', '\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}']
const SKIN_COLORS = ['#ffcc4d', '#f7dece', '#f0c8a0', '#d8a876', '#ae7242', '#5c3d2e']

// Broader curated set for the Smileys category pinned ahead of the built-in ones inside the
// expanded emoji-mart picker.
const CUSTOM_SMILEYS = [
  '😀', '😃', '😄', '😁', '😆', '🙂', '😉', '😊',
  '😎', '🥳', '🤠', '🥸', '🤓', '😇', '🤩', '😏',
  '🥶', '🤯', '😴', '🤔', '😅', '🙃', '😌', '🤗',
]

function buildCustomCategory(id, name, emojis) {
  return {
    id,
    name,
    emojis: emojis.map((native, i) => ({
      id: `${id}_${i}`,
      name: native,
      keywords: [name.toLowerCase()],
      skins: [{ native }],
    })),
  }
}

function SkinToneRow({ skinIndex, onChange }) {
  return (
    <div className="skin-tone-row">
      <span className="skin-tone-label">Skin tone</span>
      <div className="skin-tone-swatches">
        {SKIN_COLORS.map((color, i) => (
          <button
            key={color}
            type="button"
            className={i === skinIndex ? 'skin-tone-swatch skin-tone-swatch-selected' : 'skin-tone-swatch'}
            style={{ background: color }}
            aria-label={`Skin tone ${i + 1}`}
            onClick={() => onChange(i)}
          />
        ))}
      </div>
    </div>
  )
}

function AvatarButton({ emoji, name, selected, onClick }) {
  return (
    <button
      type="button"
      className={selected ? 'avatar-btn avatar-btn-selected' : 'avatar-btn'}
      onClick={onClick}
      aria-label={name ? `Choose avatar: ${name}` : `Choose avatar ${emoji}`}
    >
      {emoji}
    </button>
  )
}

export default function AvatarPicker({ value, onChange, label }) {
  const [expanded, setExpanded] = useState(false)
  const [skinIndex, setSkinIndex] = useState(0)
  const pickerWrapRef = useRef(null)
  const pickerInstanceRef = useRef(null)

  // Lazily mount the real emoji-mart picker the first time it's expanded — Smileys, search and
  // every built-in category live here; People is the hand-built panel below, driven by the same
  // skin-tone state as the collapsed row above.
  useEffect(() => {
    if (!expanded || pickerInstanceRef.current || !pickerWrapRef.current) return
    const picker = new Picker({
      data: emojiData,
      custom: [buildCustomCategory('custom_smileys', 'Smileys', CUSTOM_SMILEYS)],
      categories: [
        'custom_smileys',
        'nature', 'foods', 'activity', 'places', 'objects', 'symbols', 'flags',
      ],
      set: 'native',
      theme: 'light',
      previewPosition: 'none',
      skinTonePosition: 'none',
      dynamicWidth: true,
      onEmojiSelect: (emoji) => {
        onChange(emoji.native)
        setExpanded(false)
      },
    })
    // The web component sets its own inline width/height on construction — override so it
    // actually stretches to the form width instead of the library's fixed default.
    picker.style.width = '100%'
    picker.style.maxWidth = '100%'
    pickerInstanceRef.current = picker
    pickerWrapRef.current.appendChild(picker)
  }, [expanded, onChange])

  return (
    <div className="avatar-picker">
      <div className="field-row">
        {label && <span className="field-row-label">{label}</span>}
        <div className="avatar-picker-preview-avatar">{value || '?'}</div>
        <span className="avatar-picker-preview-text">
          {value ? 'Selected' : 'None yet — pick below'}
        </span>
      </div>

      <div className="avatar-picker-row-label">People</div>
      <SkinToneRow skinIndex={skinIndex} onChange={setSkinIndex} />
      <div className="avatar-picker-grid">
        {TOP_PEOPLE_TYPES.map((p) => {
          const emoji = p.base + SKIN_MODIFIERS[skinIndex]
          return (
            <AvatarButton
              key={p.name}
              emoji={emoji}
              name={p.name}
              selected={emoji === value}
              onClick={() => onChange(emoji)}
            />
          )
        })}
      </div>

      <div className="avatar-picker-row-label">Smileys</div>
      <div className="avatar-picker-grid">
        {ROW_SMILEYS.map((emoji) => (
          <AvatarButton key={emoji} emoji={emoji} selected={emoji === value} onClick={() => onChange(emoji)} />
        ))}
      </div>

      <div className="avatar-picker-row-label">Fun &amp; extras</div>
      <div className="avatar-picker-grid">
        {ROW_FUN.map((emoji) => (
          <AvatarButton key={emoji} emoji={emoji} selected={emoji === value} onClick={() => onChange(emoji)} />
        ))}
      </div>

      <button type="button" className="avatar-picker-expand" onClick={() => setExpanded((e) => !e)}>
        {expanded ? 'Show fewer avatars' : 'Show more avatars'}
        <ChevronDown size={16} strokeWidth={3} className={expanded ? 'avatar-picker-chevron avatar-picker-chevron-open' : 'avatar-picker-chevron'} />
      </button>

      <div className={expanded ? 'avatar-picker-full avatar-picker-full-visible' : 'avatar-picker-full'}>
        <div className="avatar-picker-people-panel">
          <div className="avatar-picker-row-label">People</div>
          <SkinToneRow skinIndex={skinIndex} onChange={setSkinIndex} />
          <div className="avatar-picker-grid">
            {PEOPLE_BASES.map((p) => {
              const emoji = p.base + SKIN_MODIFIERS[skinIndex] + p.suffix
              return (
                <AvatarButton
                  key={p.id}
                  emoji={emoji}
                  name={p.name}
                  selected={emoji === value}
                  onClick={() => onChange(emoji)}
                />
              )
            })}
          </div>
        </div>
        <div ref={pickerWrapRef} />
      </div>
    </div>
  )
}
