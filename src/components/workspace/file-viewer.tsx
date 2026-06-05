import { useState } from 'react'
import { CodeEditor } from './code-editor'
import { MarkdownPreview } from './markdown-preview'
import { useFiles, saveFile, tabKey, type OpenedFile } from '../../state/files'
import { useSettings } from '../../state/settings'

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const isMarkdown = (p: string): boolean => /\.(md|markdown)$/i.test(p)

export function FileViewer({ projectId }: { projectId: string }) {
  const openFiles = useFiles((s) => s.openFiles)
  const activePath = useFiles((s) => s.activeFileByProject[projectId] ?? null)
  const fileStates = useFiles((s) => s.fileStates)
  const setActiveFile = useFiles((s) => s.setActiveFile)
  const closeFile = useFiles((s) => s.closeFile)
  const setFileContent = useFiles((s) => s.setFileContent)
  const themeId = useSettings((s) => s.themeId)
  const editorSettings = useSettings((s) => s.editor)
  const [previewByPath, setPreviewByPath] = useState<Record<string, boolean>>({})

  const projectFiles = openFiles.filter((f) => f.projectId === projectId)
  const active: OpenedFile | null = activePath ? { projectId, path: activePath } : null
  const activeState = active ? fileStates[tabKey(active)] : undefined

  return (
    <div className="flex h-full flex-col border-l border-border bg-background">
      <div className="flex h-9 flex-shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-1">
        {projectFiles.map((f) => {
          const st = fileStates[tabKey(f)]
          const dirty = st?.kind === 'text' && st.current !== st.saved
          const isActive = f.path === activePath
          return (
            <div
              key={f.path}
              onClick={() => setActiveFile(projectId, f.path)}
              className={`group flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs ${
                isActive ? 'bg-foreground/10 text-foreground' : 'text-foreground/60 hover:bg-foreground/5'
              }`}
            >
              <span className="truncate">{basename(f.path)}</span>
              {dirty && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  closeFile(f)
                }}
                className="text-foreground/40 opacity-0 hover:text-foreground group-hover:opacity-100"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          )
        })}
        <div className="flex-1" />
        {active && isMarkdown(active.path) && (
          <button
            type="button"
            onClick={() =>
              setPreviewByPath((m) => ({ ...m, [active.path]: !m[active.path] }))
            }
            className="mr-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-foreground/10 hover:text-foreground"
          >
            {previewByPath[active.path] ? 'Edit' : 'Preview'}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {!active || !activeState ? (
          <Centered>No file open</Centered>
        ) : activeState.kind === 'loading' ? (
          <Centered>Loading…</Centered>
        ) : activeState.kind === 'binary' ? (
          <Centered>Binary file — can’t display</Centered>
        ) : activeState.kind === 'tooLarge' ? (
          <Centered>File too large (over 5 MB)</Centered>
        ) : activeState.kind === 'error' ? (
          <Centered>Error: {activeState.message}</Centered>
        ) : isMarkdown(active.path) && previewByPath[active.path] ? (
          <MarkdownPreview source={activeState.current} />
        ) : (
          <CodeEditor
            key={`${active.path}::${themeId}`}
            path={active.path}
            value={activeState.current}
            fontSize={editorSettings.fontSize}
            tabSize={editorSettings.tabSize}
            wordWrap={editorSettings.wordWrap}
            showLineNumbers={editorSettings.lineNumbers}
            onChange={(v) => setFileContent(active, v)}
            onSave={() => void saveFile(active)}
          />
        )}
      </div>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-sm text-muted">{children}</div>
}
