// 生成的图放进会话、频道前整理一下（docs/ui/channel-image-gen.md §3.1）：补上宽高（生成时不知道，频道附件要求有），
// 超过大小上限的转成 JPEG。用 Electron 的 nativeImage，所以放在主进程这层，core/ 经参数拿到
import { nativeImage } from 'electron'
import { MAX_IMAGE_BYTES, type ImageAttachment } from '@pixelsky/protocol'

/** 依次试的 JPEG 质量 */
const QUALITIES = [90, 80, 70]

/**
 * 补上宽高；超过 max 时转 JPEG，还超就 null。nativeImage 只解得开 PNG、JPEG：
 * 解不开的（WebP、GIF）没超时原样返回（宽高可能还是 0，频道那边按宽高再筛），超了 null
 */
export function fitImage(image: ImageAttachment, max = MAX_IMAGE_BYTES): ImageAttachment | null {
  const decoded = nativeImage.createFromBuffer(Buffer.from(image.dataBase64, 'base64'))
  if (decoded.isEmpty()) return image.bytes <= max ? image : null
  const { width, height } = decoded.getSize()
  if (image.bytes <= max) return { ...image, width, height }
  for (const quality of QUALITIES) {
    const jpeg = decoded.toJPEG(quality)
    if (jpeg.length <= max)
      return {
        ...image,
        name: image.name.replace(/\.[A-Za-z0-9]+$/, '') + '.jpg',
        mediaType: 'image/jpeg',
        bytes: jpeg.length,
        width,
        height,
        dataBase64: jpeg.toString('base64'),
      }
  }
  return null
}
