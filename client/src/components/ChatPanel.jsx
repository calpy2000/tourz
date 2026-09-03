import { useEffect, useRef, useState } from 'react'
import { ChevronUp, ChevronDown, Pencil, Send } from 'lucide-react'
import { api } from '../api.js'
import { getSession } from '../localSession.js'

const POLL_MS = 4000

function MessageRow({ message, myPlayerId }) {
  if (message.type !== 'chat') {
    return (
      <div className="chat-sys">
        <span>{message.text}</span>
      </div>
    )
  }
  const mine = message.playerId === myPlayerId
  return (
    <div className={mine ? 'chat-row chat-row-mine' : 'chat-row chat-row-theirs'}>
      {mine ? null : <div className="chat-av">{message.playerAvatar}</div>}
      <div className="chat-bubble">
        <b>{mine ? 'Me' : message.playerName}</b> &mdash; {message.text}
      </div>
      {mine ? <div className="chat-av">{message.playerAvatar}</div> : null}
    </div>
  )
}

// Single-line "latest message" preview shown on the collapsed bar — mirrors the same Me/Name
// convention as the full bubbles, but system messages (already carrying their own emoji, e.g.
// "🎉 Sarah has joined the team") render as plain text with no avatar, since there's no sender.
function LatestPreview({ message, myPlayerId }) {
  if (message.type !== 'chat') {
    return <div className="msg-text">{message.text}</div>
  }
  const mine = message.playerId === myPlayerId
  return (
    <>
      <div className="avatar">{message.playerAvatar}</div>
      <div className="msg-text"><strong>{mine ? 'Me' : message.playerName}</strong>&nbsp;&mdash; {message.text}</div>
    </>
  )
}

export default function ChatPanel() {
  const session = getSession()
  const [messages, setMessages] = useState([])
  const [mode, setMode] = useState('idle') // 'idle' | 'composing' | 'expanded'
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const sinceIdRef = useRef(0)
  const listRef = useRef(null)

  // Chat must never be able to block or break the rest of the game — every failure here is
  // swallowed and just tried again next cycle, same spirit as PlayPage's gameplay poll.
  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const res = await api.getMessages(sinceIdRef.current)
        if (cancelled || !res?.messages?.length) return
        setMessages((prev) => [...prev, ...res.messages])
        sinceIdRef.current = res.messages[res.messages.length - 1].id
      } catch {
        // offline/no signal — silently retry on the next tick
      }
    }
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  useEffect(() => {
    if (mode === 'expanded' && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [mode, messages])

  async function handleSend() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      const msg = await api.sendMessage(text)
      if (msg?.id) {
        setMessages((prev) => [...prev, msg])
        sinceIdRef.current = msg.id
        setDraft('')
        setMode((m) => (m === 'composing' ? 'idle' : m))
      }
    } catch {
      // leave the draft in the box so the player can just try again once back in signal
    } finally {
      setSending(false)
    }
  }

  const latest = messages[messages.length - 1]

  return (
    <>
      <div className="home-chat">
        <div className="home-chat-head">
          <span>Team feed</span>
          <button
            className="chat-icon-btn"
            aria-label={mode === 'expanded' ? 'Collapse chat' : 'Expand chat'}
            onClick={() => setMode((m) => (m === 'expanded' ? 'idle' : 'expanded'))}
          >
            {mode === 'expanded' ? <ChevronDown size={20} strokeWidth={3} /> : <ChevronUp size={20} strokeWidth={3} />}
          </button>
        </div>

        {mode === 'composing' ? (
          <div className="home-chat-compose">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSend() }}
              placeholder="Message your team…"
            />
            <button className="chat-send-btn" onClick={handleSend} disabled={!draft.trim() || sending} aria-label="Send">
              <Send size={15} />
            </button>
          </div>
        ) : (
          <div className="home-chat-msg">
            {latest ? <LatestPreview message={latest} myPlayerId={session?.playerId} /> : <div className="msg-text muted">No messages yet — say hello!</div>}
            <button className="chat-compose-btn" onClick={() => setMode('composing')} aria-label="New message">
              <Pencil size={14} />
            </button>
          </div>
        )}
      </div>

      {mode === 'expanded' && (
        <div className="chat-sheet">
          <div className="chat-sheet-head">
            <span>Team feed</span>
            <button className="chat-icon-btn" aria-label="Collapse chat" onClick={() => setMode('idle')}>
              <ChevronDown size={22} strokeWidth={3} />
            </button>
          </div>
          <div className="chat-sheet-msgs" ref={listRef}>
            {messages.length === 0 && <div className="chat-empty">No messages yet — say hello!</div>}
            {messages.map((m) => <MessageRow key={m.id} message={m} myPlayerId={session?.playerId} />)}
          </div>
          <div className="chat-sheet-compose">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSend() }}
              placeholder="Message your team…"
            />
            <button className="chat-send-btn" onClick={handleSend} disabled={!draft.trim() || sending} aria-label="Send">
              <Send size={16} />
            </button>
          </div>
        </div>
      )}
    </>
  )
}
