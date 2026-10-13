import { useEffect, useMemo, useRef, useState } from 'react'
import { paletteItems } from '../../commands/app-commands'
import { rankItems, type RankedItem } from '../../lib/palette'
import { useUi } from '../../state/ui'

/**
 * Closing on a key press hands focus back to the terminal before the key is
 * released, so a held Enter or Esc would auto-repeat into the agent (approving
 * a prompt, or interrupting it). This eats those repeats until the key is up.
 */
function swallowRepeats(key: string): void {
  const down = (e: KeyboardEvent): void => {
    if (e.key === key && e.repeat) {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
  }
  const up = (e: KeyboardEvent): void => {
    if (e.key !== key) return
    window.removeEventListener('keydown', down, true)
    window.removeEventListener('keyup', up, true)
  }
  window.addEventListener('keydown', down, true)
  window.addEventListener('keyup', up, true)
}

/**
 * Finds and runs commands, and jumps to terminals and projects. The text field
 * only filters this fixed list; nothing typed here reaches an agent or a shell.
 */
export function CommandPalette() {
  const close = useUi((s) => s.closePalette)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const items = useMemo(() => paletteItems(), [])
  const results = useMemo(() => rankItems(query, items), [query, items])

  // Give focus back to whatever had it (normally the terminal) when the
  // palette goes away, however it was closed. An item that moves focus itself
  // does so in an effect, which runs after this cleanup and therefore wins.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    inputRef.current?.focus()
    return () => previous?.focus()
  }, [])

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const choose = (item: RankedItem | undefined): void => {
    if (!item) return
    close()
    item.run()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      // Stopped here so the same press does not also close Settings underneath.
      e.preventDefault()
      e.stopPropagation()
      swallowRepeats(e.key)
      close()
    } else if (e.key === 'Tab') {
      // Tabbing out would hand the keyboard to the terminal behind the palette.
      e.preventDefault()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.max(0, Math.min(s + 1, results.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      swallowRepeats(e.key)
      choose(results[selected])
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex justify-center bg-black/40 pt-[12vh]" onClick={close}>
      <div
        className="flex h-fit max-h-[70vh] w-[640px] max-w-[90vw] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => {
          // Clicking the list or footer must not take focus from the field.
          if (e.target !== inputRef.current) e.preventDefault()
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSelected(0)
          }}
          placeholder="Search commands, terminals and projects…"
          aria-label="Command palette"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-foreground outline-none placeholder:text-muted"
        />
        <div ref={listRef} className="min-h-0 flex-1 overflow-auto py-1">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted">Nothing matches</div>
          ) : (
            results.map((item, i) => (
              <div
                key={item.key}
                data-idx={i}
                onClick={() => choose(item)}
                onMouseMove={(e) => {
                  // Only a real pointer move selects; rows sliding under a
                  // resting pointer must not steal the selection from Enter.
                  if (e.movementX !== 0 || e.movementY !== 0) setSelected(i)
                }}
                className={`flex cursor-pointer items-center gap-3 px-4 py-1.5 text-sm ${
                  i === selected ? 'bg-accent/15' : ''
                }`}
              >
                <Highlighted text={item.title} indices={item.indices} />
                <span className="ml-auto flex-shrink-0 text-[11px] text-muted">{item.hint}</span>
              </div>
            ))
          )}
        </div>
        <div className="flex items-center justify-between border-t border-border px-4 py-1.5 text-[11px] text-muted">
          <span>Type &gt; for commands only</span>
          <span>↑↓ navigate · ↵ run · esc close</span>
        </div>
      </div>
    </div>
  )
}

function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  // `indices` are UTF-16 offsets; iterating by code point keeps emoji whole, so
  // the offset is tracked separately from the loop index.
  const matched = new Set(indices)
  let offset = 0
  return (
    <span className="min-w-0 truncate text-foreground">
      {[...text].map((ch, i) => {
        const at = offset
        offset += ch.length
        return (
          <span key={i} className={matched.has(at) ? 'font-semibold text-accent' : undefined}>
            {ch}
          </span>
        )
      })}
    </span>
  )
}
