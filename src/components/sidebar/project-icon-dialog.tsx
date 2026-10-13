import { useEffect, useRef, useState } from 'react'
import { ipc, type Project, type ProjectIcon } from '../../lib/ipc'
import { checkUpload, pngDataUrl, toIconPng } from '../../lib/icon-image'
import { newSeed } from '../../lib/navii'
import { readableOn } from '../../lib/project-tile'
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
          <ProjectTileView look={{ name: project.name, ...draft }} size={72} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">{project.name}</div>
            <div className="mt-0.5 text-xs text-muted">
              {draft.icon?.kind === 'image'
                ? 'Uploaded image'
                : draft.icon?.kind === 'navii'
                  ? 'Generated face'
                  : 'Colour and first letter'}
            </div>
            <div className="mt-2.5 flex gap-1.5">
              <IconButton label="Upload an image" onClick={() => fileInput.current?.click()}>
                <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
              </IconButton>
              <IconButton
                label={draft.icon?.kind === 'navii' ? 'Roll another face' : 'Random face'}
                onClick={() => {
                  setError(null)
                  setDraft((d) => ({ ...d, icon: { kind: 'navii', seed: newSeed() }, imageBytes: null }))
                }}
              >
                <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
                <circle cx="8.5" cy="8.5" r="1.1" fill="currentColor" stroke="none" />
                <circle cx="15.5" cy="8.5" r="1.1" fill="currentColor" stroke="none" />
                <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
                <circle cx="8.5" cy="15.5" r="1.1" fill="currentColor" stroke="none" />
                <circle cx="15.5" cy="15.5" r="1.1" fill="currentColor" stroke="none" />
              </IconButton>
              <IconButton
                label={draft.icon ? 'Remove the icon' : 'No icon to remove'}
                disabled={!draft.icon}
                onClick={() => {
                  setError(null)
                  setDraft((d) => ({ ...d, icon: null, imageBytes: null }))
                }}
              >
                <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5" />
              </IconButton>
            </div>
          </div>
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

        <div className="mt-5 text-xs font-medium text-foreground/80">Colour</div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
          {PROJECT_COLORS.map((c, i) => (
            <button
              key={c}
              type="button"
              aria-label={PROJECT_COLOR_NAMES[i]}
              aria-pressed={draft.color === c}
              onClick={() => setDraft((d) => ({ ...d, color: c }))}
              className={`group relative flex h-7 w-7 items-center justify-center rounded-full outline-none ring-offset-2 ring-offset-overlay transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-focus ${
                draft.color === c ? 'ring-2 ring-foreground/80' : ''
              }`}
              style={{ background: c }}
            >
              {draft.color === c && <Check color={readableOn(c)} />}
              <Tip>{PROJECT_COLOR_NAMES[i]}</Tip>
            </button>
          ))}
          <label
            className={`group relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-dashed border-foreground/40 text-foreground/70 ring-offset-2 ring-offset-overlay transition-transform focus-within:ring-2 focus-within:ring-focus hover:scale-110 hover:text-foreground ${
              customColor ? 'border-transparent ring-2 ring-foreground/80' : ''
            }`}
            style={customColor ? { background: draft.color } : undefined}
          >
            {customColor ? (
              <Check color={readableOn(draft.color)} />
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            )}
            <input
              id="project-icon-custom-color"
              type="color"
              aria-label="Custom colour"
              value={draft.color}
              onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
            <Tip>{customColor ? `Custom colour ${draft.color}` : 'Pick a custom colour'}</Tip>
          </label>
        </div>
        <div className="mt-2 min-h-4 text-xs text-danger" role="alert">
          {error}
        </div>

        <div className="-mx-5 -mb-5 mt-4 flex justify-end gap-2 rounded-b-xl border-t border-border bg-foreground/5 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 items-center rounded-lg border border-border px-3.5 text-[13px] text-foreground/85 outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-accent pl-3 pr-3.5 text-[13px] font-semibold text-accent-foreground shadow-sm outline-none ring-offset-2 ring-offset-overlay hover:brightness-110 focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="5 12.5 10 17.5 19 7" />
            </svg>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** A small label under a control, shown on hover and on keyboard focus. */
function Tip({ children }: { children: React.ReactNode }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute left-1/2 top-full z-10 mt-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-normal text-foreground opacity-0 shadow-lg transition-opacity delay-150 group-hover:opacity-100 group-focus-visible:opacity-100 group-focus-within:opacity-100"
    >
      {children}
    </span>
  )
}

function Check({ color }: { color: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="5 12.5 10 17.5 19 7" />
    </svg>
  )
}

/** `children` are the shapes of a 24px stroked icon. */
function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onClick()
      }}
      className={`group relative flex h-8 w-8 items-center justify-center rounded-lg border border-border outline-none focus-visible:ring-2 focus-visible:ring-focus ${
        disabled
          ? 'cursor-default text-foreground/25'
          : 'text-foreground/75 hover:bg-foreground/10 hover:text-foreground'
      }`}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
      <Tip>{label}</Tip>
    </button>
  )
}
