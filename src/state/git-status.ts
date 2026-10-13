import { create } from 'zustand'
import { ipc, type GitInfo } from '../lib/ipc'

interface GitStatusState {
  /** undefined = never loaded; null = the load failed */
  infoByRepo: Record<string, GitInfo | null | undefined>
  /**
   * Reloads a repo's branch and change count. One request per repo runs at a
   * time. A call made while one is running waits for a fresh request started
   * after it, so a caller that has just staged or committed never gets an
   * answer from before its change.
   */
  refresh: (repoId: string) => Promise<GitInfo | null>
}

const running = new Map<string, Promise<GitInfo | null>>()
const queued = new Map<string, Promise<GitInfo | null>>()

export const useGitStatus = create<GitStatusState>((set) => {
  const load = (repoId: string): Promise<GitInfo | null> => {
    const request = ipc.git
      .info(repoId)
      .catch(() => null)
      .then((info) => {
        set((s) => ({ infoByRepo: { ...s.infoByRepo, [repoId]: info } }))
        return info
      })
      .finally(() => {
        if (running.get(repoId) === request) running.delete(repoId)
      })
    running.set(repoId, request)
    return request
  }

  return {
    infoByRepo: {},
    refresh: (repoId) => {
      const current = running.get(repoId)
      if (!current) return load(repoId)
      const waiting = queued.get(repoId)
      if (waiting) return waiting
      const next = current.then(() => {
        queued.delete(repoId)
        return load(repoId)
      })
      queued.set(repoId, next)
      return next
    },
  }
})
