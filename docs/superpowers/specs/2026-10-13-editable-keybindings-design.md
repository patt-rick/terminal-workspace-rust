# Editable keybindings — design

Roadmap item 1.2 of `docs/superpowers/plans/2026-10-13-t3code-inspired-roadmap.md`. Builds
on the command registry and key table from the command palette
(`docs/superpowers/specs/2026-10-13-command-palette-design.md`).

## Problem

Shortcuts are a fixed table. Two things follow:

- Nobody can change a shortcut or give one to a command that has none (a theme, a settings
  tab, "Reveal project in file manager").
- On Windows and Linux, when a terminal has focus, the terminal takes every unshifted
  `Ctrl+letter` and the app never sees it. Confirmed in the running app on 2026-10-13:
  `Ctrl+T` in a focused terminal goes to the shell. So `Ctrl+T`, `Ctrl+W`, `Ctrl+P` and
  `Ctrl+B` only work when focus is elsewhere, and there is no way to choose otherwise.

## Decisions

- **Each shortcut carries an "in terminal" switch.** On: the app gets the key even while a
  terminal has focus. Off: the shortcut is ignored while a terminal has focus and the key
  goes to the program in the terminal. This is one rule on every platform.
- **Defaults reproduce today's behaviour exactly.** On Windows and Linux, `Ctrl+T`, `Ctrl+W`,
  `Ctrl+P` and `Ctrl+B` default to off (the terminal has them today) and everything else to
  on. On macOS everything defaults to on, because `Cmd` shortcuts already work there.
  Nothing changes for anyone until they flip a switch.
- **Any command can have any number of shortcuts**, including none.
- **Stored in the existing settings**, as overrides on top of the defaults, so it follows
  the same persistence as themes and editor preferences. The roadmap's separate
  `keybindings.json` is dropped: a second file and a watcher buy nothing a settings page
  does not.
- **A shortcut must include Ctrl (Cmd on macOS).** Bare keys and Alt combinations would
  collide with typing in the terminal.
- **Editing keys cannot be bound:** copy, paste, cut, select all, undo, redo and save
  (`mod+c`, `mod+v`, `mod+x`, `mod+a`, `mod+z`, `mod+y`, `mod+s`, `mod+shift+c`,
  `mod+shift+v`, `mod+shift+z`), and word-delete and caret movement (`mod` with Backspace,
  Delete, Home, End or an arrow, with or without Shift). The terminal, the editor and
  every text field own them.
- **The app's shortcuts yield to the editor.** If the editor already handled a key, the
  shortcut does not also run. One editor key is removed to keep a default working: on
  macOS the editor's `Cmd+Shift+U` (redo selection) gives way to Usage.
- **One key, one command.** Assigning a key that another command has asks first, then moves
  it.
- **Shortcuts are recorded by pressing them**, not typed. There is no text field.

## Model (`src/lib/keybindings.ts`, pure)

```ts
interface Keybinding { key: string; command: string; inTerminal: boolean }

/** per command: the complete list that replaces that command's defaults */
type KeybindingOverrides = Record<string, { key: string; inTerminal: boolean }[]>
```

- `defaultKeybindings(isMac)` — the existing table with `inTerminal` filled in:
  `palette.toggle` is always on; otherwise on unless `terminalConsumes(key, isMac)`.
- `terminalConsumes(key, isMac)` — true off macOS for the keys xterm sends to the shell:
  `mod+<a-z>`, `mod+space`, `mod+3` to `mod+8`, `mod+[`, `mod+\`, `mod+]`, and Enter,
  Backspace, Tab, Escape, Delete, Insert, Home, End, PageUp, PageDown, the arrows and the
  function keys with `mod` (with or without Shift).
- `effectiveKeybindings(defaults, overrides)` — defaults for commands with no override, plus
  every override entry. If two entries share a key, the override wins over the default and
  the later override wins over the earlier, so one key always resolves to one command.
- `bindingForEvent(event, isMac, bindings)` — the binding for a key press, or `null`.
- Editing helpers, each returning a new overrides object:
  `withBinding` (adds a key to a command and removes that key from every other command),
  `withoutBinding`, `withInTerminal`, `resetCommand`. After each, a command whose list
  equals its default list has its override removed, so "reset" and "set back by hand" end
  in the same state.
- `sanitizeOverrides(unknown)` — keeps only well-formed entries from stored data.
- `isReservedKey(key)`, `formatKey(key, isMac)`, `shortcutLabel(command, isMac, bindings)`.

## Behaviour

**Window handler (`src/app.tsx`).** If something else already handled the key (the editor
prevents the default for its own keys), do nothing. Otherwise look up the binding in the
current bindings; if there is none, do nothing. Prevent the default. If the binding's switch
is off and focus is inside a terminal (the focused element is within `.xterm`), stop there;
otherwise run the command.

For a key the terminal uses, "off" means the shell gets it (xterm takes it before the
window ever sees it). For a key the terminal does not use, such as `Ctrl+Shift+T`, "off"
simply means the shortcut does nothing while a terminal has focus.

Deleting a custom theme also deletes that theme's shortcut, since it would have no row
left to edit.

**Terminal key filter (`terminal-pane.tsx`).** For a key press whose binding has the switch
on, return `false` so xterm neither sends it to the shell nor stops it. This replaces the
palette-only line added with the palette.

**Current bindings (`src/state/keybindings.ts`).** `currentKeybindings()` returns the
effective bindings for the stored overrides, cached until the overrides change.
`useShortcutLabel(command)` gives components the label for a command's first shortcut, or
an empty string. The hard-coded hints (`Ctrl+T` in the empty state, the header button
titles, the project menu) use it, so they always show the real binding.

## The settings page

A new **Keyboard** tab in Settings (it also appears in the palette as "Settings: Keyboard").

- One row per command from the registry, in registry order: title on the left; on the right
  its shortcuts as chips, an **Add** button, and **Reset** when the row differs from the
  default.
- A chip shows the key (`Ctrl+Shift+T`), an **in terminal** checkbox, and a remove button.
- **Add** turns into "Press a shortcut…" and waits for a key press. `Esc` or clicking away
  cancels. The press is not passed on to the app, so recording `Ctrl+T` does not open a
  terminal.
  - No Ctrl/Cmd, or Alt held: "Use Ctrl with a key" (Cmd on macOS).
  - A reserved key: "That key is used for editing".
  - A key another command has: "Used by <command>" with **Move it here** and **Cancel**.
  - Otherwise the shortcut is added. Its switch starts on, except for keys the terminal
    would otherwise take, where it starts off; the user turns it on deliberately.
- **Reset all** at the bottom clears every override.
- A short note explains the switch: on, the app gets the key while a terminal is focused;
  off, the program in the terminal gets it.

## Persistence

`Settings` gains `keybindingOverrides` (default `{}`). It is written with the rest of the
settings and passed through `sanitizeOverrides` when read from local storage or the
backend, so a hand-edited or older settings file cannot break shortcut handling.

## Error handling

| Case | Behaviour |
|---|---|
| Stored overrides are malformed | Bad entries are dropped; the rest apply |
| An override names a command that no longer exists | The key does nothing; the page lists it as "Unknown command" so it can be removed |
| Two stored entries share a key | The first one read is kept and the other dropped |
| The user unbinds the palette's only shortcut | Allowed; the header and palette are still reachable by the registry, and Reset restores it |

## Testing

**TypeScript unit tests** (`pnpm test`): defaults per platform (which keys are off);
`terminalConsumes`; effective bindings with an override, an emptied command, and a key
clash; `bindingForEvent`; `withBinding` moving a key between commands; `withoutBinding`;
`withInTerminal`; `resetCommand`; an override equal to the default being dropped;
`sanitizeOverrides` on bad input; reserved keys; `formatKey` and `shortcutLabel` on both
platforms.

**Manual check in the running app (Windows):** with defaults, `Ctrl+T` in a focused
terminal still goes to the shell and `Ctrl+Shift+T` still opens Claude; turning "in
terminal" on for `Ctrl+T` makes it open a terminal from a focused terminal; turning it off
for `Ctrl+Shift+T` makes that do nothing in a terminal; recording a new shortcut for a
theme works and survives a restart; recording a taken key offers to move it; a reserved key
is refused; Reset all restores the defaults; the hints in the empty state and header follow
the bindings.

## Out of scope

- Shortcuts without Ctrl/Cmd, chords (two presses in sequence), and `when` conditions
  beyond the terminal switch.
- A hand-editable `keybindings.json`.
- Rebinding the editor's own keys or the terminal's copy and paste.
