import { describe, expect, it } from 'vitest'
import { canCommit, commitButtons, isNotableSuccess, pathsOf } from './git-changes'

describe('pathsOf', () => {
  it('is the file path for an ordinary change', () => {
    expect(pathsOf({ path: 'src/a.ts', oldPath: null })).toEqual(['src/a.ts'])
  })

  it('includes the old path of a rename, so both halves move together', () => {
    expect(pathsOf({ path: 'src/b.ts', oldPath: 'src/a.ts' })).toEqual(['src/b.ts', 'src/a.ts'])
  })
})

describe('canCommit', () => {
  it('needs something staged, a message and no operation in flight', () => {
    expect(canCommit('fix', 1, false)).toBe(true)
    expect(canCommit('fix', 0, false)).toBe(false)
    expect(canCommit('   \n', 1, false)).toBe(false)
    expect(canCommit('fix', 1, true)).toBe(false)
  })
})

describe('isNotableSuccess', () => {
  it('flags a nested repository being added as a link', () => {
    expect(isNotableSuccess('warning: adding embedded git repository: nested')).toBe(true)
  })

  it('ignores routine output', () => {
    expect(isNotableSuccess('warning: LF will be replaced by CRLF in a.txt')).toBe(false)
    expect(isNotableSuccess('')).toBe(false)
  })
})

describe('commitButtons', () => {
  it('is one commit-and-push button when everything is staged', () => {
    expect(commitButtons(3, 0, true, true)).toBe('commit-and-push')
    expect(commitButtons(3, 0, true, false)).toBe('commit-and-push')
  })

  it('is just push when everything is already committed', () => {
    expect(commitButtons(0, 0, true, true)).toBe('push')
  })

  it('offers no push when there is nothing to push', () => {
    expect(commitButtons(0, 0, true, false)).toBe('commit')
    expect(commitButtons(0, 4, true, false)).toBe('commit')
    expect(commitButtons(2, 1, true, false)).toBe('commit')
  })

  it('splits while some changes are left unstaged', () => {
    expect(commitButtons(2, 1, true, true)).toBe('separate')
    expect(commitButtons(0, 4, true, true)).toBe('separate')
  })

  it('is commit alone when there is nothing to push to', () => {
    expect(commitButtons(2, 0, false, false)).toBe('commit')
    expect(commitButtons(0, 0, false, false)).toBe('commit')
  })

  it('keeps commit and push apart when the push needs a second look', () => {
    expect(commitButtons(2, 0, true, true, true)).toBe('separate')
    expect(commitButtons(2, 0, true, false, true)).toBe('commit')
    expect(commitButtons(0, 0, true, true, true)).toBe('push')
  })
})
