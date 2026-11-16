// 云端生图（docs/ui/image-gen.md §6）：桌面主进程直接调云端 /v1/platform/images/*，不经过 AI 引擎。
// 请求带 stream: true（SSE 推中间预览和成图，不会因为整张图生成完才回响应头而被 CDN 断开）；
// 生成的图作为一条工具条目（name: 'cloudImage'）放进对话，界面和 Codex 生图同一种画法。纯逻辑，不依赖 electron
import { MAX_IMAGE_BYTES, imageMediaType, type ImageAttachment, type Item } from '@pixelsky/protocol'
import {
  CLOUD_IMAGE_COUNTS,
  CLOUD_IMAGE_QUALITIES,
  CLOUD_IMAGE_SIZES,
  formatUsd,
  type CloudImageCount,
  type CloudImageQuality,
  type CloudImageSize,
} from '../../../shared/cloudImage'

export { estimateCost, imageTier } from '../../../shared/cloudImage'

export interface CloudImageRequest {
  /** 放进哪个会话；频道里生图（docs/ui/channel-image-gen.md §3.1）是空串 */
  sessionId: string
  groupId: string
  /** 分组名，写在卡片上 */
  groupName: string
  prompt: string
  size: CloudImageSize
  n: CloudImageCount
  quality: CloudImageQuality
  /** 有参考图时走改图（/edits），一次一张 */
  references: ImageAttachment[]
}

const MAX_PROMPT = 32 * 1024
const MAX_REFERENCES = 4
/** 所有参考图加起来（云端请求体上限 32 MB，base64 会大 1/3） */
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024

/** IPC 进来的参数校验；不对就抛。channel：频道里生图，不要会话 id */
export function cloudImageArgs(value: unknown, target: 'session' | 'channel' = 'session'): CloudImageRequest {
  if (!value || typeof value !== 'object') throw new Error('生图参数不对')
  const v = value as Record<string, unknown>
  const text = (key: string, max: number): string => {
    const s = v[key]
    if (typeof s !== 'string' || !s.trim() || s.length > max) throw new Error(`生图参数不对：${key}`)
    return s
  }
  const prompt = text('prompt', MAX_PROMPT).trim()
  const size = v.size as CloudImageSize
  if (!CLOUD_IMAGE_SIZES.includes(size)) throw new Error('不支持这个尺寸')
  const n = v.n as CloudImageRequest['n']
  if (!CLOUD_IMAGE_COUNTS.includes(n)) throw new Error('一次生成 1、2 或 4 张')
  const quality = v.quality as CloudImageQuality
  if (!CLOUD_IMAGE_QUALITIES.includes(quality)) throw new Error('质量选项不对')
  const groupId = text('groupId', 32)
  if (!/^\d+$/.test(groupId)) throw new Error('生图参数不对：groupId')
  const refs = Array.isArray(v.references) ? (v.references as ImageAttachment[]) : []
  if (refs.length > MAX_REFERENCES) throw new Error(`参考图最多 ${MAX_REFERENCES} 张`)
  let bytes = 0
  for (const r of refs) {
    if (!r || typeof r.dataBase64 !== 'string' || !r.dataBase64 || typeof r.mediaType !== 'string')
      throw new Error('参考图读不出来')
    bytes += (r.dataBase64.length / 4) * 3
  }
  if (bytes > MAX_REFERENCE_BYTES) throw new Error('参考图加起来不能超过 20 MB')
  if (refs.length && n !== 1) throw new Error('按参考图改图一次一张')
  return {
    sessionId: target === 'session' ? text('sessionId', 200) : '',
    groupId,
    groupName: typeof v.groupName === 'string' ? v.groupName.slice(0, 100) : '',
    prompt,
    size,
    n,
    quality,
    references: refs,
  }
}

/** 云端的请求：路径和 JSON 体（OpenAI 兼容；参考图用 data URL 放在 images[] 里） */
export function cloudImageBody(req: CloudImageRequest): { path: string; body: string } {
  const edit = req.references.length > 0
  const body: Record<string, unknown> = {
    prompt: req.prompt,
    n: req.n,
    size: req.size,
    quality: req.quality,
    stream: true,
    // 中间预览一张：连接上一直有数据，界面也能先看到大概的样子
    partial_images: 1,
  }
  if (edit) body.images = req.references.map(r => ({ image_url: `data:${r.mediaType};base64,${r.dataBase64}` }))
  return { path: edit ? '/v1/platform/images/edits' : '/v1/platform/images/generations', body: JSON.stringify(body) }
}

/** 有整理函数（fit）时先收下的单张上限：4K PNG 可能超过 MAX_IMAGE_BYTES，由 fit 转小 */
const RAW_IMAGE_BYTES = 64 * 1024 * 1024

/** base64 → 图片附件；认不出格式、超过上限返回 null */
export function imageFromBase64(b64: string, id: string, name: string, max = MAX_IMAGE_BYTES): ImageAttachment | null {
  const clean = b64.replace(/^data:[^,]*,/, '')
  if (!clean || (clean.length / 4) * 3 > max) return null
  const data = Buffer.from(clean, 'base64')
  const mediaType = data.length ? imageMediaType(data) : null
  if (!mediaType) return null
  const ext = mediaType.slice(6).replace('jpeg', 'jpg')
  return {
    id,
    name: `${name}.${ext}`,
    mediaType,
    bytes: data.length,
    width: 0,
    height: 0,
    dataBase64: data.toString('base64'),
  }
}

export type CloudImageEvent =
  | { kind: 'partial'; b64: string }
  | { kind: 'image'; b64: string }
  | { kind: 'error'; message: string }

/** 一段 SSE 事件 → 生图事件；不认识的返回 null */
export function parseImageEvent(block: string): CloudImageEvent | null {
  const data = block
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
  if (!data || data === '[DONE]') return null
  let value: Record<string, unknown>
  try {
    value = JSON.parse(data) as Record<string, unknown>
  } catch {
    return null
  }
  const type = typeof value.type === 'string' ? value.type : ''
  const b64 = typeof value.b64_json === 'string' ? value.b64_json : ''
  if (/\.partial_image$/.test(type) && b64) return { kind: 'partial', b64 }
  if (/\.completed$/.test(type) && b64) return { kind: 'image', b64 }
  const error = value.error as { message?: unknown } | string | undefined
  if (type === 'error' || error)
    return {
      kind: 'error',
      message:
        (typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '') || '生图失败',
    }
  return null
}

/** 把响应体按 SSE 事件切开（\n\n 或 \r\n\r\n 分隔），一边收一边交出去 */
export async function* sseBlocks(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    for (let at = buf.search(/\r?\n\r?\n/); at >= 0; at = buf.search(/\r?\n\r?\n/)) {
      const block = buf.slice(0, at)
      buf = buf.slice(buf.slice(at).match(/^\r?\n\r?\n/)![0].length + at)
      if (block.trim()) yield block
    }
  }
  buf += decoder.decode()
  if (buf.trim()) yield buf
}

/** 错误响应里的说明（云端是 {error:{message}} 或 {error:"…"}） */
export async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const v = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
    const m = typeof v.error === 'string' ? v.error : (v.error?.message ?? v.message)
    if (m) return m
  } catch {
    /* 不是 JSON */
  }
  return text.trim().slice(0, 300) || `云端返回 ${res.status}`
}

/** 卡片上的一行说明：分组 · 尺寸 · 张数（· 扣费） */
export function cloudImageMeta(req: CloudImageRequest, cost?: number | null): string {
  const parts = [req.groupName || `分组 ${req.groupId}`, req.size, `${req.n} 张`]
  if (req.references.length) parts.push('按参考图改')
  if (cost != null) parts.push(`扣 ${formatUsd(cost)}`)
  return parts.join(' · ')
}

/** 对话里的条目 */
export function cloudImageItem(
  id: string,
  req: CloudImageRequest,
  state: { status: 'running' | 'completed' | 'failed' | 'interrupted'; images: ImageAttachment[]; output: string },
): Extract<Item, { kind: 'tool' }> {
  return {
    kind: 'tool',
    id,
    tool: 'other',
    name: 'cloudImage',
    title: req.prompt,
    output: state.output,
    status: state.status,
    ...(state.images.length ? { images: state.images } : {}),
  }
}

export interface CloudImageDeps {
  fetch: (path: string, init: RequestInit) => Promise<Response>
  /** 条目有变化（开始、预览、完成、失败）时调用 */
  put: (item: Item) => void
  signal: AbortSignal
  /**
   * 收到的图整理一下（主进程的 fitImage：补宽高、超过 MAX_IMAGE_BYTES 转 JPEG）；返回 null 的丢掉。
   * 没给时超过 MAX_IMAGE_BYTES 的直接丢掉（测试）
   */
  fit?: (image: ImageAttachment) => ImageAttachment | null
}

/**
 * 生成一次：先放一条运行中的条目，收到预览就换上预览，全部收到后放完成的；出错放失败的（停止是中断）。
 * 返回 Sub2api 给的请求 id（查实扣用，云端回传的 X-Client-Request-ID）和成图
 */
export async function runCloudImage(
  itemId: string,
  requestId: string,
  req: CloudImageRequest,
  deps: CloudImageDeps,
): Promise<{ chargeId: string | null; images: ImageAttachment[] }> {
  const meta = cloudImageMeta(req)
  const images: ImageAttachment[] = []
  let preview: ImageAttachment | null = null
  const put = (status: 'running' | 'completed' | 'failed' | 'interrupted', output = meta): void =>
    deps.put(cloudImageItem(itemId, req, { status, images: images.length ? images : preview ? [preview] : [], output }))
  put('running')
  const decode = (b64: string): ImageAttachment | null => {
    const n = images.length
    const image = imageFromBase64(
      b64,
      `${itemId}-img${n}`,
      `image-${n + 1}`,
      deps.fit ? RAW_IMAGE_BYTES : MAX_IMAGE_BYTES,
    )
    return image && deps.fit ? deps.fit(image) : image
  }
  const { path, body } = cloudImageBody(req)
  try {
    const res = await deps.fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-PixelSky-Group': req.groupId,
        'X-Client-Request-ID': requestId,
      },
      body,
      signal: deps.signal,
    })
    if (!res.ok) throw new Error(await errorMessage(res))
    const chargeId = res.headers.get('X-Client-Request-ID')
    const type = res.headers.get('Content-Type') ?? ''
    if (!res.body) throw new Error('云端没有返回内容')
    if (type.includes('text/event-stream')) {
      for await (const block of sseBlocks(res.body)) {
        const event = parseImageEvent(block)
        if (!event) continue
        if (event.kind === 'error') throw new Error(event.message)
        const image = decode(event.b64)
        if (!image) continue
        if (event.kind === 'partial') {
          if (!images.length) {
            preview = image
            put('running')
          }
        } else {
          // 不是每张都更新：条目每更新一次就把全部图片再写进会话文件一遍（只追加），收齐了再放完成的
          images.push(image)
        }
      }
    } else {
      // 旧的一次性 JSON（{data:[{b64_json}]}）
      const json = (await res.json()) as { data?: { b64_json?: string }[] }
      for (const d of json.data ?? []) {
        const image = d.b64_json && decode(d.b64_json)
        if (image) images.push(image)
      }
    }
    if (!images.length) throw new Error('云端没有返回图片')
    put('completed')
    return { chargeId, images }
  } catch (error) {
    if (deps.signal.aborted) {
      put('interrupted', `${meta} · 已停止（已经开始生成的可能照常扣费）`)
    } else {
      put('failed', `${meta} · ${(error as Error).message}`)
    }
    throw error
  }
}
