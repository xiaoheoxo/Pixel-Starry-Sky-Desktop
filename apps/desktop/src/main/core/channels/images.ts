// 生成的图放进频道（docs/ui/channel-image-gen.md）：按频道附件的上限（张数、单张、合计）挑出放得下的，
// 大的交给 fit（主进程的 fitImage：补宽高、转 JPEG）。纯逻辑，不依赖 electron
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_COUNT,
  MAX_IMAGE_TOTAL,
  validateImages,
  type ImageAttachment,
} from '@pixelsky/protocol'

/** 主进程给的整理函数：补宽高，超过 max 时转小；做不到返回 null */
export type FitImage = (image: ImageAttachment, max: number) => ImageAttachment | null

/** 按顺序放，放不下的、宽高不知道的（频道附件要有宽高）算进 dropped */
export function fitForChannel(list: ImageAttachment[], fit?: FitImage): { images: ImageAttachment[]; dropped: number } {
  const images: ImageAttachment[] = []
  let total = 0,
    dropped = 0
  for (const image of list) {
    const room = Math.min(MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL - total)
    const fitted =
      images.length >= MAX_IMAGE_COUNT || room <= 0 ? null : fit ? fit(image, room) : image.bytes <= room ? image : null
    if (!fitted || fitted.width <= 0 || fitted.height <= 0 || fitted.bytes > room) {
      dropped++
      continue
    }
    images.push(fitted)
    total += fitted.bytes
  }
  try {
    return { images: validateImages(images), dropped }
  } catch {
    // fit 给的图不合格（不该发生）：都不放，不挡消息
    return { images: [], dropped: list.length }
  }
}
