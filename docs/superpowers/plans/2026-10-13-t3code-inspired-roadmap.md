# T3 Code-Inspired Features — Roadmap

**Status:** proposed, awaiting owner approval. Nothing here is built. Reviewed twice by an Opus subagent against the code; its findings are folded in.

**Goal:** Bring the best of [T3 Code](https://github.com/pingdotgg/t3code) into Terminal Workspace without adopting its chat interface. The app stays terminal-first: agents keep running as their own TUIs in PTYs.

**What this document is:** a decomposition and ordering of 50 items into 7 milestones. It is not an implementation plan. Each item (or small group) gets its own spec in `docs/superpowers/specs/` and its own plan in `docs/superpowers/plans/` when its turn comes, exactly as earlier features did.

**Source of the feature list:** T3 Code's `docs/user/` and file tree at v0.0.45, read on 2026-10-13. Their app was not run.

---

## Hard constraint

**No chat interface.** Nothing in this roadmap parses agent output into a message timeline, replaces the terminal with a composer, or renders approvals as buttons. Features that only make sense inside a chat view are listed under [Dropped](#dropped).

**No prompt box, full terminal** (owner decision, 2026-10-13). The app never shows an input field for writing a prompt to an agent. A prompt reaches an agent in one of three ways only:

- The user types it in the terminal.
- It is read from a file the user wrote in the editor (scheduled tasks, webhook templates).
- It arrives from outside (a prompt link, a PR event, another agent over MCP) and is either passed on the command line at launch or typed into the terminal's own input line, unsent where the user is present to review it.

## What we build on

| Existing piece | Where | Used by |
|---|---|---|
| Claude hooks (`Notification`, `Stop`) routed to the spawning terminal by `--session-id` | `src-tauri/src/claude/hooks.rs` | M3 turn features |
| Usage-limit detector on the PTY stream; auto-switch orchestrator that already types into PTYs | `src-tauri/src/pty/limit.rs`, `src/state/auto-switch.ts` | M3 queue and auto-resume |
| Per-account 5-hour / 7-day / extra-usage fetch (a percentage per account, not absolute quota) | `src-tauri/src/claude/usage.rs` | M1 limits view |
| Transcript path encoding and WSL home discovery | `src-tauri/src/claude/mod.rs` | M1 usage scanner, M6 search |
| GitHub REST client: PR list / get / create / merge / comment, Actions runs | `src-tauri/src/github/mod.rs` | M4 PR loop |
| Multi-repo discovery and per-repo identity | `src-tauri/src/git/discover.rs`, `identity/` | M2 worktrees |
| Embedded axum server, pairing, Cloudflare quick tunnel / Tailscale | `src-tauri/src/remote/` | M5 webhooks and MCP, M7 remote |
| Provider API keys in the OS keychain | `src-tauri/src/apikeys/` | M1 AI commit messages |

The existing transcript reader parses titles only and reads one project at a time, so the usage scanner (1.3) is new code that reuses only the path helpers.

## Foundations

Three pieces of groundwork come before the features that depend on them. Each is scheduled inside the milestone that first needs it.

### F1 — Session store (item 2.1)

Nothing about a terminal survives a restart today. `StateStore` clears every project's `terminals` on both load and save (`src-tauri/src/state/mod.rs:73-76`, `:88-92`), and the Claude session id is held in memory only. So this is a new durable entity, not an extension of `TerminalRecord`.

A session record outlives its terminal and holds: project, Claude session id, worktree and branch (if any), linked PRs, and state (active, pinned, snoozed-until, settled). A session whose terminal is gone can be revived with `claude --resume`.

Two requirements for the spec:

- Store it in its own file, not `state.json`. `state.json` is read with `serde_json::from_str(..).ok()` and `unwrap_or_default()`, so a parse failure after a schema change, or a downgrade, would silently wipe all projects.
- The new file's load path must fail safe: an unreadable file is kept and reported, never replaced with defaults.

### F2 — Turn events (item 3.1)

The hooks integration installs `Notification` and `Stop` only, and the pipeline was built for badges: the hook process writes a spool file and exits, a watcher polls every 500 ms, deletes each file before parsing it, and reads the directory unsorted. A lost or reordered event is harmless for a badge but breaks a checkpoint or a queue.

The spec must cover:

- **Turn start.** Add the `UserPromptSubmit` hook. Work that must happen before the agent's first edit (the checkpoint snapshot) runs synchronously inside the hook process, not in the watcher.
- **Reliable delivery.** Atomic spool writes, ordered delivery, and parse-before-delete.
- **Routing.** Inject a terminal-id environment variable into every PTY (none exists today) so hook processes can name their terminal even when the session id changes, and add the `SessionStart` hook to re-bind ids. This also covers a `claude` typed by hand.
- **WSL.** Hooks are installed only into distros that are running when the user enables them. The spec says how a distro started later gets them.
- **Feature flag.** The watcher and session routing are compiled only with `remote-access` (`hooks.rs:178-224`). Turn events must work in a `--no-default-features` build.
- **Gaps to design around.** Turns that start without a user prompt (the auto-switch relaunch, background wake-ups) and turns that end without `Stop` (an Esc interrupt) need a fallback, most likely the existing title-spinner busy signal.

Hooks stay an opt-in setting; see Q8 for how M3 features behave when they are off.

### F3 — Start a session with a prompt (item 2.2)

Scheduled tasks, webhooks, the MCP server and prompt links all need to open a terminal, start an agent and hand it a prompt that came from a file or from outside. This is one shared primitive with two modes:

- **Run:** the agent starts on the prompt at once. Used for unattended runs.
- **Prefill:** the prompt is placed in the agent's input line without pressing Enter. Used when the user is present and should review before sending.

Requirements for the spec:

- **Prompt text never passes through a shell command line.** Startup commands today are typed into the shell 150 ms after first output, with every newline turned into Enter (`src-tauri/src/pty/mod.rs:549-551`, `:705-718`). A multi-line prompt, or a webhook field, would run as shell commands. Run mode therefore either spawns the agent directly with an argument vector (a new spawn mode) or delivers the prompt by bracketed paste into the ready TUI followed by Enter.
- **A readiness signal.** None exists today: the busy detector emits only on change, and an idle Claude start produces no event. The spec picks one (the first idle-title sequence, the TUI enabling bracketed paste, or output quiescence). If readiness is not confirmed within a time cap, nothing is typed and the user is told. Text sent early would land in the shell or in a trust or login dialog.
- **Claude Code first.** Other CLIs are added one at a time as their readiness signal is confirmed.

Broadcast input (2.7) reuses the readiness signal.

---

## Milestones

Sizes are rough: **S** about a day, **M** a few days, **L** one to two weeks, **XL** more than two weeks. Each milestone is a releasable step.

### M1 — Quick wins and usage

Three independent tracks (palette, usage, commit) with no shared groundwork.

| # | Item | Size | Notes |
|---|---|---|---|
| 1.1 | **Command palette** (Ctrl+K) | M | Searches commands, projects, terminals and sessions. Quick-open (Ctrl+P) stays as the file finder. Later features register their commands here. Ctrl+K will shadow kill-line inside terminals, as Ctrl+P and Ctrl+B already shadow their terminal meanings; 1.2 lets the user rebind it. |
| 1.2 | **User-editable keybindings** | M | A `keybindings.json` of `{ key, command, when }` rules plus a settings page. Shortcuts are hard-coded in `src/app.tsx` today. Depends on 1.1's command registry. |
| 1.3 | **Usage history scanner** | L | New Rust scanner over `~/.claude/projects/**/*.jsonl` and WSL homes: parse assistant `usage` records, de-duplicate by message id + request id across all files, bucket by local day or hour, model and project. Per-file cache keyed by size and modified time with a resume offset. |
| 1.4 | **Pricing** | S | Fetch and cache LiteLLM's model price table. Offline falls back to the cached copy. Unknown models are counted as unpriced, never guessed. |
| 1.5 | **Usage page** | L | Full-pane view: Cost / Tokens / Limits, periods 24h / 7d / 30d / 90d, stacked chart, totals (processed, cached, uncached, output, cache savings), share bars by token type and cost type, per-model breakdown with trend, cache hit rate and cost per million tokens. Adds a per-project breakdown. Cost is labelled as an API-equivalent estimate, not money spent. Depends on 1.3 and 1.4. |
| 1.6 | **Pooled limits view** | M | Per window, one bar with an equal-width segment per account showing its remaining share, the next reset, and what that reset restores. The headline figure is the equal-weight average of what is left, as in T3 Code; it is labelled as such because the API gives percentages and plans differ in size. |
| 1.7 | **Custom model prices and model mapping** | S | Override a model's rates or count one model as another. Depends on 1.4. |
| 1.8 | **Git commit from the UI** | M | Stage, unstage and commit in the Git tab. No commit or stage command exists today, and the diff does not separate staged from unstaged. Shells out to `git` for the commit so the user's hooks and signing apply. |
| 1.9 | **AI-written commit messages, PR titles and descriptions** | M | Depends on 1.8. See Q2 for which model writes them. |

Known limit for 1.3–1.5: account switching rewrites one `~/.claude/.credentials.json`, so all accounts share transcripts. Cost history splits by model, day and project, not by account. Limits (1.6) remain per account.

### M2 — Parallel work

| # | Item | Size | Notes |
|---|---|---|---|
| 2.1 | **Session store (F1)** | L | Described above. |
| 2.2 | **Start a session with a prompt (F3)** | M–L | Described above. First used by 2.7 for its readiness signal; run and prefill are first used in M5. |
| 2.3 | **Worktree per session** | L–XL | "New session in a worktree": creates a branch and working directory and starts the agent there, with auto-named branches and an optional per-project setup script. Depends on 2.1. Several subsystems key on the project root and must be taught about worktrees: see the scope list below. |
| 2.4 | **Pin, snooze, settle** | M | Sidebar sections for pinned, active and settled sessions; snooze until a time. Depends on 2.1. |
| 2.5 | **"Working" section** | S | Busy sessions fold away and return to the top when they finish or need attention. Uses the existing busy and attention signals. Depends on 2.4. |
| 2.6 | **Worktree cleanup policies** | M | Remove after N idle days or when the session is deleted. Never removes a worktree with uncommitted changes by default. Depends on 2.3. The "after the PR merges" policy needs PR linking and ships with 4.2. |
| 2.7 | **Same prompt to several models (broadcast input)** | M | Pick several models; each starts in its own worktree and terminal, joined in a broadcast group. What the user types in one terminal of the group is sent to all of them, as in tmux's synchronised panes. Broadcast turns itself off after the first Enter by default, with an option to keep it on, because the sessions diverge from then on. Rules for the spec: wait until every member is ready before accepting input; send text and paste only, never mouse or focus reports; pause if any member shows a permission or trust dialog. Desktop only at first; the remote web client sends input by another path. Depends on 2.2 (readiness) and 2.3. |
| 2.8 | **Auto-pull the default branch** | M | Fast-forward only, and only when the checkout is clean. No fetch or pull exists in `git/mod.rs` today; the spec defines the trigger (on project open and on a timer). |

**Worktree scope (2.3).** These break if a session's directory is not the project root, and are part of the item:

- Sessions panel: transcripts are looked up by the encoded project root and rejected when their `cwd` differs (`claude/mod.rs:39-43`, `:165`), so a worktree session would not be listed or deletable.
- Identity: mappings key on the repo path (`identity/mod.rs:183-204`), so each new worktree would be unmapped.
- Discovery: a worktree's `.git` file passes the repo test (`git/discover.rs:154`), so in-project worktrees would show as extra repos.
- Multi-repo and non-git projects: agents start at the project root, which may hold several repos or none. See Q9.

### M3 — Turn-aware features

All of these use hooks for turn boundaries, so they apply to Claude Code sessions only, and only when hooks are enabled. Other CLIs keep working as plain terminals.

| # | Item | Size | Notes |
|---|---|---|---|
| 3.1 | **Turn events (F2)** | L | Described above. Starts with a spike on the Claude Code behaviours listed under [Spikes](#spikes). |
| 3.2 | **Checkpoints** | L | On each turn start, snapshot the working tree to a hidden git ref using a temporary index, so neither the branch nor the staging area is touched. Restore rewinds files only; the conversation is not rewound, so the agent still believes its edits exist and the restore must say so. Refs are shared across worktrees, so the ref namespace is keyed per session. For WSL-rooted projects git runs inside the distro. Depends on 3.1. Scope questions in Q5. |
| 3.3 | **Per-turn diff** | M | "What did the last turn change", from the checkpoint to now, in the existing diff viewer. Depends on 3.2. |
| 3.4 | **Queued prompts** | M | Hold prompts from programmatic senders (PR watch in 4.3, outside agents in 5.5, auto-resume in 3.6) per terminal and send the next one when the turn ends. There is no UI for writing a queued prompt: the user queues their own follow-ups by typing in the terminal, which Claude Code already supports. The queue is visible and its entries can be removed. Depends on 3.1. Rules for the spec: use bracketed paste for multi-line text, do not send while the user has typed-but-unsent input, and pause the queue on a permission notification or a detected usage limit. |
| 3.5 | **Context-window meter** | S | Tokens in context for the active session, from the latest main-thread usage record in its transcript (subagent records skipped). A percentage needs a model-to-window table, since the window size is not in the transcript. Depends on 2.1's session-to-transcript mapping. |
| 3.6 | **Auto-resume at limit reset** | M | When a session stops on a usage limit and no healthy account is available to switch to, send a continue at the reset time. Depends on the existing limit detector and the same send mechanism as 3.4. Snoozing the session until then is optional and uses 2.4. |

### M4 — Pull-request loop

| # | Item | Size | Notes |
|---|---|---|---|
| 4.1 | **Session ↔ PR linking** | M | Auto-link by branch, manual link and unlink, status badge on the session. Depends on 2.1. |
| 4.2 | **Settle and clean up on merge** | S | A session whose linked PR merged moves to settled, and its worktree becomes eligible for cleanup. Depends on 4.1, 2.4 and 2.6. |
| 4.3 | **PR watch** | M | Poll a linked PR every two minutes; on failed checks, a new review or a conflict, notify and optionally queue a prompt for the session. The prompt is a built-in fixed template naming what changed; it can be replaced only by a prompt file, as in 5.3. Stops when the PR merges or closes. Depends on 4.1 and 3.4, so it needs M3 as well as M2. Subject to Q7. |
| 4.4 | **In-app PR review** | XL | Diff with line comments held as drafts until the review is submitted, mark files viewed (synced with github.com), auto-merge. The client is REST-only and the diff viewer handles local working-tree diffs only; viewed-marks and auto-merge need GitHub's GraphQL API. |
| 4.5 | **AI review guides** | L | A guided tour of a PR in reading order. Depends on 4.4 and the model choice from Q2. |
| 4.6 | **Stacked PRs** | L | Show stack position, merge stack, rebase stack, in the existing PR list. |

### M5 — Automation

Items 5.4 and 5.5 change the remote security model: they need a listener that is up whenever the app runs, and 5.4 needs a route reachable without pairing. Today the server binds only during a remote session and every route is pairing-gated. All unattended senders are subject to Q7.

| # | Item | Size | Notes |
|---|---|---|---|
| 5.1 | **Keep running in the tray** | M | Closing the window hides it; PTYs stay alive in the existing process. No tray exists today. Lets 5.3 and 5.4 run with the window closed. |
| 5.2 | **Project scripts** | M | Named actions per project (test, dev, clean), runnable from the palette with their own keybindings, optionally declared in a repo config file. Depends on 1.1 and 1.2. |
| 5.3 | **Scheduled tasks** | M | Recurring runs on a schedule; each starts a session, optionally in a worktree. A task points at a prompt file (Markdown, written in the built-in editor); settings hold only the schedule, project, model and file path. The app must be running (5.1 helps). Depends on 2.1 and 2.2. |
| 5.4 | **Webhook-triggered runs** | L | A URL that starts a session with signature checking. The prompt is a template file with `{{body.field}}` placeholders, like a scheduled task's. Needs a stable public URL; see Q3. Depends on 5.3. |
| 5.5 | **MCP server for outside agents** | L | Lets an external agent list projects and sessions and start or message a session. Read-only by default, explicit grant for anything more. Starting a session uses F3's run mode. Depends on 2.1 and 2.2; messaging a session depends on 3.4. |
| 5.6 | **Prompt links** | M | A `terminal-workspace://` deep link that opens a new terminal in the matching project, starts the chosen agent and types the prompt into its input line unsent (F3 prefill). The user reads it there and presses Enter. Never runs anything by itself. Needs the deep-link and single-instance plugins, which are not installed. Depends on 2.2. |

### M6 — Polish

Independent of each other; pick by appetite.

| # | Item | Size | Notes |
|---|---|---|---|
| 6.1 | **First-run wizard** | M | Detects installed agents, offers install and login, imports projects from Claude history. |
| 6.2 | **Per-project setting overrides** | M | Default → app → project chain, visible in settings. |
| 6.3 | **Theme extras** | M | Import VS Code themes, separate light and dark theme, click an area of the app to find its color token. |
| 6.4 | **Search across all sessions' messages** | L | From the palette, backed by an index over all transcripts that shares 1.3's scanner. A hit shows a text snippet and offers to resume that session; it does not open a transcript viewer. Depends on 1.1 and 1.3. |
| 6.5 | **Scrollback that survives restart** | L | Persist a serialised terminal snapshot per session and show it when the session is revived. Raw PTY bytes from a TUI do not replay cleanly, so this needs xterm's serialiser, and it needs 2.1 so there is a session to attach it to. The process itself is not restored. |
| 6.6 | **SnapShots** | L | Global hotkey captures the active window to a file and pastes its path into the active agent terminal. Windows first. Needs the global-shortcut plugin, which is not installed. |
| 6.7 | **Package-manager distribution** | S | winget and scoop manifests, generated by the release workflow. |

### M7 — Remote and big bets

Each of these is large or changes the support surface, and needs its own go / no-go before a spec is written.

| # | Item | Size | Notes |
|---|---|---|---|
| 7.1 | **Several paired devices at once** | M–L | Lifts the single-session limit (`remote/session.rs:95-103`). Each terminal holds one remote size today, so several devices need size arbitration. |
| 7.2 | **Multi-route with failover** | M | LAN, Tailscale and tunnel for one machine; use the first that answers. |
| 7.3 | **Headless service** | XL | Split the core into a service so agents survive the app quitting, not just the window closing. 5.1 covers most of the everyday need. |
| 7.4 | **Several machines in one UI** | XL | Depends on 7.3. |
| 7.5 | **More git hosts** | L each | GitLab, Bitbucket, Azure DevOps, Forgejo / Gitea, behind one host interface. |
| 7.6 | **Embedded preview browser** | XL | An agent-drivable browser pane with cookie import. |
| 7.7 | **Device panel** | XL | Live iOS Simulator / Android Emulator beside a session. iOS needs macOS. |
| 7.8 | **Native mobile apps** | XL | Live activities, quota widget, offline queue, voice input. The PWA covers the core today. |

---

## Dependency summary

```
1.1 palette ──► 1.2 keybindings ──► 5.2 scripts
            └─► 6.4 search
1.3 scanner ──► 1.5 usage page, 6.4 search
1.4 pricing ──► 1.5 usage page, 1.7 prices
1.8 commit ──► 1.9 AI messages
2.1 session store ──► 2.3 worktrees ──► 2.6 cleanup ──► 4.2 settle on merge
                  │                 └─► 2.7 multi-model
                  ├─► 2.4 pin/snooze/settle ──► 2.5 working, 4.2 settle on merge
                  ├─► 3.5 context meter
                  ├─► 4.1 PR linking ──► 4.2 settle on merge, 4.3 PR watch
                  ├─► 5.3 scheduled, 5.5 MCP
                  └─► 6.5 scrollback
2.2 start with prompt ──► 2.7 multi-model, 5.3 scheduled, 5.5 MCP, 5.6 prompt links
3.1 turn events ──► 3.2 checkpoints ──► 3.3 per-turn diff
                └─► 3.4 queued prompts ──► 3.6 auto-resume, 4.3 PR watch, 5.5 MCP messaging
4.4 PR review ──► 4.5 review guides
5.3 scheduled ──► 5.4 webhooks
7.3 headless ──► 7.4 multi-machine
```

M1 depends on nothing else. M2 comes before M3's context meter, all of M4 and most of M5. M3 comes before 4.3 and before session messaging in 5.5. Items in M5, M6 and M7 can be pulled forward one at a time once their listed dependencies are met.

## Dropped

These exist in T3 Code but only make sense inside a chat view:

- Rich composer with file, image, PR and thread chips; prompt stash; prompt history recall.
- In-app approval buttons and unified permission modes.
- Collapsed activity log of tool calls.
- Rewinding the conversation ("edit from here"). File-only restore is kept as 3.2.
- Switching provider mid-thread with context handoff.
- Visual replies (inline HTML, Mermaid, MCP apps).
- Agents as structured providers over ACP. Other CLIs stay as plain terminals launched by the model picker.

## Spikes

These are assumptions about Claude Code's own behaviour that were not tested while writing this roadmap. 3.1 starts by confirming them:

- Whether `Stop` fires when a turn is interrupted with Esc.
- Whether `/clear` starts a new session id, and whether `SessionStart` reports it.
- Whether `UserPromptSubmit` fires for turns continued by a hook or a background wake-up.
- What Claude Code's built-in `/rewind` restores (edit-tool changes only, or shell changes too), which decides how much 3.2 adds.
- Whether a headless `claude -p` call can skip writing a transcript, so AI commit messages do not show up in the Sessions panel and the usage history.

## Open questions

These change scope and need the owner's answer before the affected spec is written. None blocks M1 items 1.1–1.8.

- **Q1 — Order.** Is M1 → M7 the right order, or should something be pulled forward?
- **Q2 — Which model writes commit messages, PR text and review guides (1.9, 4.5)?** A headless `claude -p` call uses the active account's quota and needs no key; a stored provider API key needs one configured. Recommendation: `claude -p` by default with a setting to use a provider key, provided the transcript spike passes.
- **Q3 — Webhooks need a stable public URL (5.4).** The Cloudflare quick tunnel gives a new URL every session. Options: require a named Cloudflare tunnel or Tailscale Funnel for webhooks, or drop 5.4.
- **Q4 — M7 scope.** Which big bets are wanted at all? Recommendation: 7.1 and 7.2 yes; decide the rest after M5.
- **Q5 — Checkpoint scope (3.2).** In a multi-repo project, snapshot every discovered repo each turn, or only the selected one? Are untracked files included, and ignored files? How long are hidden refs kept before pruning? And is 3.2 still wanted if the spike shows Claude Code's own rewind covers most of it?
- **Q6 — Prompt entry box: resolved, no.** The owner ruled "no prompt box, full terminal" on 2026-10-13. 2.7, 3.4, 4.3, 5.3, 5.4 and 5.6 are written to that rule; see [Hard constraint](#hard-constraint). Still open: 6.4 shows matched message text as short snippets in the palette, which the ruling did not address.
- **Q7 — Trust boundary for unattended prompts.** 4.3, 5.4 and 5.5 put text from outside (PR reviews, webhook bodies, another agent) into a session. Skip-permissions is one global setting applied to every launch today. Recommendation: automated runs never use skip-permissions unless the owner opts in per task, and outside text is always marked as such in the prompt. Outside text never reaches a shell command line (see F3). Also to decide: whether prompt files for 5.3 and 5.4 live in the repo, where an agent could edit its own future prompts, or in app data. Recommendation: app data by default.
- **Q8 — When hooks are off.** Do M3 features prompt the user to enable hooks, or stay hidden until they are on? Recommendation: prompt once, on first use of an M3 feature.
- **Q9 — Worktrees in multi-repo projects (2.3).** Where do worktrees live (a folder in app data, or beside the repo)? In a project with several repos, does a worktree session cover the selected repo only? Recommendation: app data, selected repo only, and no worktree option for non-git projects.

## Process for each item

1. Brainstorm and write a spec in `docs/superpowers/specs/`, reviewed by an Opus subagent.
2. Write an implementation plan in `docs/superpowers/plans/`, reviewed by an Opus subagent.
3. Implement with tests (`pnpm test`, `cargo test`), then code review: Fable for big features, Opus otherwise.
4. Add a `CHANGELOG.md` entry under `## [Unreleased]`.
5. Release with `pnpm release <x.y.z>` at each milestone, or sooner.
