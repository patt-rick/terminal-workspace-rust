// Turning a picked photo into an upload: scaled down, re-encoded, base64.
import { fitWithin, hasTransparency, IMAGE_MAX_SIDE, MAX_IMAGE_BYTES } from './chat-model'

export interface PreparedImage {
  id: string
  mime: 'image/png' | 'image/jpeg'
  /** base64 of the encoded image, no data: prefix */
  data: string
  /** object URL for the thumbnail; revoke when the image is dropped */
  thumb: string
}

const JPEG_QUALITY = 0.85

/** A failure whose message is shown to the user as is. */
class ImageProblem extends Error {}

async function decode(file: Blob): Promise<{ source: CanvasImageSource; w: number; h: number; close: () => void }> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
    return { source: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() }
  } catch {
    // Older WebKit: fall back to an <img>, which applies EXIF orientation itself.
    const url = URL.createObjectURL(file)
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      return { source: img, w: img.naturalWidth, h: img.naturalHeight, close: () => {} }
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}

function toBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), mime, quality)
  )
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result)
      resolve(s.slice(s.indexOf(',') + 1))
    }
    r.onerror = () => reject(r.error ?? new Error('read failed'))
    r.readAsDataURL(blob)
  })
}

/** Scale `file` to at most IMAGE_MAX_SIDE on its long side and re-encode it:
 *  PNG when it has transparency, else JPEG. Throws a user-facing message. */
export async function prepareImage(file: File): Promise<PreparedImage> {
  const name = file.name || 'That image'
  if (!file.type.startsWith('image/')) throw new ImageProblem(`${file.name || 'That file'} isn't an image.`)
  let img: Awaited<ReturnType<typeof decode>>
  try {
    img = await decode(file)
  } catch {
    throw new ImageProblem(`${name} couldn't be read.`)
  }
  try {
    let side = IMAGE_MAX_SIDE
    for (let attempt = 0; attempt < 4; attempt++) {
      const { w, h } = fitWithin(img.w, img.h, side)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('No canvas')
      ctx.drawImage(img.source, 0, 0, w, h)
      const alpha = file.type !== 'image/jpeg' && hasTransparency(ctx.getImageData(0, 0, w, h).data)
      const mime = alpha ? 'image/png' : 'image/jpeg'
      const blob = await toBlob(canvas, mime, alpha ? undefined : JPEG_QUALITY)
      // Only a PNG with transparency can come out this big; shrink it until it fits.
      if (blob.size > MAX_IMAGE_BYTES) {
        side = Math.round(side * 0.7)
        continue
      }
      return {
        id: Math.random().toString(36).slice(2),
        mime,
        data: await toBase64(blob),
        thumb: URL.createObjectURL(blob),
      }
    }
    throw new ImageProblem(`${name} is too large to send.`)
  } catch (e) {
    throw e instanceof ImageProblem ? e : new ImageProblem(`${name} couldn't be prepared.`)
  } finally {
    img.close()
  }
}
