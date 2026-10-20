// 读输入框里加的文本文件（docs/ui/composer-file-attachments.md §2）：按内容判断是不是文字、是什么编码；
// 不超过 100 KB 的整个读，更大的只读开头 10 KB 和结尾 90 KB（行数要数完整个文件）。
import {
  FILE_HEAD_BYTES,
  FILE_INLINE_BYTES,
  FILE_TAIL_BYTES,
  IMAGE_MEDIA_TYPES,
  MAX_FILE_BYTES,
  imageMediaType,
  type FileAttachment,
} from '@pixelsky/protocol'
import { tr } from '@/i18n/core'
import { needsConversion } from './convertImage'
import { containerOf, documentAttachment, readDocument } from './extract'
import { htmlTitle, htmlToText } from './extract/html'
import { ipynbText } from './extract/ipynb'
import { readPdf } from './extract/pdf'
import { isRtf, readRtf } from './extract/rtf'

type Encoding = FileAttachment['encoding']

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i
const OFFICE_EXT = /\.(docx|xlsx|pptx|docm|xlsm|pptm|odt|ods|odp|epub)$/i
/** 按类型和扩展名分：图片走图片附件（BMP、HEIC 这类要转的也算），其余当文本文件读（读的时候再按内容判断） */
export const isImageFile = (file: File): boolean =>
  (IMAGE_MEDIA_TYPES as readonly string[]).includes(file.type) ||
  (!file.type && IMAGE_EXT.test(file.name)) ||
  needsConversion(file)

/** 文件名像是放密钥的：添加时提醒一下 */
export const looksSecret = (name: string): boolean =>
  /^\.env(\..+)?$|\.(pem|key|p12|pfx|jks|keystore|ppk)$|^id_(rsa|dsa|ecdsa|ed25519)$|credential|secret|password|token/i.test(
    name,
  )

/** 开头的字节看起来是什么：BOM 定编码；PDF、压缩包（含 Office 文档）、图片直接拒；控制字符多的算二进制 */
function sniff(bytes: Uint8Array): Encoding | 'binary' | 'pdf' | 'image' {
  const begins = (...b: number[]): boolean => b.every((byte, i) => bytes[i] === byte)
  if (begins(0xef, 0xbb, 0xbf)) return 'utf-8'
  if (begins(0xff, 0xfe)) return 'utf-16le'
  if (begins(0xfe, 0xff)) return 'utf-16be'
  if (begins(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'pdf'
  if (imageMediaType(bytes)) return 'image'
  let control = 0
  for (const b of bytes) {
    if (b === 0) return 'binary'
    // 允许制表、换行、换页、回车，以及日志里常见的颜色转义（ESC）
    if (b < 0x20 && b !== 9 && b !== 10 && b !== 11 && b !== 12 && b !== 13 && b !== 27) control++
  }
  return control > bytes.length / 200 ? 'binary' : 'utf-8'
}

const decode = (bytes: Uint8Array, encoding: Encoding, fatal: boolean): string =>
  new TextDecoder(encoding, { fatal }).decode(bytes).replace(/\r\n?/g, '\n')

/** 编码：先试 UTF-8，不是的话试 GB18030（中文 Windows 上的日志常是 GBK），都不是就按 UTF-8 尽量显示 */
function decodeAll(parts: Uint8Array[], encoding: Encoding): { encoding: Encoding; texts: string[] } {
  const candidates: Encoding[] = encoding === 'utf-8' ? ['utf-8', 'gb18030'] : [encoding]
  for (const candidate of candidates) {
    try {
      return { encoding: candidate, texts: parts.map(p => decode(p, candidate, true)) }
    } catch {
      // 换下一个
    }
  }
  return { encoding, texts: parts.map(p => decode(p, encoding, false)) }
}

/** 换行在字节里的位置：UTF-16 是两个字节，按对齐找 */
function newlines(encoding: Encoding): { unit: number; at: (b: Uint8Array, i: number) => boolean } {
  if (encoding === 'utf-16le') return { unit: 2, at: (b, i) => i % 2 === 0 && b[i] === 10 && b[i + 1] === 0 }
  if (encoding === 'utf-16be') return { unit: 2, at: (b, i) => i % 2 === 0 && b[i] === 0 && b[i + 1] === 10 }
  return { unit: 1, at: (b, i) => b[i] === 10 }
}

/** 整个文件有几个换行：一块一块读，只数换行（UTF-16 只数对齐位置上的） */
async function countNewlines(file: File, encoding: Encoding): Promise<number> {
  const parity = encoding === 'utf-16le' ? 0 : encoding === 'utf-16be' ? 1 : -1
  let count = 0,
    offset = 0
  const reader = file.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    for (let i = value.indexOf(10); i >= 0; i = value.indexOf(10, i + 1))
      if (parity < 0 || (offset + i) % 2 === parity) count++
    offset += value.length
  }
  return count
}

const lineCount = (text: string): number => {
  let n = 0
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++
  return text && !text.endsWith('\n') ? n + 1 : n
}

export async function readTextFile(file: File): Promise<FileAttachment> {
  if (file.size > MAX_FILE_BYTES) throw new Error(tr('composer.file.tooLarge', { p0: file.name }))
  const whole = file.size <= FILE_INLINE_BYTES
  const head = new Uint8Array(await file.slice(0, whole ? file.size : FILE_HEAD_BYTES).arrayBuffer())
  // Word / Excel / PPT 这类：提取文字（docs/ui/composer-file-attachments.md §7）
  const container = containerOf(head)
  if (container) return readDocument(file, container)
  if (isRtf(head)) return readRtf(file)
  const kind = sniff(head.subarray(0, 8192))
  // 扩展名是 Office 文档、内容却不是 zip：多半被加密软件加过密（透明加密），或者坏了
  if ((kind === 'binary' || kind === 'image') && OFFICE_EXT.test(file.name))
    throw new Error(tr('composer.file.notDocument', { p0: file.name }))
  if (kind === 'pdf') return readPdf(file)
  if (kind === 'binary' || kind === 'image') throw new Error(tr('composer.file.binary', { p0: file.name }))
  // 是文字、但发原样不划算的（§7.3）：笔记本按单元格写；网页太大（原样会被截断）时只留正文
  const wholeText = async (): Promise<string> => decodeAll([new Uint8Array(await file.arrayBuffer())], kind).texts[0]
  if (/\.ipynb$/i.test(file.name)) {
    const text = ipynbText(await wholeText())
    if (text !== null) return documentAttachment(file, 'ipynb', text)
  }
  if (/\.(html?|xhtml)$/i.test(file.name) && file.size > FILE_INLINE_BYTES) {
    const html = await wholeText()
    const title = htmlTitle(html)
    return documentAttachment(file, 'html', `${title ? `# ${title}\n\n` : ''}${htmlToText(html)}`)
  }
  const base = { id: crypto.randomUUID(), name: file.name || 'file.txt', bytes: file.size }
  if (whole) {
    const { encoding, texts } = decodeAll([head], kind)
    return { ...base, encoding, lines: lineCount(texts[0]), text: texts[0] }
  }
  // 太大：开头截到最后一个换行，结尾从第一个换行之后开始（换行字节不会出现在多字节字符中间）
  const nl = newlines(kind)
  let start = file.size - FILE_TAIL_BYTES
  if (nl.unit === 2 && start % 2) start++
  const tail = new Uint8Array(await file.slice(start).arrayBuffer())
  let headEnd = head.length
  for (let i = head.length - nl.unit; i >= 0; i--)
    if (nl.at(head, i)) {
      headEnd = i + nl.unit
      break
    }
  let tailStart = 0
  for (let i = 0; i < tail.length; i++)
    if (nl.at(tail, i)) {
      tailStart = i + nl.unit
      break
    }
  const { encoding, texts } = decodeAll([head.subarray(0, headEnd), tail.subarray(tailStart)], kind)
  if (sniff(tail.subarray(tailStart, tailStart + 8192)) === 'binary' && !encoding.startsWith('utf-16'))
    throw new Error(tr('composer.file.binary', { p0: file.name }))
  const [text, rest] = texts
  // 最后一行没有换行也算一行
  const lines = (await countNewlines(file, encoding)) + (nl.at(tail, tail.length - nl.unit) ? 0 : 1)
  const headLines = lineCount(text),
    tailLines = lineCount(rest)
  return { ...base, encoding, lines, text, tail: rest, omitted: Math.max(0, lines - headLines - tailLines) }
}

/** 大致的 token 数：英文约 4 个字符一个，中文约一个字一个 */
export function estimateTokens(text: string): number {
  let ascii = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++
  return Math.ceil(ascii / 4 + (text.length - ascii))
}

export function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`
}
