# Usage page — design

Roadmap items 1.3, 1.4, 1.5 and 1.6 of
`docs/superpowers/plans/2026-10-13-t3code-inspired-roadmap.md`.

## Problem

The app shows each Claude account's 5-hour and 7-day quota as small bars in the accounts
popover, and nothing else. There is no way to see how many tokens were used, on which
model, in which project, on which day, or what that would have cost at API rates. T3 Code
has a Usage page that answers these; this spec brings it to Terminal Workspace.

## Decisions

- **Claude Code only in v1.** Codex and other CLIs are a later addition.
- **History is per machine, not per account.** Account switching rewrites one
  `~/.claude/.credentials.json`, so every account writes to the same transcripts. History
  splits by model, day and project. Limits stay per account.
- **The app keeps its own usage ledger.** On the development machine the oldest transcript
  is exactly 30 days old, so Claude Code is deleting older ones (the setting that controls
  this was not looked up). A 90-day view therefore cannot be built from transcripts alone.
  The app records each API response's token counts in a ledger of its own and keeps them
  for 100 days. History starts at the oldest transcript present when the app first scans
  and grows from there; the page says where it starts.
- **Cost is an API-equivalent estimate.** It is what the tokens would cost at list API
  rates, not what a subscription was billed. The page says so.
- **No chart library.** The chart is hand-drawn SVG, themed from existing tokens.
- **No time-zone dependency in Rust.** The frontend computes local-time bucket boundaries
  and sends them (see [Bucketing](#bucketing)).
- **The page never waits on the network.** Prices are refreshed by a separate call.
- **Out of scope:** custom model prices and model mapping (roadmap 1.7), other providers,
  the remote web client, exporting data, and a cost-by-speed breakdown.

## What the transcripts contain

Measured over every transcript on the development machine on 2026-10-13 (1,430 files,
2.08 GB, 166,816 usage lines):

- **Where usage lives.** Only on lines with `"type":"assistant"`, in `message.usage`:
  `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`,
  `cache_creation.ephemeral_5m_input_tokens`, `cache_creation.ephemeral_1h_input_tokens`,
  `speed`. The line also carries `timestamp` (always `YYYY-MM-DDTHH:MM:SS.sssZ`),
  `requestId`, `message.id`, `message.model` and `cwd`. There is no cost field. `user`
  lines can carry a `toolUseResult.usage` subagent total; those are ignored, since the
  subagent's own file has the detail.
- **Two file shapes.** `<project>/<session>.jsonl` (155 files) and
  `<project>/<session>/subagents/agent-*.jsonl` (1,275 files). Subagent usage is not
  repeated in the parent file, so the scan must walk recursively.
- **One API response is several lines** (one per content block) sharing `message.id` and
  `requestId`. Within such a group the input and cache fields never differ, but
  `output_tokens` grows (for example 16, 16, 16, 394) and the last line always holds the
  largest value. Keeping the first line, as T3 Code does, would count 24.65M output tokens
  against a true 76.18M here.
- **Fields can be null or absent.** Intermediate lines lack `speed`; some lines have
  `speed: null`; 45 lines lack `requestId`, all of them `<synthetic>`. `message.id` was
  always present.
- **The same response can appear in several files.** 53 responses appear in 2 to 7 sibling
  subagent files each. Counting them once per file would overstate usage by 65.75M tokens.
- **`<synthetic>` model lines** all have zero tokens.

## The de-duplication rule

A response is identified by `"{message.id}:{requestId}"` (an absent half is the empty
string). Across all lines of all files, one record is kept per response: **the one with the
largest `output_tokens`; on a tie, the one seen later.** Files are scanned in path order, so
the result is deterministic. A line with neither id gets a key built from its file path and
byte offset, so re-reading the same file cannot count it twice.

## Architecture

```
src-tauri/src/usage/
  mod.rs        UsageStore (managed state), scan() and summary() entry points, wire types
  record.rs     parse one transcript line -> Record
  ledger.rs     the durable set of records: upsert, prune, load, save
  scan.rs       find transcript roots and files, incremental per-file parse into the ledger
  pricing.rs    rate table: parse, lookup, cost arithmetic, tier selection, fetch
  aggregate.rs  fold ledger records into buckets for a set of boundaries
  prices-snapshot.json   bundled Anthropic rates, used when nothing fresher exists
src/lib/usage.ts          pure helpers: boundaries, totals, series, shares, pooled limits,
                          formatting
src/state/usage.ts        zustand store: open flag, view, period, summary, loading
src/components/usage/     usage-page, usage-chart, usage-totals, usage-breakdown,
                          usage-limits, share-bar
```

`record.rs`, `pricing.rs` (apart from its fetch) and `aggregate.rs` are pure. `ledger.rs`
and `scan.rs` touch the filesystem. To avoid clashing with the existing
`claude::usage::UsageBucket` (a quota window), no new type is named `UsageBucket`.

### Record parsing (`record.rs`)

`parse_line(&str) -> Option<ParsedLine>`:

- A line without the substring `"usage"` is skipped before any JSON parsing; most bytes in
  a transcript are message content.
- Deserialize into a struct naming only the fields listed above, so content is skipped by
  serde. **Every field is optional and tolerates `null`.** Missing token counts are zero;
  missing or null `speed` is standard.
- Reject unless `type == "assistant"`, `message.usage` is present, the timestamp parses, and
  the model is non-empty and not `<synthetic>`.
- Cache-write tokens are split into 5-minute and 1-hour from `cache_creation`; when that
  object is absent, all of `cache_creation_input_tokens` counts as 5-minute.
- The timestamp is parsed by a small local function (no date crate) that returns epoch
  milliseconds.

`ParsedLine` holds the key string (or none), the model, the `cwd`, and the numbers that go
into a ledger `Record`.

### Ledger (`ledger.rs`)

The ledger is the app's durable usage history: one record per API response.

```rust
pub struct Record {
    pub ts_ms: i64,
    pub model: u32,        // index into Ledger.models
    pub project: u32,      // index into Ledger.projects
    pub input: u64,
    pub cache_read: u64,
    pub cache_write_5m: u64,
    pub cache_write_1h: u64,
    pub output: u64,
    pub fast: bool,
}
```

- **Storage:** a map from a 64-bit key hash to `Record`, plus the model and project tables
  and per-file scan state. The hash is FNV-1a over the key string, written by hand so it is
  stable across Rust versions (the standard hasher is not).
- **Upsert:** insert if absent; replace if the new `output` is greater than or equal to the
  stored one. This implements the de-duplication rule and makes re-reading a file harmless.
- **Projects table:** `{ source, dir, cwd }`, where `source` is `""` for the Windows home or
  a WSL distro name, `dir` is Claude's encoded directory name, and `cwd` is the first `cwd`
  recorded for that directory (used for a readable label).
- **Retention:** records older than 100 days are dropped on save. Records are **not**
  dropped when their transcript disappears; that is the point of the ledger.
- **File:** `usage-ledger-v1.json` in the data directory the app resolved at startup (the
  one that honours `TW_DATA_DIR`), written atomically (temp file then rename). Records are
  stored as compact arrays. Measured volume is about 75,000 records per 30 days, so roughly
  15 MB at full retention.
- **Saved only when a scan changed it.**
- **Failing safe.** The ledger holds history that exists nowhere else, so it is never
  silently overwritten:
  - A file that cannot be read at all (locked, permission denied) is an error. Nothing is
    loaded, so nothing can be saved over it; the scan and summary commands return the error
    and the next call tries again.
  - A file that reads but does not parse is renamed to
    `usage-ledger-v1.corrupt-<time>.json` (a unique name each time), and the previous save
    is loaded in its place.
  - Each save is flushed to disk before it replaces the ledger, and the ledger it replaces
    is kept as `usage-ledger-v1.bak.json`.
  - Pruning is skipped when the clock reads more than a day past the newest record, so a
    clock set far in the future cannot erase the history.
  - A future format change must migrate `v1`, not discard it.

### Scanning (`scan.rs`)

**Roots.** `~/.claude/projects`, the same location the Sessions panel reads; plus, on
Windows, `<distro home>/.claude/projects` for every *running* WSL distro via the existing
`wsl::list_distros`, `distro_home` and `unc_path`. A stopped distro is never booted.
`CLAUDE_CONFIG_DIR` is not consulted, matching the Sessions panel, so the two always read
the same tree; this is a known limit shared with that panel. A missing root is a source
with status `missing`, not an error.

**Files.** Walk each root recursively for `*.jsonl`, in sorted path order. The first path
component under the root is the project directory. Unreadable directories and files are
counted, not fatal.

**Incremental parse.** Per file the ledger keeps: size, modified time, the byte offset just
past the last complete line parsed, and a hash of the 64 bytes before that offset.

- size and modified time unchanged → skip the file;
- file grew and the guard hash still matches → parse from the offset;
- otherwise → parse from byte 0.

Either way, each parsed line is upserted into the ledger, so a response whose lines straddle
two scans, a file re-read from the start, and a response repeated in another file all
resolve to one record. A trailing line with no newline is left for the next scan.

**Progress.** A cold scan reads gigabytes and takes seconds. The scan emits
`usage:scan-progress` with `{ done, total }` file counts, at most ten times a second.

### Pricing (`pricing.rs`)

**Source.** LiteLLM's `model_prices_and_context_window.json`. Only entries whose
`litellm_provider` is `anthropic` and that have numeric input and output rates are kept.

**Three tiers, best available wins:**

1. `usage-prices.json` in the data directory, fetched within the last 24 hours (`fresh`).
2. The same file when older (`stale`).
3. `prices-snapshot.json` compiled into the binary (`bundled`), so cost works on first run
   with no network. The development network is filtered, so this tier matters.

**Refreshing is separate from reading.** `usage_summary` only ever reads what is on disk or
bundled. The async command `usage_refresh_prices(force)` fetches the table and replaces the
file only if the response parses and yields at least one Anthropic entry; a login page or
an empty table counts as a failure and leaves the existing copy alone. It records the time
of each attempt and does nothing if one was made within the last hour (within the last
minute when `force` is set). It returns whether the table changed.

**Lookup.** Lower-case the model id, strip a bracketed variant suffix such as `[1m]`, and
match the table key exactly. An unknown model is **unpriced**: its tokens are counted, its
cost is zero, and the page flags it. A guessed price would be worse than a visible gap.

**Rates per model:** input, output, cache read, cache write 5-minute
(`cache_creation_input_token_cost`), cache write 1-hour
(`cache_creation_input_token_cost_above_1hr`, falling back to the 5-minute rate), and a
fast-mode multiplier (`provider_specific_entry.fast`; absent means 1). A missing cache rate
falls back to the input rate, never to free.

**Cost of a record:**

```
m = rates.fast_multiplier if record.fast else 1
input_cost       = input          * rates.input          * m
cache_read_cost  = cache_read     * rates.cache_read     * m
cache_write_cost = (cache_write_5m * rates.cache_write_5m
                  + cache_write_1h * rates.cache_write_1h) * m
output_cost      = output         * rates.output         * m
cost             = the sum of the four
cache_savings    = cache_read * (rates.input - rates.cache_read) * m
```

**Known omissions,** stated on the page's footer as "list rates": rates that change above a
context-size threshold (`*_above_*_tokens`; no Opus, Sonnet or Fable entry has them today),
the regional multiplier (`provider_specific_entry.us`), and web-search request fees.

`lookup` and the cost function take the table as a parameter, so a later override table
(roadmap 1.7) needs no restructuring.

### Bucketing

The frontend sends `boundaries`: a strictly ascending list of epoch-millisecond instants.
Slot `i` covers `[boundaries[i], boundaries[i+1])`. Rust rejects a list with fewer than 2 or
more than 200 entries, or one that is not strictly ascending. Each record is assigned by
binary search; records outside the range are ignored.

The frontend builds the list fresh on every request, so a page left open past midnight does
not show a stale range:

- **7d / 30d / 90d:** N slots, one per local calendar day, ending with today. Boundary `i`
  is `new Date(year, month, day - (N-1) + i)` for `i` in `0..=N`, so the last boundary is the
  next local midnight. Building days from calendar fields keeps daylight-saving days
  correct (they are 23 or 25 hours long).
- **24h:** 24 slots of exactly one hour, ending with the current hour. The first boundary
  is the start of the current local hour minus 23 hours, and each next one adds 3,600,000
  ms. Stepping in milliseconds avoids a repeated boundary on the autumn clock change.

### Aggregation (`aggregate.rs`)

Fold every ledger record inside the boundaries into buckets keyed by
`(slot, model, project)`, pricing each record as it is folded.

### Wire contract

Three commands. None waits on the network except the price refresh itself. A summary
requested while a scan is running waits for that scan to finish (they share the ledger's
lock); the page only does this when the period is changed during the first scan.

- `usage_scan() -> UsageScanResult` — runs the incremental scan under `spawn_blocking`,
  saves the ledger if it changed. Called when the page opens and on Refresh.
- `usage_summary(boundaries: Vec<i64>) -> UsageSummary` — aggregates from the in-memory
  ledger (loading it from disk on first use). Called after a scan and on every period
  change. It does not scan and does not touch the network.
- `usage_refresh_prices(force: bool) -> bool` — described above. Called in the background
  when the page opens, and with `force` on Refresh; if it returns true the page requests
  the summary again.

```ts
interface UsageScanResult {
  sources: UsageSource[]
  scanMs: number
}
interface UsageSource {
  label: string                   // "This computer" or "WSL <distro>"
  status: 'ok' | 'missing' | 'partial'
  files: number
  skipped: number
}
interface UsageSummary {
  buckets: UsageSummaryBucket[]
  projects: UsageProject[]
  pricing: { tier: 'fresh' | 'stale' | 'bundled'; fetchedAt: number | null }
  historyStartMs: number | null   // oldest record in the ledger; null when empty
}
interface UsageSummaryBucket {
  slot: number                    // index into the boundaries sent
  model: string
  project: number                 // index into UsageSummary.projects
  input: number
  cacheRead: number
  cacheWrite: number              // 5-minute + 1-hour
  output: number
  costUsd: number                 // 0 when unpriced
  inputCostUsd: number
  cacheReadCostUsd: number
  cacheWriteCostUsd: number
  outputCostUsd: number
  cacheSavingsUsd: number
  priced: boolean
  responses: number
}
interface UsageProject {
  label: string                   // see "Project rows"
  path: string | null             // recorded cwd
  projectId: string | null        // matching app project, if any
  distro: string | null
}
```

**Project rows.** Rust resolves each ledger project `{ source, dir, cwd }` to a
`UsageProject`. It matches an app project when `encode_project_dir` of the project's path
(for a WSL source, of its path as seen inside that distro) equals `dir`. The label is the
app project's name when matched, otherwise the last path segment of `cwd`, otherwise `dir`.
The frontend merges rows that share a `projectId`, so one project used from both Windows
and WSL is one row; unmatched directories stay separate rows per source.

**Limits** use the existing `claude_accounts_usage` command and `useClaudeAccounts` store
unchanged.

## The page

A layer that covers the content row of the main column (the terminals and the file pane,
`src/app.tsx:307`), leaving the header and both sidebars visible. Terminals stay mounted
and running underneath. It does not need a selected project.

**Opening it:** a chart button in the main header beside Settings; a "Usage" link in the
accounts popover footer; `Ctrl/Cmd+Shift+U`, handled before the keyboard handler's
no-project early return. (`Ctrl+U` alone is left to the shell. On Linux this chord may be
taken by the desktop's Unicode entry; that was not tested, and the button always works.)

**Focus.** A terminal keeps keyboard focus when something is drawn over it, so typing or
Esc would reach a hidden agent. On open the page moves focus into its own container; while
it is open no terminal is treated as active. Esc is handled on the page container and
stopped there. On close, the previously active terminal becomes active again and takes
focus. Selecting or creating a terminal or project while the page is open closes the page,
so the choice is visible; a shell exiting or a remote client adding a terminal does not.
The close-terminal shortcut does nothing while the page is open, and the terminals and
file pane underneath are inert, so Tab cannot move focus into them.

**Header:** title, a view switch (**Cost**, **Tokens**, **Limits**), a period switch
(**24h**, **7d**, **30d**, **90d**; hidden on Limits), and Refresh. View and period are
remembered for the session.

**Cost and Tokens views** share one layout:

1. **Chart.** Stacked bars, one per slot, stacked by the current breakdown dimension: the
   top five series by the active metric, plus "Other". Hover shows the slot's date and
   per-series values. Y axis in dollars or tokens.
2. **Totals.**
   - Processed tokens = input + cache read + cache write + output
   - Cached input = cache read
   - Uncached input = input + cache write
   - Output
   - Cache savings (dollars)
   - Estimated cost (dollars)
   - Responses

   Below them, a share bar of tokens by type (input, cache read, cache write, output) and
   one of cost by type.
3. **Breakdown.** A switch between **Model** and **Project**. One row per entry: name, cost,
   share of the active metric, tokens, cache hit rate
   (cache read ÷ (input + cache read + cache write)), and cost per million priced tokens.
   Rows sort by the active metric. Clicking a row filters the chart and totals to it;
   clicking again clears it. An unpriced model shows "Unpriced" in place of cost.

**Footer line:** costs are estimates at list API rates, not a subscription bill; which
price tier is in use and when it was fetched; "History starts <date>" when the period
reaches back before `historyStartMs`; and, when a source is `missing` or `partial`, which
one and how many files were skipped.

**Limits view.** For each of the two windows (5-hour, 7-day):

- a headline: the mean of what is left across the accounts that reported that window
  (accounts with no data for that window are left out; an account whose last fetch failed
  but still has earlier data keeps it and shows its error), labelled
  "average across N accounts" because the API reports percentages and plans differ in size;
- a bar with one equal-width segment per reporting account, filled by its remaining share
  and coloured by the existing `utilizationBarClass`, the same colours as the accounts
  popover;
- the soonest reset among accounts that have used anything, and the share of the pool it
  restores (that account's used share ÷ N);
- one row per account: name, plan, percent used, reset countdown, or its error.

Extra-usage credits, when enabled, show per account as used / monthly limit. With one
account the headline is that account's remaining share. With no accounts the view shows an
empty state with the existing Log In action.

**States.** First load shows a loading line with the scan's file count. An empty ledger shows an
empty state naming the directory that was read. A failed scan shows the error with a retry
button; Limits still works, since it does not depend on the scan.

**Theming.** Text, grid, background and the share bars use the existing chrome tokens, so
the page follows every built-in and custom theme. The chart's series colours do not: they
are a fixed five-colour set (`--chart-1` to `--chart-5`, with light-theme variants). The
themes' ANSI palettes were tried first and failed colour-blind separation checks in every
built-in theme (blue and cyan, or yellow and green, are near-identical); the fixed set
passes on all six theme backgrounds. A series keeps its colour when the chart is filtered
to it. The limit bars keep the popover's fixed traffic-light colours for consistency with
it.

## Error handling

| Failure | Behaviour |
|---|---|
| A projects directory does not exist | Source `missing`; other sources still load |
| A file or directory cannot be read | Counted in `skipped`; source `partial` |
| A line is not valid JSON, has no usage, or has null fields | Skipped, or parsed with defaults |
| The ledger file cannot be read | The command returns an error; the file is left untouched |
| The ledger file reads but does not parse | Renamed aside under a unique name; the previous save is used |
| The ledger cannot be written | Error logged; the in-memory ledger still serves the page |
| The price fetch fails or returns something unusable | Existing copy kept; next attempt in an hour |
| A model has no rate | Tokens counted, cost zero, flagged "Unpriced" |
| A WSL distro is stopped | Not consulted; not listed as a source |
| Boundaries are invalid | The command returns an error |

## Privacy

The scanner deserializes token counts, ids, model, timestamp and `cwd` only. Message text is
never held beyond the raw line buffer, never stored and never sent to the frontend. The
ledger stores a hash of each response id, not the id. The only network request is the
public price table.

## Testing

**Rust unit tests** (`cargo test`, fixtures in temp directories):

- `record`: a real-shaped line parses; lines without usage, non-assistant lines, bad JSON
  and `<synthetic>` are rejected; null and absent `speed`, `requestId` and token fields
  parse with defaults; the 5-minute / 1-hour split and its fallback; the timestamp parser,
  including a leap-year date.
- `ledger`: upsert keeps the larger output and, on a tie, the later record; round-trip
  through the file; records older than 100 days are pruned and others are kept even when no
  file entry refers to them; a corrupt file is renamed aside, not overwritten; the hash is
  the documented FNV-1a value for a known input.
- `scan`: recursion into `subagents/`; a response repeated in two sibling files is one
  record; a response whose lines arrive across two scans is one record with the larger
  output; an unchanged file is skipped; a grown file is parsed only from its offset; a
  guard mismatch re-reads from zero without double counting; an unterminated last line is
  deferred; a missing root reports `missing`.
- `pricing`: table parsing keeps Anthropic entries with numeric rates only; exact and
  variant-suffix lookup; unknown model is unpriced; 1-hour rate and its fallback; fast
  multiplier; cache savings; tier selection; a response with no usable entries is rejected.
- `aggregate`: boundary validation; a record exactly on a boundary lands in the later slot;
  records outside the range are ignored; bucket totals and cost fields add up.

**TypeScript unit tests** (`pnpm test`): boundary generation for each period (slot
counts, local-midnight and one-hour spacing; the test cannot force a time zone, so
daylight-saving behaviour rests on the construction rule above); totals as defined above; series (top five plus Other);
shares; cache hit rate; cost per million; merging project rows by `projectId`; pooled-limit
mean, soonest reset and restored share, including accounts with errors; number and dollar
formatting.

**Manual check in the running app:** open the page on the development machine's real
transcripts; compare one day's totals against `npx ccusage@latest daily`; confirm a cold
scan shows progress and a second open is fast; confirm typing and Esc do not reach the
terminal while the page is open and that focus returns on close; check each theme.
