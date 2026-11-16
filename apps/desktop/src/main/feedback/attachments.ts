// 反馈附带的内容（docs/ui/feedback.md §2.3、§5、§6）：诊断信息、日志、截图、报错片段。
// 纯函数 + 注入依赖，不碰 Electron，方便测试。
import { homedir } from 'node:os'
import { gzipSync } from 'node:zlib'
import { formatLogLine, logTime, type ImageAttachment, type LogEntry, type LogQuery } from '@pixelsky/protocol'
import { redact } from '@pixelsky/engine'
import type { AppInfo } from '../../shared/types/app-info'
import {
  FEEDBACK_LIMITS,
  type FeedbackDiagnostics,
  type FeedbackAttachInput,
  type FeedbackErrorSnippet,
  type FeedbackImageInput,
  type FeedbackLogPreview,
} from '../../shared/types/feedback'
import { diagnosticsToWire, errorToWire, type WireAttachment, type WireClient, type WireMessage } from './api'

/** 日志最多取多少条（和 LogService.read 的上限一致） */
export const LOG_ENTRIES = 1000

// ---------------------------------------------------------------------------
// 诊断信息：版本、系统这类字段，不含路径、数据目录、认证服务地址
// ---------------------------------------------------------------------------

export interface EngineBrief {
  name: string
  version: string | null
  status: string
}

export function buildDiagnostics(
  info: Pick<AppInfo, 'version' | 'channel' | 'os' | 'arch' | 'electron' | 'chrome' | 'node'>,
  engines: readonly EngineBrief[],
  locale: string,
): { diagnostics: FeedbackDiagnostics; text: string } {
  const diagnostics: FeedbackDiagnostics = {
    appVersion: info.version,
    channel: info.channel,
    os: info.os,
    arch: info.arch,
    electron: info.electron,
    chrome: info.chrome,
    node: info.node,
    locale,
    engines: engines.map(e => ({ name: e.name, version: e.version ?? null, status: e.status })),
  }
  const lines = [
    `版本：${diagnostics.appVersion}（${diagnostics.channel}）`,
    `系统：${diagnostics.os} ${diagnostics.arch}`,
    `Electron ${diagnostics.electron} · Chrome ${diagnostics.chrome} · Node ${diagnostics.node}`,
    `界面语言：${diagnostics.locale}`,
    diagnostics.engines.length
      ? '引擎：\n' + diagnostics.engines.map(e => `  ${e.name} ${e.version ?? '未检测到版本'} · ${e.status}`).join('\n')
      : '引擎：无',
  ]
  return { diagnostics, text: lines.join('\n') }
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

export interface SanitizeOptions {
  /** 主目录；默认 os.homedir() */
  home?: string
  /** 默认 process.platform；win32 时路径不分大小写 */
  platform?: string
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function homePattern(home: string, platform: string): RegExp | null {
  const parts = home.split(/[\\/]+/).filter(Boolean)
  if (parts.length < 2 && !/^[\\/]/.test(home)) return null // 不是正常的主目录（例如空串）就不替换
  // 两种斜杠都认；日志里的字段是 JSON，反斜杠会写成两个
  const sep = '(?:\\\\{1,2}|/)+'
  const lead = /^[\\/]/.test(home) ? sep : ''
  const body = parts.map(escapeRegExp).join(sep)
  return new RegExp(`(?<![\\w.~-])${lead}${body}(?![\\w.-])`, platform === 'win32' ? 'gi' : 'g')
}

/** 再脱敏一遍密钥，并把主目录换成 ~；可以重复调用，结果不变 */
export function sanitizeLogText(text: string, opts: SanitizeOptions = {}): string {
  const home = opts.home ?? homedir()
  const pattern = home ? homePattern(home, opts.platform ?? process.platform) : null
  let out = redact(text)
  if (pattern) out = out.replace(pattern, '~')
  return out
}

export interface LogReader {
  read(query: LogQuery): Promise<LogEntry[]>
}

const OMITTED = (n: number): string => `（更早的 ${n} 行已省略）`

/** 把已经格式化、清洗过的行拼成预览文字；超过 logBytes 时丢最早的行 */
function compose(header: string, lines: string[]): { text: string; kept: number; truncated: boolean } {
  const bytes = (s: string): number => Buffer.byteLength(s) + 1 // 加一个换行
  const all = lines.reduce((n, l) => n + bytes(l), bytes(header))
  if (all <= FEEDBACK_LIMITS.logBytes)
    return { text: [header, ...lines].join('\n'), kept: lines.length, truncated: false }
  // 说明行的字数随 N 变，按最大位数预留
  let budget = FEEDBACK_LIMITS.logBytes - bytes(header) - bytes(OMITTED(lines.length))
  let start = lines.length
  while (start > 0 && budget - bytes(lines[start - 1]) >= 0) {
    start--
    budget -= bytes(lines[start])
  }
  return {
    text: [header, OMITTED(start), ...lines.slice(start)].join('\n'),
    kept: lines.length - start,
    truncated: true,
  }
}

/**
 * 读 [since, until] 内最多 1000 条日志，拼成将要发送的原文：每行再脱敏、主目录换成 ~，
 * 超过 1 MB 丢最早的行并在开头注明
 */
export async function buildLogs(
  svc: LogReader,
  since: number,
  until: number,
  opts: SanitizeOptions = {},
): Promise<FeedbackLogPreview> {
  const entries = await svc.read({ since, until, limit: LOG_ENTRIES })
  const lines = entries.map(e => sanitizeLogText(formatLogLine(e), opts))
  const header = `# 最近日志 ${logTime(since)} ~ ${logTime(until)} · 最多包含 ${LOG_ENTRIES} 条`
  const { text, kept, truncated } = compose(header, lines)
  return { text, lines: kept, bytes: Buffer.byteLength(text), truncated, since, until }
}

/** 日志原文 → gzip → base64；原文超过 1 MB 或压缩后超过 512 KB 报错（会再清洗一遍） */
export function packLogs(
  text: string,
  opts: SanitizeOptions = {},
): { base64: string; rawBytes: number; packedBytes: number } {
  const clean = sanitizeLogText(text, opts)
  const rawBytes = Buffer.byteLength(clean)
  if (rawBytes > FEEDBACK_LIMITS.logBytes) throw new Error('日志太大（超过 1 MB），请缩短时间范围后再试')
  const packed = gzipSync(Buffer.from(clean, 'utf8'))
  if (packed.length > FEEDBACK_LIMITS.logPackedBytes)
    throw new Error('日志压缩后仍然太大（超过 512 KB），请缩短时间范围后再试')
  return { base64: packed.toString('base64'), rawBytes, packedBytes: packed.length }
}

export function logAttachment(text: string, opts: SanitizeOptions = {}): WireAttachment {
  return {
    kind: 'log',
    name: 'logs.txt',
    media_type: 'text/plain',
    encoding: 'gzip',
    data_base64: packLogs(text, opts).base64,
  }
}

// ---------------------------------------------------------------------------
// 截图
// ---------------------------------------------------------------------------

const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
const SHRINK_EDGES = [2560, 1920, 1280, 800]

export type Shrink = (image: ImageAttachment, maxEdge: number) => ImageAttachment | null

function imageName(name: unknown, ext: string): string {
  const base =
    (typeof name === 'string' ? name : '')
      .split(/[\\/]/)
      .pop()
      ?.replace(/\p{Cc}/gu, '') ?? ''
  const stem = base.replace(/\.[^.]*$/, '').slice(0, 60)
  return `${stem || 'image'}.${ext}`
}

/** 校验并缩小截图：每张不超过 imageBytes；够小的原样发送，太大的缩到长边 2560 以内转 JPEG，还大就继续缩 */
export function prepareImages(images: readonly FeedbackImageInput[], shrink: Shrink): WireAttachment[] {
  if (!Array.isArray(images)) throw new Error('截图参数不对')
  if (images.length > FEEDBACK_LIMITS.images) throw new Error(`最多附 ${FEEDBACK_LIMITS.images} 张截图`)
  return images.map((img, index) => {
    const label = `第 ${index + 1} 张截图`
    if (!img || typeof img !== 'object' || typeof img.data !== 'string' || !img.data)
      throw new Error(`${label}没有内容`)
    const ext = IMAGE_TYPES[img.mediaType]
    if (!ext) throw new Error(`${label}的格式不支持（只支持 PNG、JPEG、WebP）`)
    const bytes = Buffer.from(img.data, 'base64').length
    if (bytes === 0) throw new Error(`${label}没有内容`)
    if (bytes <= FEEDBACK_LIMITS.imageBytes) {
      return {
        kind: 'image',
        name: imageName(img.name, ext),
        media_type: img.mediaType,
        encoding: '',
        data_base64: img.data,
      }
    }
    const source = {
      id: `fb${index}`,
      name: imageName(img.name, ext),
      mediaType: img.mediaType as ImageAttachment['mediaType'],
      bytes,
      width: 0,
      height: 0,
      dataBase64: img.data,
    } satisfies ImageAttachment
    for (const edge of SHRINK_EDGES) {
      const small = shrink(source, edge)
      if (!small) throw new Error(`${label}无法读取，请换一张图片`)
      if (small.bytes <= FEEDBACK_LIMITS.imageBytes) {
        return {
          kind: 'image',
          name: imageName(small.name, 'jpg'),
          media_type: small.mediaType,
          encoding: '',
          data_base64: small.dataBase64,
        }
      }
    }
    throw new Error(`${label}太大，压缩后仍超过 ${FEEDBACK_LIMITS.imageBytes / 1024 / 1024} MB`)
  })
}

// ---------------------------------------------------------------------------
// 报错片段
// ---------------------------------------------------------------------------

/** 校验渲染层传来的报错片段（只有错误文字、会话编号和时间） */
export function checkErrorSnippet(value: unknown): FeedbackErrorSnippet {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  if (typeof v.text !== 'string' || !v.text.trim()) throw new Error('报错片段没有内容')
  if (v.text.length > FEEDBACK_LIMITS.errorChars) throw new Error(`报错片段不能超过 ${FEEDBACK_LIMITS.errorChars} 字`)
  if (typeof v.sessionId !== 'string' || v.sessionId.length > 200) throw new Error('报错片段的会话编号不对')
  if (typeof v.at !== 'number' || !Number.isFinite(v.at) || v.at <= 0) throw new Error('报错片段的时间不对')
  return { text: redact(v.text), sessionId: v.sessionId, at: v.at }
}

// ---------------------------------------------------------------------------
// 一条消息的附件（新反馈和补充共用）
// ---------------------------------------------------------------------------

export interface MessageDeps {
  /** 现场取的诊断信息 */
  diagnostics: () => Promise<FeedbackDiagnostics>
  client: () => WireClient
  shrink: Shrink
  sanitize?: SanitizeOptions
}

/** 渲染层的附带信息 → 发给云端的字段；日志只发预览里显示过的原文（再清洗一遍） */
export async function buildAttachFields(
  input: FeedbackAttachInput,
  deps: MessageDeps,
): Promise<Pick<WireMessage, 'client' | 'diagnostics' | 'error' | 'attachments'>> {
  if (typeof input.diagnostics !== 'boolean') throw new Error('附带信息参数不对')
  if (input.logs !== null && typeof input.logs !== 'string') throw new Error('日志参数不对')
  const attachments: WireAttachment[] = []
  if (input.logs !== null && input.logs.trim()) attachments.push(logAttachment(input.logs, deps.sanitize))
  attachments.push(...prepareImages(input.images ?? [], deps.shrink))
  const error = input.error ? checkErrorSnippet(input.error) : null
  return {
    client: deps.client(),
    diagnostics: input.diagnostics ? diagnosticsToWire(await deps.diagnostics()) : null,
    error: error ? errorToWire(error) : null,
    attachments,
  }
}

const countChars = (s: string): number => [...s].length

export function checkBody(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请填写内容')
  if (countChars(value) > FEEDBACK_LIMITS.bodyChars) throw new Error(`内容不能超过 ${FEEDBACK_LIMITS.bodyChars} 字`)
  return value
}

export function checkTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.trim() : ''
  if (!title) throw new Error('请填写标题')
  if (countChars(title) > FEEDBACK_LIMITS.titleChars) throw new Error(`标题不能超过 ${FEEDBACK_LIMITS.titleChars} 字`)
  return title
}

/**
 * 手机发来的新反馈 / 补充：日志是时间窗 { since, until }（或 null），在电脑上取；出错片段手机不带。
 * 其余字段原样交给和设置页同一套校验
 */
export async function phoneInput(
  raw: unknown,
  logs: (window: unknown) => Promise<FeedbackLogPreview>,
): Promise<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('反馈参数不对')
  const input = raw as Record<string, unknown>
  const window = input.logs
  return {
    ...input,
    diagnostics: input.diagnostics === true,
    logs: window === null || window === undefined ? null : (await logs(window)).text,
    images: Array.isArray(input.images) ? input.images : [],
    error: null,
  }
}
