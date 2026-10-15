import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import type { ChatBlock, ChatMessage } from './protocol'
import { SendIcon, StopIcon, TerminalIcon } from './icons'

export interface PermissionPrompt {
  message: string | null
}

export function ChatView({
  messages,
  truncated,
  loaded,
  working,
  alive,
  connected,
  permission,
  hooksMissing,
  onSend,
  onStop,
  onKey,
  onViewTerminal,
}: {
  messages: ChatMessage[]
  truncated: boolean
  /** The first chat.history arrived. */
  loaded: boolean
  working: boolean
  alive: boolean
  connected: boolean
  permission: PermissionPrompt | null
  hooksMissing: boolean
  /** Returns false when the text could not be sent (keep the draft). */
  onSend: (text: string) => boolean
  onStop: () => void
  onKey: (seq: string) => void
  onViewTerminal: () => void
}) {
  const [draft, setDraft] = useState('')
  const [atBottom, setAtBottom] = useState(true)
  const [unseen, setUnseen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const lastStop = useRef(0)

  // Pin to the bottom while the user is there; otherwise flag new messages.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    if (atBottom) el.scrollTop = el.scrollHeight
    else setUnseen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, working, permission])

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [draft])

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAtBottom(bottom)
    if (bottom) setUnseen(false)
  }

  const jumpDown = () => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
    setAtBottom(true)
    setUnseen(false)
  }

  const send = () => {
    if (onSend(draft)) {
      setDraft('')
      jumpDown()
    }
  }

  const stop = () => {
    const now = Date.now()
    if (now - lastStop.current < 1000) return
    lastStop.current = now
    onStop()
  }

  const disabled = !alive || !connected
  const note = !connected
    ? 'Not connected'
    : !alive
      ? "Claude isn't running — open the terminal"
      : permission
        ? 'Answer the permission prompt first'
        : null

  return (
    <div className="chat">
      {hooksMissing && (
        <div className="chat-banner">
          Turn on Claude notifications on the desktop so chat can show permission prompts and
          follow /clear.
        </div>
      )}
      <div className="chat-list" ref={listRef} onScroll={onScroll}>
        {truncated && <div className="chat-divider">Earlier messages are in the terminal</div>}
        {loaded && messages.length === 0 && (
          <div className="chat-empty">Send a message to start.</div>
        )}
        {messages.map((m) => (
          <Message key={m.id} m={m} />
        ))}
        {working && <div className="chat-working">Claude is working…</div>}
        {permission && (
          <div className="chat-perm">
            <div className="chat-perm-msg">{permission.message ?? 'Claude needs your permission'}</div>
            {/* Claude Code's menu labels and option count vary, and a digit alone selects. */}
            <div className="chat-perm-keys">
              {['1', '2', '3', '4'].map((k) => (
                <button key={k} className="btn" onClick={() => onKey(k)}>
                  {k}
                </button>
              ))}
              <button className="btn" onClick={() => onKey('\x1b')}>
                Esc — reject &amp; stop
              </button>
            </div>
            <button className="chat-link" onClick={onViewTerminal}>
              <TerminalIcon size={13} /> View in terminal
            </button>
          </div>
        )}
      </div>
      {unseen && !atBottom && (
        <button className="chat-pill" onClick={jumpDown}>
          New messages ↓
        </button>
      )}
      <div className="composer">
        {note && <div className="composer-note">{note}</div>}
        <div className="composer-row">
          <textarea
            ref={inputRef}
            className="composer-input"
            rows={1}
            placeholder="Message Claude"
            value={draft}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
          />
          {working && alive && (
            <button className="composer-btn stop" onClick={stop} aria-label="Stop">
              <StopIcon size={16} />
            </button>
          )}
          <button
            className="composer-btn"
            onClick={send}
            // The Enter after the paste would confirm the dialog's highlighted option.
            disabled={disabled || !!permission || !draft.trim()}
            aria-label="Send"
          >
            <SendIcon size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}

function Message({ m }: { m: ChatMessage }) {
  if (m.role === 'divider') {
    const b = m.blocks[0]
    return <div className="chat-divider">{b?.kind === 'divider' ? b.label : ''}</div>
  }
  return (
    <div className={`chat-msg ${m.role}`}>
      {m.blocks.map((b, i) => (
        <Block key={i} b={b} user={m.role === 'user'} />
      ))}
    </div>
  )
}

function Block({ b, user }: { b: ChatBlock; user: boolean }) {
  const [open, setOpen] = useState(false)
  switch (b.kind) {
    case 'text':
      return user ? (
        <div className="bubble">{b.text}</div>
      ) : (
        <div className="md">
          <Markdown
            disallowedElements={['img']}
            components={{
              a: (p) => (
                <a href={p.href} target="_blank" rel="noreferrer">
                  {p.children}
                </a>
              ),
            }}
          >
            {b.text}
          </Markdown>
        </div>
      )
    case 'image':
      return <div className="chat-image">[image]</div>
    case 'divider':
      return <div className="chat-divider">{b.label}</div>
    case 'toolUse': {
      const mark = b.result === null ? '…' : b.result.ok ? '✓' : '✗'
      return (
        <div className={`tool ${b.result && !b.result.ok ? 'err' : ''}`}>
          <button className="tool-row" onClick={() => setOpen((o) => !o)}>
            <span className="tool-name">{b.name}</span>
            <span className="tool-sum">{b.summary}</span>
            <span className="tool-mark">{mark}</span>
          </button>
          {open && b.result && <pre className="tool-out">{b.result.preview || '(no output)'}</pre>}
        </div>
      )
    }
  }
}
