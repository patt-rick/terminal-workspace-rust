import { useEffect, useRef, useState } from 'react'
import { ipc, type Project, type ProjectIcon } from '../../lib/ipc'
import { checkUpload, pngDataUrl, toIconPng } from '../../lib/icon-image'
import { newSeed } from '../../lib/navii'
import { PROJECT_COLOR_NAMES, PROJECT_COLORS } from '../../lib/project-colors'
import { useProjectIcons } from '../../state/project-icons'
import { useWorkspace } from '../../state/store'
import { useUi } from '../../state/ui'
import { ProjectTileView } from './project-tile'

interface Draft {
  color: string
  icon: ProjectIcon | null
  /** the picture shown for an 'image' icon */
  imageUrl: string | null
  /** set only when a new picture was picked in this dialog */
  imageBytes: Uint8Array | null
}

/** Mounted once; shows for the project named by `iconDialogProjectId`. */
export function ProjectIconDialog() {
  const projectId = useUi((s) => s.iconDialogProjectId)
  const project = useWorkspace((s) => s.projects.find((p) => p.id === projectId) ?? null)
  const close = useUi((s) => s.closeIconDialog)

  // The project can be removed while its dialog is open.
  useEffect(() => {
    if (projectId && !project) close()
  }, [projectId, project, close])

  if (!project) return null
  return <Dialog key={project.id} project={project} onClose={close} />
}

function Dialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => ({
    color: project.color,
    icon: project.icon ?? null,
    imageUrl: useProjectIcons.getState().urls[project.id] ?? null,
    imageBytes: null,
  }))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const dialog = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    dialog.current?.focus()
  }, [])

  const onPick = async (file: File | undefined): Promise<void> => {
    if (!file) return
    const problem = checkUpload(file)
    if (problem) {
      setError(problem)
      return
    }
    try {
      const bytes = await toIconPng(file)
      setError(null)
      setDraft((d) => ({ ...d, icon: { kind: 'image' }, imageUrl: pngDataUrl(bytes), imageBytes: bytes }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    // Applied after each step, so a later step failing still shows what was saved.
    // The reply has no terminals (the Rust side does not persist them), so only
    // its colour and icon are taken.
    const apply = (saved: Project): void => {
      const ws = useWorkspace.getState()
      const live = ws.projects.find((p) => p.id === project.id)
      if (live) ws.upsertProject({ ...live, color: saved.color, icon: saved.icon ?? null })
    }
    try {
      if (draft.color !== project.color) apply(await ipc.projects.setColor(project.id, draft.color))
      const icons = useProjectIcons.getState()
      if (draft.icon?.kind === 'image') {
        if (draft.imageBytes && draft.imageUrl) {
          apply(await ipc.projects.setIconImage(project.id, Array.from(draft.imageBytes)))
          icons.set(project.id, draft.imageUrl)
        }
      } else if (draft.icon?.kind === 'navii') {
        if (project.icon?.kind !== 'navii' || project.icon.seed !== draft.icon.seed) {
          apply(await ipc.projects.setIconNavii(project.id, draft.icon.seed))
        }
        icons.remove(project.id)
      } else {
        if (project.icon) apply(await ipc.projects.clearIcon(project.id))
        icons.remove(project.id)
      }
      onClose()
    } catch (e) {
      setError(typeof e === 'string' ? e : e instanceof Error ? e.message : 'Could not save the icon.')
      setSaving(false)
    }
  }

  const customColor = !PROJECT_COLORS.includes(draft.color)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'var(--backdrop)' }}
      onClick={onClose}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={`Colour and icon for ${project.name}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
        className="w-[380px] rounded-xl border border-border bg-overlay p-5 shadow-xl outline-none"
      >
        <div className="mb-4 text-sm font-semibold text-foreground">Colour and icon</div>
        <div className="flex items-center gap-4">
          <ProjectTileView look={{ name: project.name, ...draft }} size={64} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">{project.name}</div>
            <div className="mt-0.5 text-xs text-muted">
              {draft.icon?.kind === 'image'
                ? 'Uploaded image'
                : draft.icon?.kind === 'navii'
                  ? 'Generated face'
                  : 'Colour and first letter'}
            </div>
          </div>
        </div>

        <div className="mt-5 text-xs font-medium text-foreground/80">Colour</div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {PROJECT_COLORS.map((c, i) => (
            <button
              key={c}
              type="button"
              title={PROJECT_COLOR_NAMES[i]}
              aria-label={PROJECT_COLOR_NAMES[i]}
              aria-pressed={draft.color === c}
              onClick={() => setDraft((d) => ({ ...d, color: c }))}
              className={`h-6 w-6 rounded-md outline-none ring-offset-2 ring-offset-overlay focus-visible:ring-2 focus-visible:ring-focus ${
                draft.color === c ? 'ring-2 ring-foreground/80' : ''
              }`}
              style={{ background: c }}
            />
          ))}
          <label
            className={`relative flex h-6 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 text-xs text-foreground/80 ring-offset-2 ring-offset-overlay focus-within:ring-2 focus-within:ring-focus hover:bg-foreground/5 ${
              customColor ? 'ring-2 ring-foreground/80' : ''
            }`}
          >
            {customColor && <span className="h-3 w-3 rounded-sm" style={{ background: draft.color }} />}
            Custom
            <input
              id="project-icon-custom-color"
              type="color"
              value={draft.color}
              onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </label>
        </div>

        <div className="mt-5 text-xs font-medium text-foreground/80">Icon</div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:bg-foreground/5"
          >
            Upload image
          </button>
          <button
            type="button"
            onClick={() => {
              setError(null)
              setDraft((d) => ({ ...d, icon: { kind: 'navii', seed: newSeed() }, imageBytes: null }))
            }}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:bg-foreground/5"
          >
            {draft.icon?.kind === 'navii' ? 'Another face' : 'Random face'}
          </button>
          <button
            type="button"
            disabled={!draft.icon}
            onClick={() => {
              setError(null)
              setDraft((d) => ({ ...d, icon: null, imageBytes: null }))
            }}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:bg-foreground/5 disabled:opacity-40"
          >
            Remove icon
          </button>
          <input
            id="project-icon-file"
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              void onPick(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </div>
        <div className="mt-2 min-h-4 text-xs text-danger" role="alert">
          {error}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-foreground/80 hover:bg-foreground/10"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-60"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
