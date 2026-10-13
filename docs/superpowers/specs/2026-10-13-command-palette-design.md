# Command palette — design

Roadmap item 1.1 of `docs/superpowers/plans/2026-10-13-t3code-inspired-roadmap.md`, plus the
part of 1.2 that the palette cannot work without (a command registry and a key-to-command
table). The settings page for editing keybindings stays in 1.2.

## Problem

Every action in the app is reached by a hard-coded shortcut in `src/app.tsx`, a button, or a
context menu. There is no single place to find an action, jump to a terminal in another
project, or switch theme. Later roadmap features (project scripts, session search, worktree
and PR actions) also need somewhere to be invoked from.

## Decisions

- **Opens with `Ctrl/Cmd+K` and `Ctrl/Cmd+Shift+P`.** `Ctrl+K` will no longer reach the
  shell (where it deletes to the end of the line). `Ctrl+Shift+P` is the second binding for
  people who want to keep `Ctrl+K`; rebinding arrives with 1.2.
- **The terminal gives up only the palette key.** When a terminal has focus on Windows or
  Linux, xterm handles an unshifted `Ctrl+letter` itself: it sends the control character to
  the shell and stops the event (`CoreBrowserTerminal.ts`, read in source, not confirmed in
  the running app). So `Ctrl+K` must be released explicitly in the terminal's key filter,
  and by the same reading `Ctrl+T`, `Ctrl+W`, `Ctrl+P` and `Ctrl+B` go to the shell today
  when a terminal is focused, despite the README's shortcut table. Whether to release those
  too is left to the owner (see Open question); this design does not change them.
- **It searches three things:** commands, terminals (across all projects) and projects.
- **Claude sessions are not in v1.** Listing them parses every transcript of a project,
  which can be hundreds of megabytes per open. They join the palette with roadmap 6.4, which
  builds an index.
- **File search stays in quick-open (`Ctrl+P`).** The palette has a command that opens it.
- **The palette's text field is a filter over a fixed list.** Nothing typed in it is ever
  sent to an agent or a shell, so it is not a prompt box under the owner's rule.
- **Commands live in one registry** with stable ids. The keyboard handler in `app.tsx` stops
  containing actions: it looks the key up in a key-to-command table and runs the command.
  That removes the duplication between shortcuts and palette entries and is the base 1.2
  builds on.
- **Matching is done in TypeScript.** The list is a few hundred items at most; no Rust
  round-trip is needed.

## Architecture

```
src/lib/fuzzy.ts            fuzzyMatch(query, text) -> { score, indices } | null   (pure)
src/lib/keybindings.ts      DEFAULT_KEYBINDINGS, eventKey, commandForEvent,
                            shortcutLabel                                           (pure)
src/lib/palette.ts          PaletteItem, rankItems(query, items)                   (pure)
src/commands/app-commands.ts  the registry: appCommands(), runCommand(id),
                              paletteItems()  (reads stores with getState)
src/components/command-palette/command-palette.tsx   the dialog
src/state/ui.ts             paletteOpen and quickOpenOpen flags
```

### Fuzzy matching (`fuzzy.ts`)

`fuzzyMatch(query, text)` is a case-insensitive subsequence match. Spaces in the query are
ignored. It returns the matched character positions and a score, or `null` when the query's
characters do not all appear in order. An empty query matches everything with score 0.

Scoring, per matched character: 1 point; 8 more when it starts the text or follows a
separator (space, `-`, `_`, `/`, `\`, `:`, `.`); 5 more when it directly follows the
previous match; otherwise minus the gap since the previous match, capped at 3. Half a point
is taken off per character before the first match, capped at 2.5. Every occurrence of the
query's first character is tried as a starting point and the best total wins, so "nt" finds
"**N**ew **t**erminal" rather than stopping at an earlier, worse alignment.

### Key table (`keybindings.ts`)

A binding is `{ key, command }`. Keys are written `mod+shift+t`: modifiers in the fixed
order `mod`, `shift`, then the key in lower case. `mod` is Cmd on macOS and Ctrl elsewhere,
never both: on a Mac, `Ctrl+K`, `Ctrl+P`, `Ctrl+B` and `Ctrl+T` belong to the shell and to
the editor's built-in emacs-style bindings.

Defaults (the existing shortcuts, plus the palette):

| Key | Command |
|---|---|
| `mod+k`, `mod+shift+p` | `palette.toggle` |
| `mod+,` | `view.settings` |
| `mod+b` | `view.toggleSidebar` |
| `mod+shift+b` | `view.toggleRightSidebar` |
| `mod+p` | `file.quickOpen` |
| `mod+shift+u` | `view.usage` |
| `mod+t` | `terminal.new` |
| `mod+shift+t` | `terminal.newClaude` |
| `mod+shift+d` | `terminal.newClaudeSkipPermissions` |
| `mod+w` | `terminal.close` |

`eventKey(event, isMac)` turns a keyboard event into that notation, or `null` when the
platform's modifier is not held, or when Alt is held.

Moving from hand-written key checks to an exact table changes four small things:

- On macOS, shortcuts need Cmd. Today Ctrl works there as well.
- Any shortcut with Alt also held (which is how AltGr combinations arrive on Windows)
  triggers its action today; with Alt excluded it no longer does.
- `Ctrl+Shift+P` opens file search today, because the old check ignored Shift. It now opens
  the palette; file search stays on `Ctrl+P`.
- `Ctrl+Shift+W` closes a terminal today for the same reason. Only `Ctrl+W` does now.

`commandForEvent(event, isMac)` returns the bound command id or `null`.
`shortcutLabel(commandId, isMac)` returns the first binding for display, such as
`Ctrl+Shift+T` or `⌘⇧T`.

### Registry (`app-commands.ts`)

```ts
interface Command {
  id: string
  title: string
  enabled?: () => boolean   // absent means always enabled
  run: () => void
  paletteRun?: () => void   // used by the palette where a toggle would be wrong
}
```

`run` takes no arguments, and that is a rule, not an accident: nothing typed into the
palette may be passed to a shell or an agent. A future command that needs text from the
user must get it in the terminal.

`appCommands()` builds the list at call time from the stores, so it always reflects the
current projects and themes:

| Id | Title | Enabled when |
|---|---|---|
| `terminal.new` | New terminal | a project is selected |
| `terminal.newClaude` | New Claude Code terminal | a project is selected |
| `terminal.newClaudeSkipPermissions` | New Claude Code terminal (skip permissions) | a project is selected |
| `terminal.newOtherModel` | New terminal with another model… | a project is selected |
| `terminal.close` | Close terminal | a terminal is active and the Usage page is closed |
| `file.quickOpen` | Go to file… | a project is selected |
| `view.toggleSidebar` | Toggle project sidebar | always |
| `view.toggleRightSidebar` | Toggle right panel | always |
| `view.usage` | Usage | always |
| `view.settings` | Settings | always |
| `settings.<tab>` | Settings: General / AI / GitHub / Remote access / Updates | always |
| `project.add` | Add project… | always |
| `project.revealInFileManager` | Reveal project in file manager | a project is selected |
| `project.openInSystemTerminal` | Open project in system terminal | a project is selected |
| `theme.<id>` | Theme: \<name\> (built-in and custom) | always |
| `palette.toggle` | (not listed in the palette) | always |

Each command does exactly what its existing shortcut or button does today; the actions are
moved, not changed. The two exceptions are `view.usage` and `view.settings`: their
shortcuts toggle, but chosen from the palette they only open, so picking "Settings" while
Settings is open does not close it. `runCommand(id)` runs a command if it exists and is
enabled and reports whether it ran.

Switching Claude account is deliberately not a palette command. It swaps credentials for
every session, its failures are only shown inside the accounts popover, and it should not
be one fuzzy-matched Enter away.

`paletteItems()` returns, in this order: the enabled commands except `palette.toggle`; one
item per terminal across all projects (title is the terminal's live title or its name, hint
is `Terminal · <project>`), which selects that project and activates the terminal; one item
per project (hint `Project`), which selects it. A terminal or project that has gone away
since the palette opened is checked for at the moment it is chosen, and choosing it does
nothing.

### Ranking (`palette.ts`)

`rankItems(query, items, limit = 50)`:

- A query starting with `>` shows commands only; the `>` is dropped before matching.
- An empty query returns the items in the order given.
- Otherwise items are matched on their title, sorted by score, ties kept in the order
  given.

### The dialog

Modelled on quick-open: a centred panel with a text field, a result list and a footer line.
Each row shows the title with matched characters emphasised, the hint (for commands, their
shortcut when one exists), and the row under the pointer or arrow keys is highlighted.
`↑` `↓` move, `Enter` runs, `Esc` or a click outside closes. `Ctrl/Cmd+K` while open closes
it.

The list is built once when the palette opens. While it is open, other shortcuts do
nothing (except the palette's own and file search), so nothing changes behind that list.
`Esc` is stopped at the palette, so one press does not also close Settings underneath. The
palette sits above every other dialog.

**Focus.** On open the palette remembers the focused element (normally the terminal's
input). On close it gives focus back to it. An item that takes focus itself (switching
terminal, opening file search, opening the Usage page) ends up with it. Settings does not
take focus when it opens, today or after this change, so after "Settings: AI" the keyboard
still belongs to whatever had it before.

### Changes to existing code

- `src/app.tsx`: the keyboard handler becomes "look up the command, prevent the default,
  run it". The `quickOpen` local state moves to the UI store so a command can open it.
  Every bound key now has its browser default prevented even when its command is disabled
  (today only some do), which also stops `Ctrl+P` opening the webview's print dialog.
- `src/hooks/use-projects.ts`: `addProject` becomes an exported function the hook also
  returns, so the registry can call it.
- `src/components/settings-modal.tsx`: the tab list moves to `src/lib/settings-tabs.ts`, so
  the registry does not import a component.
- `src/components/workspace/terminal-pane.tsx`: the terminal's key filter lets the palette
  key through.

## Open question

Should a focused terminal also give up `Ctrl+T`, `Ctrl+W`, `Ctrl+P` and `Ctrl+B` to the app,
as the README's shortcut table implies? Doing so takes them from the shell (`Ctrl+W` deletes
a word, `Ctrl+P` recalls history) and from agent CLIs that bind them. The first step is to
press `Ctrl+T` in a focused terminal in the installed app and see what happens today.
Recommendation: leave them with the terminal, correct the README, and let 1.2's editable
keybindings give each person the choice.

## Error handling

| Case | Behaviour |
|---|---|
| A command's action fails (for example the file manager cannot open) | Same as today for that action; the palette is already closed |
| A command is disabled | It is not listed; its shortcut does nothing |
| The key table names a command that does not exist | Nothing runs |
| No results | "Nothing matches" |
| A chosen terminal or project no longer exists | Nothing happens |

## Testing

**TypeScript unit tests** (`pnpm test`):

- `fuzzy`: empty query; no match; subsequence positions; case-insensitivity; spaces ignored;
  a word-start match outranks a mid-word one; a consecutive match outranks a scattered one;
  the best starting point is chosen.
- `keybindings`: event to key string with and without Shift, per platform (Ctrl on a Mac
  and Cmd on Windows do not count), without a modifier, with Alt; default table lookups for every existing shortcut; labels for Windows and Mac;
  no key is bound twice to different commands.
- `palette`: empty query keeps order; `>` restricts to commands; ranking by score with
  stable ties; the limit.

**Manual check in the running app:** every existing shortcut still does what it did; the
palette opens with both keys, with and without a project; running each command; jumping to
a terminal in another project; focus returns to the terminal after `Esc`; `Ctrl+K` closes
it.

## Out of scope

- A settings page and a `keybindings.json` for rebinding (roadmap 1.2).
- Claude sessions and message search in the palette (roadmap 6.4).
- Recently used commands.
- Git, PR and worktree commands (they arrive with those features).
