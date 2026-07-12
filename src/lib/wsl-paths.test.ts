import { describe, expect, it } from 'vitest'
import { distroOfUncPath } from './wsl-paths'

describe('distroOfUncPath', () => {
  it('extracts the distro from wsl$ and wsl.localhost paths', () => {
    expect(distroOfUncPath('\\\\wsl$\\Ubuntu\\home\\u\\proj')).toBe('Ubuntu')
    expect(distroOfUncPath('\\\\wsl.localhost\\Debian\\srv')).toBe('Debian')
  })
  it('returns null for non-WSL paths', () => {
    expect(distroOfUncPath('C:\\Users\\u\\proj')).toBeNull()
    expect(distroOfUncPath('\\\\server\\share')).toBeNull()
    expect(distroOfUncPath('/home/u/proj')).toBeNull()
  })
})
