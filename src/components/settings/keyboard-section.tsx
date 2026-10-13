import { useEffect, useMemo, useRef, useState } from 'react'
import { appCommands } from '../../commands/app-commands'
import {
  eventKey,
  formatKey,
  isBindableKey,
  isModifierKey,
  isReservedKey,
  resetCommand,
  terminalConsumes,
  withBinding,
  withInTerminal,
  withoutBinding,
} from '../../lib/keybindings'
import { isMac } from '../../lib/platform'
import { platformDefaults, useKeybindings } from '../../state/keybindings'
import { useSettings } from '../../state/settings'

interface Recording {
  command: string
  message: string | null
  /** a pressed key that another command already has */
  clash: { key: string; other: string } | null
}

const MOD_NAME = isMac ? 'Cmd' : 'Ctrl'

/**
 * Shortcuts are recorded by pressing them; there is no text field. While
 * recording, the press is stopped here so it neither runs its current command
 * nor closes Settings.
 */
export function KeyboardSection() {
  const overrides = useSettings((s) => s.keybindingOverrides)
  const setOverrides = useSettings((s) => s.setKeybindingOverrides)
  const bindings = useKeybindings()
  const defaults = platformDefaults()
  const known = useMemo(() => appCommands().map((c) => ({ id: c.id, title: c.title })), [])
  // A shortcut stored for a command that no longer exists still needs a row,
  // or nothing could remove it.
  const commands = useMemo(() => {
    const ids = new Set(known.map((c) => c.id))
    const orphans = Object.keys(overrides).filter((id) => !ids.has(id) && overrides[id].length > 0)
    return [...known, ...orphans.map((id) => ({ id, title: `Unknown command (${id})` }))]
  }, [known, overrides])
  const [recording, setRecording] = useState<Recording | null>(null)
  const recordRef = useRef<HTMLButtonElement>(null)

  // Focused explicitly: the "Add" and recording buttons share a DOM node, so
  // autoFocus would not fire, and not every webview focuses a button on click.
  const waitingFor = recording !== null && recording.clash === null ? recording.command : null
  useEffect(() => {
    if (waitingFor !== null) recordRef.current?.focus()
  }, [waitingFor])

  const titleOf = (id: string): string => commands.find((c) => c.id === id)?.title ?? id

  const assign = (command: string, key: string): void => {
    setOverrides(
      withBinding(overrides, defaults, command, { key, inTerminal: !terminalConsumes(key, isMac) })
    )
    setRecording(null)
  }

  const onRecordKey = (e: React.KeyboardEvent, command: string): void => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setRecording(null)
      return
    }
    if (isModifierKey(e.key)) return
    const key = eventKey(e, isMac)
    if (key === null) {
      setRecording({ command, message: `Use ${MOD_NAME} with a key`, clash: null })
      return
    }
    if (isReservedKey(key)) {
      setRecording({ command, message: 'That key is used for editing', clash: null })
      return
    }
    if (!isBindableKey(key)) {
      setRecording({ command, message: 'That key cannot be used', clash: null })
      return
    }
    const holder = bindings.find((b) => b.key === key)
    if (holder && holder.command !== command) {
      setRecording({ command, message: null, clash: { key, other: holder.command } })
      return
    }
    if (holder) {
      setRecording(null)
      return
    }
    assign(command, key)
  }

  return (
    <div className="mb-5">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Keyboard</div>
      <p className="mb-3 text-xs text-muted">
        “In terminal” decides whether a shortcut works while a terminal has focus. Off, it is
        ignored there, so a key the terminal uses goes to the program running in it.
      </p>
      <div className="flex flex-col">
        {commands.map((c) => {
          const keys = bindings.filter((b) => b.command === c.id)
          const active = recording?.command === c.id ? recording : null
          return (
            <div key={c.id} className="flex flex-col gap-1.5 border-b border-border/50 py-2 text-sm">
              <div className="flex items-start justify-between gap-3">
                <span className="pt-0.5 text-foreground/80">{c.title}</span>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {keys.map((b) => (
                    <span
                      key={b.key}
                      className="flex items-center gap-2 rounded-md border border-border px-2 py-0.5 text-xs"
                    >
                      <span className="text-foreground">{formatKey(b.key, isMac)}</span>
                      <label className="flex cursor-pointer items-center gap-1 text-muted">
                        <input
                          type="checkbox"
                          checked={b.inTerminal}
                          onChange={(e) =>
                            setOverrides(
                              withInTerminal(overrides, defaults, c.id, b.key, e.target.checked)
                            )
                          }
                        />
                        in terminal
                      </label>
                      <button
                        type="button"
                        onClick={() => setOverrides(withoutBinding(overrides, defaults, c.id, b.key))}
                        title="Remove shortcut"
                        className="text-muted hover:text-foreground"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                  {active && !active.clash ? (
                    <button
                      type="button"
                      ref={recordRef}
                      onKeyDown={(e) => onRecordKey(e, c.id)}
                      onBlur={() => setRecording((r) => (r !== null && r.clash === null ? null : r))}
                      className="rounded-md border border-accent px-2 py-0.5 text-xs text-accent outline-none"
                    >
                      Press a shortcut…
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setRecording({ command: c.id, message: null, clash: null })}
                      className="rounded-md border border-border px-2 py-0.5 text-xs text-muted hover:text-foreground"
                    >
                      Add
                    </button>
                  )}
                  {overrides[c.id] !== undefined && (
                    <button
                      type="button"
                      onClick={() => setOverrides(resetCommand(overrides, defaults, c.id))}
                      className="text-xs text-link hover:underline"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>
              {active?.message && <div className="text-right text-xs text-warning">{active.message}</div>}
              {active?.clash && (
                <div className="flex items-center justify-end gap-3 text-xs">
                  <span className="text-warning">
                    {formatKey(active.clash.key, isMac)} is used by {titleOf(active.clash.other)}
                  </span>
                  <button
                    type="button"
                    onClick={() => assign(c.id, active.clash!.key)}
                    className="text-link hover:underline"
                  >
                    Move it here
                  </button>
                  <button
                    type="button"
                    onClick={() => setRecording(null)}
                    className="text-muted hover:text-foreground"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={() => {
            setOverrides({})
            setRecording(null)
          }}
          disabled={Object.keys(overrides).length === 0}
          className="rounded-md border border-border px-3 py-1 text-xs text-muted hover:text-foreground disabled:opacity-40"
        >
          Reset all
        </button>
      </div>
    </div>
  )
}
