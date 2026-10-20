// 输入框里的文本文件附件（日志、文本、代码、配置等，docs/ui/composer-file-attachments.md）：
// 读成文字后跟消息一起发给引擎；太大的只带开头和结尾。
import type { FileAttachment, FileSource } from './types'

export const FILE_ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'gb18030'] as const
/** 能提取文字的文件（docs/ui/composer-file-attachments.md §7） */
export const FILE_SOURCES: readonly FileSource[] = [
  'docx',
  'xlsx',
  'pptx',
  'odt',
  'ods',
  'odp',
  'pdf',
  'rtf',
  'epub',
  'html',
  'ipynb',
]
/** 发给引擎时写在 <attached_file> 上的说明：原文件是什么、只带了文字 */
const SOURCE_NOTE: Record<FileSource, string> = {
  docx: 'Word document',
  xlsx: 'Excel workbook',
  pptx: 'PowerPoint presentation',
  odt: 'OpenDocument text',
  ods: 'OpenDocument spreadsheet',
  odp: 'OpenDocument presentation',
  pdf: 'PDF document',
  rtf: 'RTF document',
  epub: 'EPUB book',
  html: 'HTML page',
  ipynb: 'Jupyter notebook',
}
/** 能添加的原文件大小上限：再大的只读开头和结尾也意义不大，而且数行数要读完整个文件 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024
/** 不超过这么大的整个发 */
export const FILE_INLINE_BYTES = 100 * 1024
/** 更大的只带开头这么多、结尾这么多（日志最新的部分在结尾） */
export const FILE_HEAD_BYTES = 10 * 1024
export const FILE_TAIL_BYTES = 90 * 1024
export const MAX_FILE_COUNT = 10
/** 远程或无本机路径时，单个临时引用允许传输的最大大小 */
export const MAX_STAGED_FILE_BYTES = 1024 * 1024 * 1024
export const FILE_STAGE_CHUNK_BYTES = 8 * 1024 * 1024
export const STAGED_FILE_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 路径引用不读取文件内容，因此按安全整数范围校验原文件大小 */
export const MAX_PATH_REFERENCE_BYTES = Number.MAX_SAFE_INTEGER
/** 一条消息里所有文件带上的文字合计（字符） */
export const MAX_FILE_TEXT_TOTAL = 300 * 1024
/** 一个文件带上的文字（字符）：解码后的字符数不会超过读的字节数 */
const MAX_FILE_TEXT = FILE_INLINE_BYTES
/** 原文件路径的长度上限（字符） */
const MAX_FILE_PATH = 4096

/** 共用校验：草稿恢复、IPC 入队和重启后读队列时再检查一次 */
export function validateFiles(value: unknown): FileAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('文件附件格式不正确')
  if (value.length > MAX_FILE_COUNT) throw new Error('一条消息最多添加 10 个文件')
  let total = 0
  const ids = new Set<string>()
  return value.map(raw => {
    if (!raw || typeof raw !== 'object') throw new Error('文件附件格式不正确')
    const file = raw as FileAttachment
    const truncated = file.tail !== undefined || file.omitted !== undefined
    const pathOnly = file.pathOnly === true
    if (
      typeof file.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(file.id) ||
      ids.has(file.id) ||
      typeof file.name !== 'string' ||
      !file.name ||
      file.name.length > 512 ||
      !FILE_ENCODINGS.includes(file.encoding) ||
      !Number.isInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > (pathOnly ? MAX_PATH_REFERENCE_BYTES : MAX_FILE_BYTES) ||
      !Number.isInteger(file.lines) ||
      file.lines < 0 ||
      typeof file.text !== 'string' ||
      file.text.length > MAX_FILE_TEXT ||
      (file.pathOnly !== undefined && typeof file.pathOnly !== 'boolean') ||
      (file.staged !== undefined && typeof file.staged !== 'boolean') ||
      (pathOnly &&
        (!file.path ||
          file.lines !== 0 ||
          file.text !== '' ||
          file.tail !== undefined ||
          file.omitted !== undefined ||
          file.source !== undefined)) ||
      (file.staged === true && !pathOnly) ||
      (file.source !== undefined && !FILE_SOURCES.includes(file.source)) ||
      (file.path !== undefined &&
        (typeof file.path !== 'string' ||
          !file.path ||
          file.path.length > MAX_FILE_PATH ||
          /[\u0000-\u001f\u007f]/.test(file.path))) ||
      (truncated &&
        (typeof file.tail !== 'string' ||
          file.tail.length > MAX_FILE_TEXT ||
          !Number.isInteger(file.omitted) ||
          file.omitted! < 0 ||
          file.omitted! > file.lines))
    )
      throw new Error('文件附件格式不正确')
    total += file.text.length + (file.tail?.length ?? 0)
    if (total > MAX_FILE_TEXT_TOTAL) throw new Error('文件内容合计不能超过 300 KB，请移除一些文件')
    ids.add(file.id)
    return {
      id: file.id,
      name: file.name,
      bytes: file.bytes,
      lines: file.lines,
      encoding: file.encoding,
      text: file.text,
      ...(truncated ? { tail: file.tail, omitted: file.omitted } : {}),
      ...(file.source ? { source: file.source } : {}),
      ...(file.path ? { path: file.path } : {}),
      ...(pathOnly ? { pathOnly: true } : {}),
      ...(file.staged ? { staged: true } : {}),
    }
  })
}

/** 开头、结尾各有几行（截断时开头以换行结束，结尾从一行的开头起） */
export function fileShownLines(file: FileAttachment): { head: number; tail: number } {
  const count = (text: string): number => {
    let n = 0
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++
    return n
  }
  if (file.tail === undefined) return { head: file.lines, tail: 0 }
  return { head: count(file.text), tail: file.lines - count(file.text) - (file.omitted ?? 0) }
}

const attr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** 正文里出现结束标记时改写，免得被当成文件结束 */
const body = (text: string): string => text.replace(/<\/attached_file/gi, '<\\/attached_file')

/**
 * 发给引擎的样子：每个文件一段 <attached_file>，截断时标出带了哪几行、中间省略了多少。
 * 有本机路径时写上 path；文本文件截断了再提示省略的行可以按路径读（文档按路径读到的是原文件，不提示）
 */
export function fileAttachmentBlock(file: FileAttachment): string {
  const size =
    file.bytes >= 1024 * 1024 * 1024
      ? `${(file.bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
      : file.bytes >= 1024 * 1024
        ? `${(file.bytes / 1024 / 1024).toFixed(1)} MB`
        : `${Math.ceil(file.bytes / 1024)} KB`
  if (file.pathOnly) {
    const path = file.path ? ` path="${attr(file.path)}"` : ''
    const expiry = file.staged ? ' This temporary copy is automatically removed after 30 days.' : ''
    return (
      `<attached_file name="${attr(file.name)}"${path} size="${size}" reference="path">\n` +
      `The file contents are not included in this message. Use tools available in this session to inspect the file at the path above; for archives, inspect the entry list and read only relevant members.${expiry}\n` +
      '</attached_file>'
    )
  }
  const source = file.source
    ? ` source="${SOURCE_NOTE[file.source]}" note="text extracted by the app; images and layout are not included"`
    : ''
  const path = file.path ? ` path="${attr(file.path)}"` : ''
  const head = `<attached_file name="${attr(file.name)}"${path} size="${size}" lines="${file.lines}"${source}`
  const end = (text: string): string => (text.endsWith('\n') ? '' : '\n')
  if (file.tail === undefined) return `${head}>\n${body(file.text)}${end(file.text)}</attached_file>`
  const shown = fileShownLines(file)
  const readable = file.path && !file.source ? '; the full file is at the path above, read it for these lines' : ''
  // 只留开头（文档）：后面省略了多少行
  if (!file.tail)
    return (
      `${head} shown="1-${shown.head}">\n` +
      body(file.text) +
      end(file.text) +
      `[... ${file.omitted} more lines omitted (${shown.head + 1}-${file.lines})${readable} ...]\n</attached_file>`
    )
  const from = file.lines - shown.tail + 1
  return (
    `${head} shown="1-${shown.head}, ${from}-${file.lines}">\n` +
    body(file.text) +
    `[... ${file.omitted} lines omitted (${shown.head + 1}-${from - 1})${readable} ...]\n` +
    body(file.tail ?? '') +
    `${file.tail?.endsWith('\n') ? '' : '\n'}</attached_file>`
  )
}

/** 消息正文加上文件：先是用户写的话（开头的 /命令、$技能 照常生效），后面接各个文件 */
export function messageWithFiles(text: string, files: FileAttachment[] | undefined): string {
  if (!files?.length) return text
  return [text.trim(), ...files.map(fileAttachmentBlock)].filter(Boolean).join('\n\n')
}
