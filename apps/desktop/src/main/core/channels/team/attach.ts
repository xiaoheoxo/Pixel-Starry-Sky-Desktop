// 团队频道的附件（docs/ui/channels-unify.md §9）：本机的图片 / 文件附件和云端存的那份互相转换。纯逻辑。
// 云端只存图片原样和文件转好的文字；截断的文件（开头 + 结尾）拼成一段，中间一行写省略了多少，取回来再拆开。
import type { FileAttachment, ImageAttachment } from '@pixelsky/protocol'
import type { ChannelAttachedMeta } from '../../../../shared/types/channels'
import type { AttachLimits, TeamAttachmentData, TeamAttachmentInput, TeamAttachmentMeta } from './api'

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
const ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'gb18030'] as const
/** 云端的名字上限（字符） */
const NAME_MAX = 200

// 写成别的文件里不会有的样子：完整的文件里恰好有一行「[... 5 lines omitted ...]」不能被当成截断过
const omittedLine = (n: number): string => `[... ${n} lines omitted by pixelsky-attachment ...]\n`
const OMITTED = /^\[\.\.\. (\d+) lines omitted by pixelsky-attachment \.\.\.\]\n/m

/** 名字太长时留着扩展名截短 */
export function clipName(name: string): string {
  const chars = [...name]
  if (chars.length <= NAME_MAX) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 16 ? [...name.slice(dot)] : []
  return [...chars.slice(0, NAME_MAX - ext.length), ...ext].join('')
}

/** 文件传给云端的文字：截断的把开头、省略说明、结尾拼在一起 */
export function fileUploadText(file: FileAttachment): string {
  if (file.tail === undefined) return file.text
  const head = file.text && !file.text.endsWith('\n') ? `${file.text}\n` : file.text
  return head + omittedLine(file.omitted ?? 0) + file.tail
}

/**
 * 核对能不能发到团队频道，转成上传的请求体（图片在前）。不合适的抛中文原因：
 * 只有路径的文件（云端和别人的电脑读不到）、超过张数 / 个数、单个太大。
 */
export function uploadsOf(
  images: ImageAttachment[],
  files: FileAttachment[],
  limits: AttachLimits,
): TeamAttachmentInput[] {
  if (images.length > limits.images) throw new Error(`团队频道里每条消息的图片数不能超过 ${limits.images}`)
  if (files.length > limits.files) throw new Error(`团队频道里每条消息的文件数不能超过 ${limits.files}`)
  const mb = (n: number): string => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`
  const kb = (n: number): string => `${Math.round(n / 1024)} KB`
  const out: TeamAttachmentInput[] = []
  for (const image of images) {
    if (image.bytes > limits.imageBytes)
      throw new Error(`图片「${image.name}」太大：团队频道里单张不能超过 ${mb(limits.imageBytes)}`)
    out.push({
      kind: 'image',
      name: clipName(image.name),
      dataBase64: image.dataBase64,
      width: image.width,
      height: image.height,
    })
  }
  for (const file of files) {
    if (file.pathOnly)
      throw new Error(`文件「${file.name}」只带了路径，团队里的其他人读不到：换成能直接带内容的文本文件`)
    const text = fileUploadText(file)
    if (!text) throw new Error(`文件「${file.name}」是空的，团队频道里发不了`)
    if (Buffer.byteLength(text, 'utf8') > limits.fileBytes)
      throw new Error(`文件「${file.name}」太大：团队频道里单个文件的文字不能超过 ${kb(limits.fileBytes)}`)
    out.push({
      kind: 'file',
      name: clipName(file.name),
      dataBase64: Buffer.from(text, 'utf8').toString('base64'),
      bytes: file.bytes,
      lines: file.lines,
      encoding: file.encoding,
    })
  }
  return out
}

/** 消息上的附件说明 → 界面用的样子；没有附件是 undefined */
export function attachedOf(list: TeamAttachmentMeta[]): ChannelAttachedMeta | undefined {
  if (!list.length) return undefined
  const meta: ChannelAttachedMeta = { images: [], files: [] }
  for (const a of list) {
    if (a.kind === 'image') {
      const mediaType = IMAGE_TYPES.find(t => t === a.mime)
      if (mediaType)
        meta.images.push({ id: a.id, name: a.name, mediaType, bytes: a.bytes, width: a.width, height: a.height })
    } else
      meta.files.push({
        id: a.id,
        name: a.name,
        bytes: a.bytes,
        lines: a.lines,
        encoding: ENCODINGS.find(e => e === a.encoding) ?? 'utf-8',
      })
  }
  return meta.images.length || meta.files.length ? meta : undefined
}

/** 取回来的一份 → 本机的图片附件；类型不认识是 null */
export function toImage(data: TeamAttachmentData): ImageAttachment | null {
  const meta = attachedOf([data])?.images[0]
  return meta && data.dataBase64 ? { ...meta, dataBase64: data.dataBase64 } : null
}

/** 取回来的一份 → 本机的文件附件；截断过的拆回开头和结尾 */
export function toFile(data: TeamAttachmentData): FileAttachment | null {
  const meta = data.kind === 'file' ? attachedOf([data])?.files[0] : undefined
  if (!meta) return null
  const all = Buffer.from(data.dataBase64, 'base64').toString('utf8')
  const cut = OMITTED.exec(all)
  const omitted = cut ? Number(cut[1]) : NaN
  if (!cut || !Number.isSafeInteger(omitted) || omitted > meta.lines) return { ...meta, text: all }
  return { ...meta, text: all.slice(0, cut.index), tail: all.slice(cut.index + cut[0].length), omitted }
}
