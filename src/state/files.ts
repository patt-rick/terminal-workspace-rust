import { create } from 'zustand'
import { ipc } from '../lib/ipc'

export interface OpenedFile {
  projectId: string
  path: string
}

export type FileTabKey = string
export const tabKey = (f: OpenedFile): FileTabKey => `${f.projectId}::${f.path}`

export type FileLoadState =
  | { kind: 'loading' }
  | { kind: 'text'; current: string; saved: string }
  | { kind: 'binary' }
  | { kind: 'tooLarge' }
  | { kind: 'error'; message: string }

export const FILE_PANE_MIN_WIDTH = 320
export const FILE_PANE_MAX_WIDTH = 1200
export const FILE_PANE_DEFAULT_WIDTH = 560
const FILE_PANE_WIDTH_KEY = 'tw:file-pane-width'

const clampPane = (w: number): number =>
  Math.min(FILE_PANE_MAX_WIDTH, Math.max(FILE_PANE_MIN_WIDTH, Math.round(w)))

const readPaneWidth = (): number => {
  try {
    const raw = localStorage.getItem(FILE_PANE_WIDTH_KEY)
    const n = raw ? Number.parseInt(raw, 10) : NaN
    return Number.isFinite(n) ? clampPane(n) : FILE_PANE_DEFAULT_WIDTH
  } catch {
    return FILE_PANE_DEFAULT_WIDTH
  }
}

interface FilesState {
  openFiles: OpenedFile[]
  activeFileByProject: Record<string, string | null>
  fileStates: Record<FileTabKey, FileLoadState>
  filePaneWidth: number

  openFile: (file: OpenedFile) => void
  closeFile: (file: OpenedFile) => void
  setActiveFile: (projectId: string, path: string | null) => void
  setFileContent: (file: OpenedFile, content: string) => void
  markFileSaved: (file: OpenedFile, content: string) => void
  setFilePaneWidth: (w: number) => void
}

export const useFiles = create<FilesState>((set) => ({
  openFiles: [],
  activeFileByProject: {},
  fileStates: {},
  filePaneWidth: readPaneWidth(),

  openFile: (file) => {
    set((state) => {
      const key = tabKey(file)
      const alreadyOpen = state.openFiles.some(
        (f) => f.projectId === file.projectId && f.path === file.path
      )
      return {
        openFiles: alreadyOpen ? state.openFiles : [...state.openFiles, file],
        activeFileByProject: { ...state.activeFileByProject, [file.projectId]: file.path },
        fileStates: alreadyOpen
          ? state.fileStates
          : { ...state.fileStates, [key]: { kind: 'loading' } },
      }
    })
    void loadFile(file)
  },

  closeFile: (file) =>
    set((state) => {
      const key = tabKey(file)
      const remaining = state.openFiles.filter(
        (f) => !(f.projectId === file.projectId && f.path === file.path)
      )
      const wasActive = state.activeFileByProject[file.projectId] === file.path
      const nextActive = wasActive
        ? remaining.filter((f) => f.projectId === file.projectId).at(-1)?.path ?? null
        : state.activeFileByProject[file.projectId] ?? null
      const { [key]: _omit, ...rest } = state.fileStates
      return {
        openFiles: remaining,
        activeFileByProject: { ...state.activeFileByProject, [file.projectId]: nextActive },
        fileStates: rest,
      }
    }),

  setActiveFile: (projectId, path) =>
    set((state) => ({
      activeFileByProject: { ...state.activeFileByProject, [projectId]: path },
    })),

  setFileContent: (file, content) =>
    set((state) => {
      const key = tabKey(file)
      const prev = state.fileStates[key]
      if (!prev || prev.kind !== 'text') return state
      return { fileStates: { ...state.fileStates, [key]: { ...prev, current: content } } }
    }),

  markFileSaved: (file, content) =>
    set((state) => {
      const key = tabKey(file)
      return {
        fileStates: { ...state.fileStates, [key]: { kind: 'text', current: content, saved: content } },
      }
    }),

  setFilePaneWidth: (w) => {
    const next = clampPane(w)
    set({ filePaneWidth: next })
    try {
      localStorage.setItem(FILE_PANE_WIDTH_KEY, String(next))
    } catch {
      // ignore
    }
  },
}))

async function loadFile(file: OpenedFile): Promise<void> {
  const key = tabKey(file)
  try {
    const res = await ipc.fs.readText(file.projectId, file.path)
    const next: FileLoadState =
      res.kind === 'text'
        ? { kind: 'text', current: res.content, saved: res.content }
        : res.kind === 'binary'
          ? { kind: 'binary' }
          : { kind: 'tooLarge' }
    useFiles.setState((state) => ({ fileStates: { ...state.fileStates, [key]: next } }))
  } catch (e) {
    useFiles.setState((state) => ({
      fileStates: { ...state.fileStates, [key]: { kind: 'error', message: String(e) } },
    }))
  }
}

/** Save the active file's current content back to disk. */
export async function saveFile(file: OpenedFile): Promise<void> {
  const state = useFiles.getState().fileStates[tabKey(file)]
  if (!state || state.kind !== 'text') return
  await ipc.fs.writeText(file.projectId, file.path, state.current)
  useFiles.getState().markFileSaved(file, state.current)
}
