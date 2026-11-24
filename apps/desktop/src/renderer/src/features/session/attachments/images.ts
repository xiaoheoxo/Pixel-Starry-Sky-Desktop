import { imageMediaType, MAX_FILE_BYTES, MAX_IMAGE_BYTES, type ImageAttachment } from '@pixelsky/protocol'
import { tr } from '@/i18n/core'
import { convertImage, needsConversion, otherImageFormat } from './convertImage'

export async function readImage(file: File): Promise<ImageAttachment> {
  // BMP、ICO、AVIF 先转成 PNG（convertImage.ts）：原文件可以大一些（BMP 截图常有几十 MB），转出来的再按 10 MiB 算
  if (!file.size || file.size > (needsConversion(file) ? MAX_FILE_BYTES : MAX_IMAGE_BYTES))
    throw new Error(tr('composer.attachment.tooLarge'))
  let buffer = await file.arrayBuffer()
  let bytes = new Uint8Array(buffer),
    mediaType = imageMediaType(bytes)
  let size = file.size
  if (!mediaType) {
    const other = otherImageFormat(bytes)
    if (!other) throw new Error(tr('composer.attachment.invalidType'))
    const converted = await convertImage(file, other)
    buffer = await converted.blob.arrayBuffer()
    bytes = new Uint8Array(buffer)
    mediaType = converted.mediaType
    size = converted.blob.size
  }
  if (size > MAX_IMAGE_BYTES) throw new Error(tr('composer.attachment.tooLarge'))
  const blob = new Blob([buffer], { type: mediaType }),
    url = URL.createObjectURL(blob)
  try {
    const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
      image.onerror = () => reject(new Error(tr('composer.attachment.readError')))
      image.src = url
    })
    const dataBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1])
      reader.onerror = () => reject(new Error(tr('composer.attachment.readError')))
      reader.readAsDataURL(blob)
    })
    return {
      id: crypto.randomUUID(),
      name: file.name || 'image',
      mediaType,
      bytes: size,
      ...dimensions,
      dataBase64,
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}
/** 图片数据不是 base64（工具给的、记录坏了）时为 null */
export function imageBlob(image: ImageAttachment): Blob | null {
  let data: string
  try {
    data = atob(image.dataBase64)
  } catch {
    return null
  }
  return new Blob([Uint8Array.from(data, c => c.charCodeAt(0))], { type: image.mediaType })
}
export function imageSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MiB`
    : `${Math.max(1, Math.round(bytes / 1024))} KiB`
}
