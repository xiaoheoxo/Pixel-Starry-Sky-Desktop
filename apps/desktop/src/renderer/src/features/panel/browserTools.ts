// 内置浏览器第二批（docs/ui/browser-v2.md §3.2）界面用的纯函数：控制台抽屉的筛选和发给 AI 的文字、截图转附件、缩放显示
import { MAX_IMAGE_BYTES, MAX_IMAGE_COUNT, MAX_IMAGE_TOTAL, type ImageAttachment } from '@pixelsky/protocol'
import {
  browserIssueText,
  type BrowserCapture,
  type BrowserIssueEntry,
  type BrowserPage,
} from '../../../../shared/types/project-browser'

export type ConsoleFilter = 'all' | 'error' | 'request'

/** 「全部」里带不带警告看开关；「错误」「失败请求」只看各自的 */
const shown = (e: BrowserIssueEntry, filter: ConsoleFilter, warnings: boolean): boolean =>
  filter === 'all' ? e.kind !== 'warning' || warnings : e.kind === filter

/** 抽屉里显示的几条：新的在上面 */
export function visibleEntries(
  list: readonly BrowserIssueEntry[],
  filter: ConsoleFilter,
  warnings: boolean,
): BrowserIssueEntry[] {
  return list.filter(e => shown(e, filter, warnings)).reverse()
}

export function filterCounts(list: readonly BrowserIssueEntry[], warnings: boolean): Record<ConsoleFilter, number> {
  return {
    all: list.filter(e => shown(e, 'all', warnings)).length,
    error: list.filter(e => e.kind === 'error').length,
    request: list.filter(e => e.kind === 'request').length,
  }
}

/** 工具栏「⚠」上的数：错误 + 失败请求，开了「显示警告」再加警告 */
export function issueCount(page: BrowserPage | undefined, warnings: boolean): number {
  const i = page?.issues
  return i ? i.errors + i.requests + (warnings ? (i.warnings ?? 0) : 0) : 0
}

/** 发给 AI 的一行：警告标出来，控制台带「文件:行」 */
export function entryLine(e: BrowserIssueEntry): string {
  const head = e.kind === 'warning' ? `[warning] ${e.text}` : e.text
  return e.kind !== 'request' && e.source ? `${head} (${e.source})` : head
}

/** 一次最多放这么多条进输入框（最新的） */
export const QUOTE_MAX = 20

/** 放进输入框的那段（和运行胶囊同一个格式）；list 是旧的在前 */
export function entriesQuote(url: string, list: readonly BrowserIssueEntry[]): string {
  return browserIssueText(url, list.length, list.slice(-QUOTE_MAX).map(entryLine))
}

/** 时:分:秒（本地时间） */
export function clockTime(at: number): string {
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

/** 截图 → 输入框的图片附件（JPEG） */
export function captureAttachment(capture: BrowserCapture, name: string, id: string): ImageAttachment {
  const pad = capture.dataBase64.endsWith('==') ? 2 : capture.dataBase64.endsWith('=') ? 1 : 0
  return {
    id,
    name,
    mediaType: 'image/jpeg',
    bytes: Math.floor((capture.dataBase64.length * 3) / 4) - pad,
    width: capture.width,
    height: capture.height,
    dataBase64: capture.dataBase64,
  }
}

/** 放不进输入框的原因（词典键）：张数、单张、总大小 */
export function attachmentProblem(
  current: readonly ImageAttachment[],
  next: ImageAttachment,
): 'composer.attachment.tooMany' | 'composer.attachment.tooLarge' | 'composer.attachment.totalTooLarge' | null {
  if (current.length >= MAX_IMAGE_COUNT) return 'composer.attachment.tooMany'
  if (next.bytes > MAX_IMAGE_BYTES) return 'composer.attachment.tooLarge'
  if (current.reduce((sum, i) => sum + i.bytes, 0) + next.bytes > MAX_IMAGE_TOTAL)
    return 'composer.attachment.totalTooLarge'
  return null
}

/** 截图的文件名：主机名 + 时间，如 localhost-5173-120431.jpg */
export function captureName(url: string, at: number): string {
  let host = 'page'
  try {
    host = new URL(url).host.replace(/[^\w.-]+/g, '-') || 'page'
  } catch {}
  return `${host}-${clockTime(at).replace(/:/g, '')}.jpg`
}

/** 控制台抽屉的高度和「显示警告」：全局记住 */
export const CONSOLE_HEIGHT = { min: 120, max: 480, initial: 220 }
export interface ConsolePrefs {
  height: number
  warnings: boolean
}
export function parseConsolePrefs(raw: string | null): ConsolePrefs {
  try {
    const v = JSON.parse(raw ?? '{}') as { height?: unknown; warnings?: unknown }
    const h = typeof v.height === 'number' && Number.isFinite(v.height) ? Math.round(v.height) : CONSOLE_HEIGHT.initial
    return {
      height: Math.min(CONSOLE_HEIGHT.max, Math.max(CONSOLE_HEIGHT.min, h)),
      warnings: v.warnings === true,
    }
  } catch {
    return { height: CONSOLE_HEIGHT.initial, warnings: false }
  }
}

export const zoomPercent = (zoom: number | undefined): string => `${Math.round((zoom ?? 1) * 100)}%`

/** 能清数据、开开发者工具的页面（http / https，不是本地文件） */
export function isWebPage(page: BrowserPage | undefined): boolean {
  return !!page && /^https?:/i.test(page.remoteUrl ?? page.url)
}
