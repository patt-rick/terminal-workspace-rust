# Theme Authoring Specification

This document fully specifies the theme JSON format used by Terminal Workspace.
It is written to be handed to an LLM (or a human) as the sole context needed to
generate a valid, importable theme. Follow it exactly — the importer validates
every field and rejects anything malformed.

## How themes are used

A theme's colors are written onto the document as CSS custom properties and read
at runtime by three consumers at once:

- **Chrome** — every surface, text color, accent, and border across the app UI.
- **Terminal** — the xterm.js cursor, selection, and 16-color ANSI palette.
- **Editor** — the CodeMirror syntax highlighting.

Import a theme via **Settings → General → Appearance → Import…**. On import the
file is validated; the theme's `id` is regenerated as `custom:<slug-of-name>`,
so you do not need to pick a unique id yourself — just give it a good `name`.

## Top-level shape

```jsonc
{
  "meta":     { "name": string, "appearance": "dark" | "light" },
  "chrome":   { /* 20 color tokens, all required */ },
  "terminal": { "cursor": color, "selection": color, "ansi": { /* 16 colors */ } },
  "syntax":   { /* 14 color tokens, all required */ },
  "gradients": { /* OPTIONAL: "app"?, "titleBar"? */ }
}
```

Every key listed as required must be present. Extra unknown keys are ignored.
`gradients` is the only optional block.

## Value formats

**Colors** (every token except gradients) must be one of:

- Hex: `#rgb`, `#rgba`, `#rrggbb`, or `#rrggbbaa` — e.g. `#1d2433`, `#ffcc66cc`
- `rgb(...)` / `rgba(...)` — e.g. `rgba(150, 166, 204, 0.2)`
- `hsl(...)` / `hsla(...)` — e.g. `hsl(210, 40%, 20%)`
- A CSS named color — e.g. `transparent`, `white`

Gradients (`url(...)`, `linear-gradient(...)`, etc.) are **not** allowed in color
slots — only in the `gradients` block.

**Gradients** (values in the `gradients` block) must be a single CSS gradient
function:

- `linear-gradient(...)`, `radial-gradient(...)`, `conic-gradient(...)`
- optionally prefixed with `repeating-` (e.g. `repeating-linear-gradient(...)`)
- The content inside the parentheses may contain colors (hex / `rgb()` / `rgba()`),
  angles and lengths (`deg`, `%`, `px`), color stops, commas, and direction
  keywords (`to right`, `at center`, `circle`, …).
- It may **not** contain `;`, `{`, `}`, quotes, or `url(...)`.

Example valid gradient:
`linear-gradient(160deg, #16161e 0%, #1a1b26 55%, #24283b 100%)`

## `meta`

| Field        | Type                | Notes                                             |
|--------------|---------------------|---------------------------------------------------|
| `name`       | non-empty string    | Human-readable; shown in the picker. Required.    |
| `appearance` | `"dark"` \| `"light"` | Sets `color-scheme` and the `dark`/`light` class. Choose the one matching your background lightness. |

## `chrome` (all 20 required)

These drive the app UI. `background` is the editor/terminal surface; `surface`
is the surrounding frame — keep them distinct so the editor area visually lifts
out of the chrome (like VS Code).

| Token              | Meaning                                                                 |
|--------------------|-------------------------------------------------------------------------|
| `background`       | Editor & terminal surface (the "content" background).                   |
| `surface`          | Surrounding frame / panels behind the content.                          |
| `surfaceSecondary` | Slightly raised panel surface.                                          |
| `surfaceTertiary`  | Highest raised surface (hover rows, tertiary panels).                   |
| `foreground`       | Primary text color.                                                     |
| `muted`            | Secondary / dimmed text (hints, captions).                             |
| `accent`           | Primary brand/action color (buttons, active states, focus).            |
| `accentForeground` | Text/icon color drawn *on* `accent` — must contrast with it.           |
| `border`           | Default border color between regions.                                  |
| `separator`        | Thin divider lines (often equal to `border`).                          |
| `success`          | Positive status (green family).                                        |
| `warning`          | Caution status (amber family).                                         |
| `danger`           | Destructive/error status (red family).                                 |
| `link`             | Hyperlink text.                                                        |
| `focus`            | Focus-ring color (often equal to `accent`).                            |
| `scrollbar`        | Base color for the thin themed scrollbars (drawn translucent).         |
| `fieldBackground`  | Input / select / textarea background.                                  |
| `fieldBorder`      | Input border (a translucent rgba reads well here).                     |
| `overlay`          | Popover / dropdown / modal panel background (should be opaque).        |
| `backdrop`         | Dimming layer behind modals — use a translucent black, e.g. `rgba(0,0,0,0.6)`. |

## `terminal`

| Token       | Meaning                                                                 |
|-------------|-------------------------------------------------------------------------|
| `cursor`    | Terminal cursor color.                                                  |
| `selection` | Terminal selection highlight — use a **translucent** rgba so text shows through, e.g. `rgba(255,204,102,0.3)`. |
| `ansi`      | Object with the 16 standard ANSI slots (below).                         |

`ansi` keys (all required): `black`, `red`, `green`, `yellow`, `blue`,
`magenta`, `cyan`, `white`, `brightBlack`, `brightRed`, `brightGreen`,
`brightYellow`, `brightBlue`, `brightMagenta`, `brightCyan`, `brightWhite`.

Guidance: on a dark theme, `black`/`brightBlack` are dark grays (not pure black)
so dim text stays legible; `white`/`brightWhite` are near the foreground. Keep
the colored slots vivid and consistent with the chrome accents.

## `syntax` (all 14 required)

Consumed by the CodeMirror editor for code highlighting.

`comment`, `keyword`, `string`, `number`, `function`, `variable`, `type`,
`constant`, `operator`, `punctuation`, `tag`, `attribute`, `heading`, `link`.

Guidance: `comment` should be low-contrast (close to `muted`); `keyword`,
`function`, `string`, `type`, and `number` should be distinct hues drawn from
your ANSI palette so the editor feels of a piece with the terminal.

## `gradients` (optional)

Decorative gradients layered over solid chrome surfaces. The terminal and editor
always keep their solid `background`, so legibility and xterm/CodeMirror
rendering are never affected.

| Token      | Applied to                                                                |
|------------|---------------------------------------------------------------------------|
| `app`      | The whole-window backdrop (painted on `body`, behind the chrome).         |
| `titleBar` | The custom title bar at the top of the window (always visible).           |

Either key may be provided independently; omit the block entirely for a flat
theme. Keep gradients subtle and anchored to your palette's darkest surfaces so
UI text over them stays readable.

## Complete example

A valid dark theme with gradients. Copy, edit values, and import.

```json
{
  "meta": { "name": "Aurora", "appearance": "dark" },
  "chrome": {
    "background": "#1d2433",
    "surface": "#171c28",
    "surfaceSecondary": "#1d2433",
    "surfaceTertiary": "#2f3b54",
    "foreground": "#a2aabc",
    "muted": "#5c6773",
    "accent": "#ffcc66",
    "accentForeground": "#171c28",
    "border": "#2f3b54",
    "separator": "#2f3b54",
    "success": "#bae67e",
    "warning": "#ffcc66",
    "danger": "#ef6b73",
    "link": "#5ccfe6",
    "focus": "#ffcc66",
    "scrollbar": "#96a6cc",
    "fieldBackground": "#1d2433",
    "fieldBorder": "rgba(150, 166, 204, 0.2)",
    "overlay": "#1d2433",
    "backdrop": "rgba(0, 0, 0, 0.6)"
  },
  "terminal": {
    "cursor": "#ffcc66",
    "selection": "rgba(255, 204, 102, 0.3)",
    "ansi": {
      "black": "#2f3b54",
      "red": "#ef6b73",
      "green": "#bae67e",
      "yellow": "#ffcc66",
      "blue": "#5ccfe6",
      "magenta": "#c3a6ff",
      "cyan": "#5ccfe6",
      "white": "#a2aabc",
      "brightBlack": "#444a5e",
      "brightRed": "#ef6b73",
      "brightGreen": "#bae67e",
      "brightYellow": "#ffcc66",
      "brightBlue": "#5ccfe6",
      "brightMagenta": "#c3a6ff",
      "brightCyan": "#5ccfe6",
      "brightWhite": "#d7dce2"
    }
  },
  "syntax": {
    "comment": "#5c6773",
    "keyword": "#c3a6ff",
    "string": "#bae67e",
    "number": "#f78c6c",
    "function": "#5ccfe6",
    "variable": "#a2aabc",
    "type": "#ffd580",
    "constant": "#f78c6c",
    "operator": "#ffcc66",
    "punctuation": "#8695b7",
    "tag": "#5ccfe6",
    "attribute": "#ffd580",
    "heading": "#ffcc66",
    "link": "#5ccfe6"
  },
  "gradients": {
    "app": "linear-gradient(160deg, #171c28 0%, #1d2433 60%, #2f3b54 100%)",
    "titleBar": "linear-gradient(90deg, #171c28 0%, #2f3b54 100%)"
  }
}
```

## Prompt template for generating a theme with an LLM

> Generate a Terminal Workspace theme as a single JSON object following the
> specification in `docs/theme-authoring.md`. Theme concept: **<describe the mood,
> e.g. "warm desert dusk, sandy beiges with a burnt-orange accent, dark">**.
> Requirements: include every required `meta`, `chrome`, `terminal.ansi`, and
> `syntax` token; use only hex or rgba/hsla color values; make `accentForeground`
> contrast with `accent`; make `terminal.selection` a translucent rgba; keep
> `comment` low-contrast; optionally add subtle `gradients.app` and
> `gradients.titleBar` anchored to the darkest surfaces. Output only the JSON.

## Validation checklist

- [ ] `meta.name` is a non-empty string and `meta.appearance` is `"dark"` or `"light"`.
- [ ] All 20 `chrome` tokens present and valid colors.
- [ ] `terminal.cursor`, `terminal.selection`, and all 16 `terminal.ansi` slots present.
- [ ] All 14 `syntax` tokens present.
- [ ] Any `gradients` values are a single CSS gradient function with no `;`, `{`, `}`, quotes, or `url(...)`.
- [ ] No color slot contains a gradient or `url(...)`.
