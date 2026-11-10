// Codex 的请求超过网关上限时删旧图（docs/ui/pixel-request-size.md P2）：历史里的截图每轮原样 base64 重发，
// Codex 只按 token 判断压缩，字节先超；收到上下文超限后它也不一定能缩回来，会话就一直卡住。
// 从最早的图片开始换成一行文字，直到请求放得下。纯函数，改的是传进来的对象

const PLACEHOLDER = '[An earlier image was omitted to keep the request under the size limit]'

interface ImagePart {
  type: 'input_image'
  image_url: string
}

const isImage = (v: unknown): v is ImagePart =>
  !!v &&
  typeof v === 'object' &&
  (v as { type?: unknown }).type === 'input_image' &&
  typeof (v as { image_url?: unknown }).image_url === 'string'

/** 按出现顺序找出所有带内嵌数据的图片（消息内容、工具输出里的都算），记下所在的数组和位置 */
function collect(value: unknown, out: { list: unknown[]; index: number; bytes: number }[]): void {
  if (!Array.isArray(value)) {
    if (value && typeof value === 'object') for (const v of Object.values(value)) collect(v, out)
    return
  }
  value.forEach((item, index) => {
    if (isImage(item) && item.image_url.startsWith('data:'))
      out.push({ list: value, index, bytes: Buffer.byteLength(item.image_url) })
    else collect(item, out)
  })
}

/**
 * 把 body.input 里最早的图片换成文字，直到 JSON 不超过 limit 字节。
 * 返回换掉了几张；全部换掉还放不下返回 null（调用方照旧回上下文超限）
 */
export function trimOldImages(body: { input?: unknown }, size: number, limit: number): number | null {
  const images: { list: unknown[]; index: number; bytes: number }[] = []
  collect(body.input, images)
  const text = Buffer.byteLength(JSON.stringify({ type: 'input_text', text: PLACEHOLDER }))
  let left = size,
    dropped = 0
  for (const img of images) {
    if (left <= limit) break
    img.list[img.index] = { type: 'input_text', text: PLACEHOLDER }
    left -= img.bytes - text
    dropped++
  }
  return left <= limit ? dropped : null
}
