import type { ProjectIcon } from '../../lib/ipc'
import { faceDataUrl } from '../../lib/navii'
import { readableOn, tileLetter } from '../../lib/project-tile'
import { useProjectIcons } from '../../state/project-icons'

/** How a tile is drawn; the icon dialog passes its unsaved draft through this. */
export interface TileLook {
  name: string
  color: string
  icon?: ProjectIcon | null
  /** the uploaded picture, when `icon.kind` is 'image' */
  imageUrl?: string | null
}

/**
 * A project's square: its uploaded picture, or its generated face on its
 * colour, or its colour with the first letter of its name.
 */
export function ProjectTileView({ look, size }: { look: TileLook; size: number }) {
  const radius = Math.round(size * 0.28)
  const face = look.icon?.kind === 'navii' ? faceDataUrl(look.icon.seed, size * 2) : null
  const picture = look.icon?.kind === 'image' ? (look.imageUrl ?? null) : null

  return (
    <span
      className="relative flex flex-shrink-0 select-none items-center justify-center overflow-hidden font-semibold"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: look.color,
        color: readableOn(look.color),
        fontSize: Math.round(size * 0.46),
        lineHeight: 1,
      }}
    >
      {picture ? (
        <img src={picture} alt="" draggable={false} className="h-full w-full object-cover" />
      ) : face ? (
        <img src={face} alt="" draggable={false} className="h-full w-full" />
      ) : (
        tileLetter(look.name)
      )}
    </span>
  )
}

export function ProjectTile({
  project,
  size,
}: {
  project: { id: string; name: string; color: string; icon?: ProjectIcon | null }
  size: number
}) {
  const imageUrl = useProjectIcons((s) => s.urls[project.id] ?? null)
  return <ProjectTileView look={{ ...project, imageUrl }} size={size} />
}
