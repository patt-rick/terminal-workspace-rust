import { describe, expect, it } from 'vitest'
import { MAX_SOURCE_BYTES, checkUpload, cropSquare, pngDataUrl } from './icon-image'

describe('checkUpload', () => {
  it('accepts PNG, JPEG and WebP', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(checkUpload({ size: 1000, type })).toBeNull()
    }
  })

  it('rejects other types, including SVG', () => {
    expect(checkUpload({ size: 1000, type: 'image/svg+xml' })).toMatch(/PNG, JPEG or WebP/)
    expect(checkUpload({ size: 1000, type: 'image/gif' })).toMatch(/PNG, JPEG or WebP/)
    expect(checkUpload({ size: 1000, type: '' })).toMatch(/PNG, JPEG or WebP/)
  })

  it('allows exactly 10 MB and rejects one byte more', () => {
    expect(checkUpload({ size: MAX_SOURCE_BYTES, type: 'image/png' })).toBeNull()
    expect(checkUpload({ size: MAX_SOURCE_BYTES + 1, type: 'image/png' })).toMatch(/10 MB/)
  })
})

describe('cropSquare', () => {
  it('centres the square in a wide image', () => {
    expect(cropSquare(400, 200)).toEqual({ sx: 100, sy: 0, size: 200 })
  })

  it('centres the square in a tall image', () => {
    expect(cropSquare(200, 400)).toEqual({ sx: 0, sy: 100, size: 200 })
  })

  it('keeps a square image whole', () => {
    expect(cropSquare(128, 128)).toEqual({ sx: 0, sy: 0, size: 128 })
  })

  it('rounds an odd margin down', () => {
    expect(cropSquare(201, 100)).toEqual({ sx: 50, sy: 0, size: 100 })
  })
})

describe('pngDataUrl', () => {
  it('base64-encodes the bytes', () => {
    expect(pngDataUrl(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('data:image/png;base64,iVBORw==')
  })

  it('handles more bytes than one call-stack chunk', () => {
    const url = pngDataUrl(new Uint8Array(100_000).fill(65))
    expect(atob(url.slice('data:image/png;base64,'.length))).toHaveLength(100_000)
  })
})
