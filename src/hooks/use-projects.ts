import { useEffect } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { ipc } from '../lib/ipc'
import { useWorkspace } from '../state/store'

export async function addProject(): Promise<void> {
  const picked = await open({ directory: true, multiple: false })
  if (!picked || typeof picked !== 'string') return
  const project = await ipc.projects.add(picked)
  const ws = useWorkspace.getState()
  ws.upsertProject(project)
  ws.selectProject(project.id)
}

/**
 * Loads the persisted project snapshot. Call it once, from the app root: the
 * snapshot's selection replaces the live one, so a component that mounts and
 * remounts (the nav list and rail swap on collapse) must not reload it.
 */
export function useLoadProjects(): void {
  const setProjects = useWorkspace((s) => s.setProjects)

  useEffect(() => {
    void ipc.projects
      .snapshot()
      .then((snap) => {
        setProjects(snap.projects, {
          selectedProjectId: snap.selectedProjectId,
          activeTerminalByProject: snap.activeTerminalByProject,
        })
      })
      .catch(() => {
        // backend unavailable (e.g. plain browser dev) — start empty
      })
  }, [setProjects])
}

export function useProjects() {
  const projects = useWorkspace((s) => s.projects)
  const selectedProjectId = useWorkspace((s) => s.selectedProjectId)

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null

  return { projects, selectedProject, addProject }
}
