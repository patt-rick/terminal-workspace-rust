import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatBlock, ChatMessage } from './protocol'
import { MAX_IMAGES, stripImagePlaceholders } from './chat-model'
import { prepareImage, type PreparedImage } from './images'
import { CloseIcon, ImageIcon, PaperclipIcon, SendIcon, StopIcon, TerminalIcon } from './icons'

export interface PermissionPrompt {
  message: string | null
}

/** Lines the composer grows to before it scrolls. */
const COMPOSER_MAX_LINES = 6

export function ChatView({
  messages,
  truncated,
  loaded,
  working,
  alive,
  connected,
  permission,
  permissionOptions,
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
  /** The open menu's option labels read from the terminal; empty when unknown. */
  permissionOptions: string[]
  hooksMissing: boolean
  /** Resolves to null once sent, or to why it wasn't (keep the draft). */
  onSend: (text: string, images: PreparedImage[]) => Promise<string | null>
  onStop: () => void
  onKey: (seq: string) => void
  onViewTerminal: () => void
}) {
  const [draft, setDraft] = useState('')
  const [images, setImages] = useState<PreparedImage[]>([])
  const [preparing, setPreparing] = useState(0)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [unseen, setUnseen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const lastStop = useRef(0)
  const imagesRef = useRef(images)
  imagesRef.current = images

  // Thumbnails are object URLs: free them when the view goes away.
  useEffect(() => () => imagesRef.current.forEach((i) => URL.revokeObjectURL(i.thumb)), [])

  // Pin to the bottom while the user is there; otherwise flag new messages.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    if (atBottom) el.scrollTop = el.scrollHeight
    else setUnseen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, working, permission, permissionOptions])

  // Grow with the text up to COMPOSER_MAX_LINES, then scroll inside.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    const cs = getComputedStyle(el)
    const frame =
      parseFloat(cs.paddingTop) +
      parseFloat(cs.paddingBottom) +
      parseFloat(cs.borderTopWidth) +
      parseFloat(cs.borderBottomWidth)
    const max = parseFloat(cs.lineHeight) * COMPOSER_MAX_LINES + frame
    el.style.height = 'auto'
    const needed = el.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
    el.style.height = `${Math.min(needed, max)}px`
    el.style.overflowY = needed > max + 1 ? 'auto' : 'hidden'
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

  const pick = async (files: FileList | null) => {
    if (!files?.length) return
    setError(null)
    const room = MAX_IMAGES - imagesRef.current.length - preparing
    const list = [...files]
    if (list.length > room) {
      setError(`You can attach up to ${MAX_IMAGES} images to a message.`)
    }
    const take = list.slice(0, Math.max(0, room))
    setPreparing((n) => n + take.length)
    for (const f of take) {
      try {
        const img = await prepareImage(f)
        setImages((cur) => [...cur, img])
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setPreparing((n) => n - 1)
      }
    }
  }

  const removeImage = (id: string) =>
    setImages((cur) => {
      const gone = cur.find((i) => i.id === id)
      if (gone) URL.revokeObjectURL(gone.thumb)
      return cur.filter((i) => i.id !== id)
    })

  const send = async () => {
    if (sending) return
    setError(null)
    setSending(true)
    const sent = images
    try {
      const err = await onSend(draft, sent)
      if (err) {
        setError(err)
        return
      }
      setDraft('')
      sent.forEach((i) => URL.revokeObjectURL(i.thumb))
      setImages((cur) => cur.filter((i) => !sent.includes(i)))
      jumpDown()
    } finally {
      setSending(false)
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
  const canSend =
    !disabled && !permission && !sending && preparing === 0 && (!!draft.trim() || images.length > 0)

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
        {messages.map((m, i) => (
          <Message key={m.id} m={m} cont={continuesTools(messages[i - 1], m)} />
        ))}
        {working && <div className="chat-working">Claude is working…</div>}
        {permission && (
          <div className="chat-perm">
            <div className="chat-perm-msg">{permission.message ?? 'Claude needs your permission'}</div>
            {permissionOptions.length > 0 ? (
              <div className="chat-perm-options">
                {permissionOptions.map((label, i) => (
                  <button key={i} className="chat-perm-option" onClick={() => onKey(String(i + 1))}>
                    <span className="chat-perm-num">{i + 1}</span>
                    <span className="chat-perm-label">{label}</span>
                  </button>
                ))}
                <button className="chat-perm-option esc" onClick={() => onKey('\x1b')}>
                  <span className="chat-perm-num">Esc</span>
                  <span className="chat-perm-label">Reject &amp; stop</span>
                </button>
              </div>
            ) : (
              // The menu couldn't be read: a digit alone still selects its option.
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
            )}
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
        {error && (
          <div className="composer-error" role="alert">
            {error}
          </div>
        )}
        {(images.length > 0 || preparing > 0) && (
          <div className="composer-thumbs">
            {images.map((img) => (
              <div className="thumb" key={img.id}>
                <img src={img.thumb} alt="" />
                <button
                  className="thumb-x"
                  onClick={() => removeImage(img.id)}
                  disabled={sending}
                  aria-label="Remove image"
                >
                  <CloseIcon size={11} />
                </button>
              </div>
            ))}
            {Array.from({ length: preparing }, (_, i) => (
              <div className="thumb loading" key={`p${i}`} aria-label="Preparing image" />
            ))}
          </div>
        )}
        <div className="composer-row">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void pick(e.target.files)
              e.target.value = '' // picking the same photo again still fires
            }}
          />
          <button
            className="composer-btn ghost"
            onClick={() => fileRef.current?.click()}
            disabled={disabled || sending || images.length + preparing >= MAX_IMAGES}
            aria-label="Attach images"
          >
            <PaperclipIcon size={17} />
          </button>
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
            className={`composer-btn ${sending ? 'busy' : ''}`}
            onClick={() => void send()}
            // The Enter after the paste would confirm the dialog's highlighted option.
            disabled={!canSend}
            aria-label={sending ? 'Sending' : 'Send'}
          >
            <SendIcon size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}

/** A message that starts with a tool call right after one that ended with one:
 *  drawn as part of the same run, so the tool rows stay evenly spaced. */
function continuesTools(prev: ChatMessage | undefined, m: ChatMessage): boolean {
  return (
    prev?.role === 'assistant' &&
    m.role === 'assistant' &&
    prev.blocks[prev.blocks.length - 1]?.kind === 'toolUse' &&
    m.blocks[0]?.kind === 'toolUse'
  )
}

function Message({ m, cont }: { m: ChatMessage; cont: boolean }) {
  if (m.role === 'divider') {
    const b = m.blocks[0]
    return <div className="chat-divider">{b?.kind === 'divider' ? b.label : ''}</div>
  }
  if (m.role === 'user') {
    const imageCount = m.blocks.filter((b) => b.kind === 'image').length
    return (
      <div className="chat-msg user">
        {imageCount > 0 && (
          <div className="chat-chips">
            {Array.from({ length: imageCount }, (_, i) => (
              <span className="chat-image" key={i}>
                <ImageIcon size={13} />
                Image{imageCount > 1 ? ` ${i + 1}` : ''}
              </span>
            ))}
          </div>
        )}
        {m.blocks.map((b, i) => {
          if (b.kind === 'image') return null
          if (b.kind === 'text') {
            const text = imageCount ? stripImagePlaceholders(b.text) : b.text
            return text ? (
              <div className="bubble" key={i}>
                {text}
              </div>
            ) : null
          }
          return <Block key={i} b={b} />
        })}
      </div>
    )
  }
  return (
    <div className={`chat-msg ${m.role}${cont ? ' cont' : ''}`}>
      {m.blocks.map((b, i) => (
        <Block key={i} b={b} />
      ))}
    </div>
  )
}

function Block({ b }: { b: ChatBlock }) {
  const [open, setOpen] = useState(false)
  switch (b.kind) {
    case 'text':
      return (
        <div className="md">
          <Markdown
            remarkPlugins={[remarkGfm]}
            disallowedElements={['img']}
            components={{
              a: (p) => (
                <a href={p.href} target="_blank" rel="noreferrer">
                  {p.children}
                </a>
              ),
              table: (p) => (
                <div className="md-table">
                  <table>{p.children}</table>
                </div>
              ),
            }}
          >
            {b.text}
          </Markdown>
        </div>
      )
    case 'image':
      return (
        <span className="chat-image">
          <ImageIcon size={13} />
          Image
        </span>
      )
    case 'divider':
      return <div className="chat-divider">{b.label}</div>
    case 'toolUse': {
      const mark = b.result === null ? '…' : b.result.ok ? '✓' : '✗'
      return (
        <div className={`tool ${b.result && !b.result.ok ? 'failed' : ''}`}>
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
