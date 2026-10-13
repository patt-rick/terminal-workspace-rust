// Pure helpers for the Git tab's staging lists. No ipc calls, so they run in
// plain vitest.

import type { FileDiff } from './ipc'

/** The paths to hand to git for one listed file. */
export function pathsOf(file: Pick<FileDiff, 'path' | 'oldPath'>): string[] {
  return file.oldPath && file.oldPath !== file.path ? [file.path, file.oldPath] : [file.path]
}

export function canCommit(message: string, stagedCount: number, busy: boolean): boolean {
  return !busy && stagedCount > 0 && message.trim().length > 0
}

/**
 * Whether a successful command's output still needs showing. Most of it is
 * noise (line-ending notices on every add), but this one changes what was
 * staged: a nested repository goes in as a link, not as its files.
 */
export function isNotableSuccess(output: string): boolean {
  return output.includes('adding embedded git repository')
}

export type CommitButtons = 'commit-and-push' | 'push' | 'separate' | 'commit'

/**
 * Which buttons the Git tab shows. Commit and Push are one button whenever
 * every change is either staged or already committed, because then "commit"
 * and "push" are one intention. They split only while some changes are left
 * unstaged, when the user may want to commit part and hold the push.
 *
 * `pushPending` is whether there is already something to push (commits ahead,
 * or a branch not published yet); without it a lone Push button would do
 * nothing. `holdPush` keeps the two apart when the push needs a second look,
 * such as going out as the wrong account.
 */
export function commitButtons(
  stagedCount: number,
  unstagedCount: number,
  canPush: boolean,
  pushPending: boolean,
  holdPush = false
): CommitButtons {
  if (!canPush) return 'commit'
  if (unstagedCount > 0 || (holdPush && stagedCount > 0)) return pushPending ? 'separate' : 'commit'
  if (stagedCount > 0) return 'commit-and-push'
  return pushPending ? 'push' : 'commit'
}
