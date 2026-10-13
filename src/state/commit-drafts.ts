import { create } from 'zustand'

interface CommitDraftsState {
  /** unsent commit messages by repo id */
  drafts: Record<string, string>
  setDraft: (repoId: string, message: string) => void
}

/**
 * Held outside the Git panel because the panel unmounts when the right sidebar
 * is hidden, which would throw a half-written message away.
 */
export const useCommitDrafts = create<CommitDraftsState>((set) => ({
  drafts: {},
  setDraft: (repoId, message) => set((s) => ({ drafts: { ...s.drafts, [repoId]: message } })),
}))
