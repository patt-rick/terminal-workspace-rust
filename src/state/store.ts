import { create } from 'zustand'
import { ipc, type Project, type TerminalRecord } from '../lib/ipc'
import { distroOfUncPath } from '../lib/wsl-paths'
import { WSL_CLAUDE_INSTALL, wslClaudeCheckTarget } from '../lib/wsl-claude'
import { useSettings } from './settings'
import { applySkipPermissions, linkClaudeSession } from './claude-command'

// Re-exported so existing importers keep working; the implementation lives in
// claude-command.ts so it can be unit tested without Tauri imports.
export { linkClaudeSession }

export const SIDEBAR_MIN_WIDTH = 180
export const SIDEBAR_MAX_WIDTH = 480
export const SIDEBAR_DEFAULT_WIDTH = 256

export const RIGHT_SIDEBAR_MIN_WIDTH = 220
export const RIGHT_SIDEBAR_MAX_WIDTH = 560
export const RIGHT_SIDEBAR_DEFAULT_WIDTH = 280

const SIDEBAR_WIDTH_KEY = 'tw:sidebar-width'
const SIDEBAR_COLLAPSED_KEY = 'tw:sidebar-collapsed'
const RIGHT_SIDEBAR_WIDTH_KEY = 'tw:right-sidebar-width'
const RIGHT_SIDEBAR_COLLAPSED_KEY = 'tw:right-sidebar-collapsed'

const clampSidebar = (w: number): number =>
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(w)))

const clampRightSidebar = (w: number): number =>
  Math.min(RIGHT_SIDEBAR_MAX_WIDTH, Math.max(RIGHT_SIDEBAR_MIN_WIDTH, Math.round(w)))

const readNum = (key: string, fallback: number): number => {
  try {
    const raw = localStorage.getItem(key)
    const n = raw ? Number.parseInt(raw, 10) : NaN
    return Number.isFinite(n) ? n : fallback
  } catch {
    return fallback
  }
}

/** A Claude launch held back because its WSL distro has no native claude. */
export interface PendingWslClaudeInstall {
  projectId: string
  name?: string
  cwd?: string
  shell: string
  startupCommand: string
  claudeSessionId?: string
  apikeyEntryId?: string
  /** '' = the default distro */
  distro: string
}

interface WorkspaceState {
  projects: Project[]
  selectedProjectId: string | null
  activeTerminalByProject: Record<string, string | null>
  expandedProjectIds: Record<string, boolean>
  unreadByTerminal: Record<string, number>
  titleByTerminal: Record<string, string>
  busyByTerminal: Record<string, boolean>
  sessionIdByTerminal: Record<string, string>
  pendingTerminalClose: { projectId: string; terminalId: string } | null
  pendingWslClaudeInstall: PendingWslClaudeInstall | null

  sidebarWidth: number
  sidebarCollapsed: boolean
  rightSidebarWidth: number
  rightSidebarCollapsed: boolean

  setProjects: (
    projects: Project[],
    opts?: { selectedProjectId?: string | null; activeTerminalByProject?: Record<string, string | null> }
  ) => void
  upsertProject: (project: Project) => void
  removeProject: (id: string) => void
  selectProject: (id: string | null) => void
  renameProject: (id: string, name: string) => void

  addTerminal: (projectId: string, terminal: TerminalRecord) => void
  removeTerminalLocal: (projectId: string, terminalId: string) => void
  renameTerminalLocal: (projectId: string, terminalId: string, name: string) => void
  setActiveTerminal: (projectId: string, terminalId: string | null) => void

  toggleProjectExpanded: (id: string) => void
  setProjectExpanded: (id: string, expanded: boolean) => void

  bumpUnread: (terminalId: string) => void
  clearUnread: (terminalId: string) => void
  setTerminalTitle: (terminalId: string, title: string) => void
  setTerminalBusy: (terminalId: string, busy: boolean) => void
  setTerminalSession: (terminalId: string, sessionId: string) => void

  requestTerminalClose: (projectId: string, terminalId: string) => void
  clearPendingTerminalClose: () => void

  requestWslClaudeInstall: (pending: PendingWslClaudeInstall) => void
  clearPendingWslClaudeInstall: () => void

  setSidebarWidth: (w: number) => void
  setRightSidebarWidth: (w: number) => void
  toggleSidebar: () => void
  toggleRightSidebar: () => void
}

export const useWorkspace = create<WorkspaceState>((set) => ({
  projects: [],
  selectedProjectId: null,
  activeTerminalByProject: {},
  expandedProjectIds: {},
  unreadByTerminal: {},
  titleByTerminal: {},
  busyByTerminal: {},
  sessionIdByTerminal: {},
  pendingTerminalClose: null,
  pendingWslClaudeInstall: null,

  sidebarWidth: clampSidebar(readNum(SIDEBAR_WIDTH_KEY, SIDEBAR_DEFAULT_WIDTH)),
  sidebarCollapsed: (() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })(),
  rightSidebarWidth: clampRightSidebar(readNum(RIGHT_SIDEBAR_WIDTH_KEY, RIGHT_SIDEBAR_DEFAULT_WIDTH)),
  rightSidebarCollapsed: (() => {
    try {
      return localStorage.getItem(RIGHT_SIDEBAR_COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })(),

  setProjects: (projects, opts) =>
    set((state) => {
      const activeNext: Record<string, string | null> = {
        ...state.activeTerminalByProject,
        ...(opts?.activeTerminalByProject ?? {}),
      }
      const expandedNext = { ...state.expandedProjectIds }
      for (const p of projects) {
        if (!(p.id in activeNext)) activeNext[p.id] = p.terminals[0]?.id ?? null
        const aid = activeNext[p.id]
        if (aid && !p.terminals.find((t) => t.id === aid)) {
          activeNext[p.id] = p.terminals[0]?.id ?? null
        }
      }
      const selectedId =
        opts?.selectedProjectId ?? state.selectedProjectId ?? projects[0]?.id ?? null
      if (selectedId && !(selectedId in expandedNext)) expandedNext[selectedId] = true
      return {
        projects,
        selectedProjectId: selectedId,
        activeTerminalByProject: activeNext,
        expandedProjectIds: expandedNext,
      }
    }),

  upsertProject: (project) =>
    set((state) => {
      const idx = state.projects.findIndex((p) => p.id === project.id)
      const next = [...state.projects]
      if (idx >= 0) next[idx] = project
      else next.push(project)
      return {
        projects: next,
        selectedProjectId: state.selectedProjectId ?? project.id,
        expandedProjectIds: {
          ...state.expandedProjectIds,
          [project.id]: state.expandedProjectIds[project.id] ?? true,
        },
      }
    }),

  removeProject: (id) =>
    set((state) => {
      const projects = state.projects.filter((p) => p.id !== id)
      const { [id]: _a, ...activeRest } = state.activeTerminalByProject
      const { [id]: _e, ...expandedRest } = state.expandedProjectIds
      return {
        projects,
        selectedProjectId:
          state.selectedProjectId === id ? projects[0]?.id ?? null : state.selectedProjectId,
        activeTerminalByProject: activeRest,
        expandedProjectIds: expandedRest,
      }
    }),

  // Selection does NOT control expansion: the project row toggles expansion
  // itself, and new/loaded projects are expanded by upsertProject/setProjects.
  // (Forcing expanded=true here defeated the row's collapse toggle.)
  selectProject: (id) => set({ selectedProjectId: id }),

  renameProject: (id, name) =>
    set((state) => ({ projects: state.projects.map((p) => (p.id === id ? { ...p, name } : p)) })),

  addTerminal: (projectId, terminal) => {
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === projectId ? { ...p, terminals: [...p.terminals, terminal] } : p
      ),
      activeTerminalByProject: { ...state.activeTerminalByProject, [projectId]: terminal.id },
    }))
    void ipc.projects.setActive(projectId, terminal.id)
  },

  removeTerminalLocal: (projectId, terminalId) => {
    let nextActive: string | null | undefined
    set((state) => {
      const project = state.projects.find((p) => p.id === projectId)
      const remaining = project ? project.terminals.filter((t) => t.id !== terminalId) : []
      const wasActive = state.activeTerminalByProject[projectId] === terminalId
      const { [terminalId]: _u, ...unreadRest } = state.unreadByTerminal
      const { [terminalId]: _t, ...titleRest } = state.titleByTerminal
      const { [terminalId]: _b, ...busyRest } = state.busyByTerminal
      const { [terminalId]: _s, ...sessionRest } = state.sessionIdByTerminal
      nextActive = wasActive ? remaining[0]?.id ?? null : state.activeTerminalByProject[projectId]
      return {
        projects: state.projects.map((p) =>
          p.id === projectId ? { ...p, terminals: remaining } : p
        ),
        activeTerminalByProject: { ...state.activeTerminalByProject, [projectId]: nextActive ?? null },
        unreadByTerminal: unreadRest,
        titleByTerminal: titleRest,
        busyByTerminal: busyRest,
        sessionIdByTerminal: sessionRest,
      }
    })
    if (nextActive !== undefined) void ipc.projects.setActive(projectId, nextActive)
  },

  renameTerminalLocal: (projectId, terminalId, name) =>
    set((state) => {
      const { [terminalId]: _t, ...titleRest } = state.titleByTerminal
      return {
        projects: state.projects.map((p) =>
          p.id === projectId
            ? { ...p, terminals: p.terminals.map((t) => (t.id === terminalId ? { ...t, name } : t)) }
            : p
        ),
        titleByTerminal: titleRest,
      }
    }),

  setActiveTerminal: (projectId, terminalId) => {
    set((state) => ({
      activeTerminalByProject: { ...state.activeTerminalByProject, [projectId]: terminalId },
    }))
    void ipc.projects.setActive(projectId, terminalId)
  },

  toggleProjectExpanded: (id) =>
    set((state) => ({
      expandedProjectIds: { ...state.expandedProjectIds, [id]: !state.expandedProjectIds[id] },
    })),

  setProjectExpanded: (id, expanded) =>
    set((state) => ({ expandedProjectIds: { ...state.expandedProjectIds, [id]: expanded } })),

  bumpUnread: (terminalId) =>
    set((state) => ({
      unreadByTerminal: {
        ...state.unreadByTerminal,
        [terminalId]: (state.unreadByTerminal[terminalId] ?? 0) + 1,
      },
    })),

  clearUnread: (terminalId) =>
    set((state) => {
      if (!state.unreadByTerminal[terminalId]) return state
      const { [terminalId]: _o, ...rest } = state.unreadByTerminal
      return { unreadByTerminal: rest }
    }),

  setTerminalTitle: (terminalId, title) =>
    set((state) => {
      const trimmed = title.trim()
      const current = state.titleByTerminal[terminalId]
      if (!trimmed) {
        if (!current) return state
        const { [terminalId]: _o, ...rest } = state.titleByTerminal
        return { titleByTerminal: rest }
      }
      if (current === trimmed) return state
      return { titleByTerminal: { ...state.titleByTerminal, [terminalId]: trimmed } }
    }),

  setTerminalBusy: (terminalId, busy) =>
    set((state) => {
      const current = !!state.busyByTerminal[terminalId]
      if (current === busy) return state
      if (!busy) {
        const { [terminalId]: _o, ...rest } = state.busyByTerminal
        return { busyByTerminal: rest }
      }
      return { busyByTerminal: { ...state.busyByTerminal, [terminalId]: true } }
    }),

  setTerminalSession: (terminalId, sessionId) =>
    set((state) => ({
      sessionIdByTerminal: { ...state.sessionIdByTerminal, [terminalId]: sessionId },
    })),

  requestTerminalClose: (projectId, terminalId) =>
    set({ pendingTerminalClose: { projectId, terminalId } }),
  clearPendingTerminalClose: () => set({ pendingTerminalClose: null }),

  requestWslClaudeInstall: (pending) => set({ pendingWslClaudeInstall: pending }),
  clearPendingWslClaudeInstall: () => set({ pendingWslClaudeInstall: null }),

  setSidebarWidth: (w) => {
    const next = clampSidebar(w)
    set({ sidebarWidth: next })
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next))
    } catch {
      // ignore
    }
  },

  setRightSidebarWidth: (w) => {
    const next = clampRightSidebar(w)
    set({ rightSidebarWidth: next })
    try {
      localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, String(next))
    } catch {
      // ignore
    }
  },

  toggleSidebar: () =>
    set((state) => {
      const next = !state.sidebarCollapsed
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0')
      } catch {
        // ignore
      }
      return { sidebarCollapsed: next }
    }),

  toggleRightSidebar: () =>
    set((state) => {
      const next = !state.rightSidebarCollapsed
      try {
        localStorage.setItem(RIGHT_SIDEBAR_COLLAPSED_KEY, next ? '1' : '0')
      } catch {
        // ignore
      }
      return { rightSidebarCollapsed: next }
    }),
}))

/** Create a terminal for a project, applying the configured startup command. */
export async function createProjectTerminal(
  projectId: string,
  opts?: {
    cwd?: string
    name?: string
    shell?: string
    startupCommand?: string
    claudeSessionId?: string
    apikeyEntryId?: string
  }
): Promise<TerminalRecord | null> {
  let startupCommand =
    opts?.startupCommand ?? (useSettings.getState().terminal.startupCommand.trim() || undefined)
  let claudeSessionId = opts?.claudeSessionId
  // Global "always skip permissions" setting: applied centrally here so every
  // spawn path (chooser, ⇧T/⇧D shortcuts, empty-state button, resume) inherits
  // it. Already-flagged commands (⇧D) are untouched — the flag is never doubled.
  if (startupCommand) {
    startupCommand = applySkipPermissions(
      startupCommand,
      useSettings.getState().terminal.claudeSkipPermissions
    )
  }
  // Fresh `claude` launches get a generated session id so they show as "open"
  // in the Sessions panel. Resume launches already carry an explicit id.
  if (startupCommand && !claudeSessionId) {
    const linked = linkClaudeSession(startupCommand)
    startupCommand = linked.startupCommand
    claudeSessionId = linked.sessionId
  }
  const project = useWorkspace.getState().projects.find((p) => p.id === projectId)
  const projectDistro = project ? distroOfUncPath(project.path) : null
  const shell =
    opts?.shell ??
    (projectDistro ? `wsl:${projectDistro}` : undefined) ??
    (useSettings.getState().terminal.defaultShell || undefined)
  // A Windows claude can't run through WSL interop (platform-native binary),
  // so a claude launch into a distro without its own install would hard-error.
  // Hold the launch and ask to install instead. Probe failures never block.
  const wslDistro = wslClaudeCheckTarget(shell, startupCommand)
  if (wslDistro !== null && shell && startupCommand) {
    const present = await ipc.apikeys.binaryExists('claude', wslDistro).catch(() => true)
    if (!present) {
      useWorkspace.getState().requestWslClaudeInstall({
        projectId,
        name: opts?.name,
        cwd: opts?.cwd,
        shell,
        startupCommand,
        claudeSessionId,
        apikeyEntryId: opts?.apikeyEntryId,
        distro: wslDistro,
      })
      return null
    }
  }
  const record = await ipc.terminals.create({
    projectId,
    startupCommand,
    cwd: opts?.cwd,
    name: opts?.name,
    shell,
    apikeyEntryId: opts?.apikeyEntryId,
  })
  return registerTerminal(projectId, record, claudeSessionId)
}

/** Adopt a created terminal into the workspace and link its Claude session. */
function registerTerminal(
  projectId: string,
  record: TerminalRecord | null,
  claudeSessionId?: string
): TerminalRecord | null {
  if (record) {
    useWorkspace.getState().addTerminal(projectId, record)
    if (claudeSessionId) useWorkspace.getState().setTerminalSession(record.id, claudeSessionId)
  }
  return record
}

/**
 * Consented WSL install: create the held-back terminal with the official
 * installer chained in front of the stashed launch command. Goes straight to
 * ipc — createProjectTerminal's transforms already ran on the stashed command.
 */
export async function confirmWslClaudeInstall(): Promise<void> {
  const pending = useWorkspace.getState().pendingWslClaudeInstall
  if (!pending) return
  useWorkspace.getState().clearPendingWslClaudeInstall()
  const record = await ipc.terminals.create({
    projectId: pending.projectId,
    startupCommand: `${WSL_CLAUDE_INSTALL} ; ${pending.startupCommand}`,
    cwd: pending.cwd,
    name: pending.name,
    shell: pending.shell,
    apikeyEntryId: pending.apikeyEntryId,
  })
  registerTerminal(pending.projectId, record, pending.claudeSessionId)
}

/** Kill a terminal and drop its record everywhere. */
export async function closeProjectTerminal(projectId: string, terminalId: string): Promise<void> {
  await ipc.terminals.kill(terminalId)
  void ipc.terminals.removeRecord(projectId, terminalId)
  useWorkspace.getState().removeTerminalLocal(projectId, terminalId)
}
