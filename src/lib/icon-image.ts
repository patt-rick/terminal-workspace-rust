// Turning a picked image file into a project icon: a 128 px square PNG.

export const ICON_SIZE = 128
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024
export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp']

/** The message to show for a file that cannot be used, or null if it can. */
export function checkUpload(file: { size: number; type: string }): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) return 'Choose a PNG, JPEG or WebP image.'
  if (file.size > MAX_SOURCE_BYTES) return 'That image is larger than 10 MB.'
  return null
}

/** The largest centred square of a `width` × `height` image. */
export function cropSquare(width: number, height: number): { sx: number; sy: number; size: number } {
  const size = Math.min(width, height)
  return { sx: Math.floor((width - size) / 2), sy: Math.floor((height - size) / 2), size }
}

const UNREADABLE = 'This image could not be read.'

/** Decode, centre-crop and scale to a 128 px PNG. Throws with a message to show. */
export async function toIconPng(file: Blob): Promise<Uint8Array> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error(UNREADABLE)
  }
  try {
    const canvas = document.createElement('canvas')
    canvas.width = ICON_SIZE
    canvas.height = ICON_SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx || bitmap.width === 0 || bitmap.height === 0) throw new Error(UNREADABLE)
    const { sx, sy, size } = cropSquare(bitmap.width, bitmap.height)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, sx, sy, size, size, 0, 0, ICON_SIZE, ICON_SIZE)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error(UNREADABLE)
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    bitmap.close()
  }
}

/** A `data:` URL for PNG bytes. Not a `blob:` URL: it is kept after the dialog closes. */
export function pngDataUrl(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `data:image/png;base64,${btoa(binary)}`
}
