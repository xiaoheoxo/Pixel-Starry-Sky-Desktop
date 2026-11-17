// 内置浏览器第一批（docs/ui/browser-v2.md §3.1）的纯函数：短地址、地址栏下拉、整页打不开的原因、要不要标签行
import type { TranslationKey } from '@/i18n/core'
import type { BrowserPage } from '../../../../shared/types/project-browser'
import type { FoundPort } from '@/features/session/live/portTipsModel'

export type AddressKind = 'secure' | 'insecure' | 'local' | 'file'

const LOCAL = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i

/** 地址栏没聚焦时的样子：图标种类、主机（正常颜色）、路径（淡色）；不写协议和结尾斜杠 */
export function addressParts(url: string): { kind: AddressKind; host: string; path: string } {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { kind: 'insecure', host: url, path: '' }
  }
  if (u.protocol === 'file:') {
    const parts = decodeURIComponent(u.pathname).split('/').filter(Boolean)
    const name = parts.pop() ?? ''
    return { kind: 'file', host: name, path: parts.length ? ' — ' + parts.slice(-2).join('/') : '' }
  }
  const path = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash
  return {
    kind: LOCAL.test(u.hostname) ? 'local' : u.protocol === 'https:' ? 'secure' : 'insecure',
    host: u.host,
    path,
  }
}

/** 地址里给人看的部分：去掉协议和结尾斜杠 */
export const plainAddress = (url: string): string => url.replace(/^[a-z][a-z\d+.-]*:\/\//i, '').replace(/\/$/, '')

export interface AddressSuggestion {
  kind: 'go' | 'port' | 'recent'
  url: string
  /** 地址那一栏（等宽） */
  label: string
  /** 后面淡色的说明：命令、「正在看」、网页标题 */
  hint: string
  /** 'go' 的说明是「打开这个端口」还是「打开」 */
  port?: boolean
  /** 就是当前这一页 */
  current?: boolean
}

const PORTS_MAX = 5
const RECENT_MAX = 8
/** 只输端口号（5173、:5173、5173/settings）→ 本机地址；不是时 null（和主进程的 browserUrl 一样） */
const portOnly = (text: string): string | null => {
  const m = /^:?(\d{1,5})(\/.*)?$/.exec(text.trim())
  const n = m ? Number(m[1]) : NaN
  return m && n >= 1 && n <= 65535 ? `http://localhost:${n}${m[2] ?? '/'}` : null
}
const sameAddress = (a: string, b: string): boolean => plainAddress(a).toLowerCase() === plainAddress(b).toLowerCase()

/**
 * 地址栏下拉：输入改过时第一条是「回车会打开什么」；然后对话里发现的端口、这个工作区最近打开的地址，按输入过滤。
 * input 和当前地址一样（刚聚焦、全选着）时不过滤、没有第一条
 */
export function addressSuggestions(
  input: string,
  current: string,
  ports: readonly FoundPort[],
  recent: readonly string[],
  titles: ReadonlyMap<string, string> = new Map(),
): AddressSuggestion[] {
  const text = input.trim()
  const typed = !!text && !sameAddress(text, current)
  const needle = typed ? text.toLowerCase().replace(/^[a-z][a-z\d+.-]*:\/\//, '') : ''
  const match = (url: string) => !needle || plainAddress(url).toLowerCase().includes(needle)
  const out: AddressSuggestion[] = []
  if (typed) {
    const port = portOnly(text)
    out.push(
      port
        ? { kind: 'go', url: port, label: plainAddress(port), hint: '', port: true }
        : { kind: 'go', url: text, label: text, hint: '' },
    )
  }
  const seen = new Set(out.map(s => plainAddress(s.url).toLowerCase()))
  for (const p of ports) {
    const url = `http://localhost:${p.port}/`
    if (out.length >= PORTS_MAX + 1 || !match(url) || seen.has(plainAddress(url).toLowerCase())) continue
    seen.add(plainAddress(url).toLowerCase())
    out.push({ kind: 'port', url, label: `localhost:${p.port}`, hint: p.command, current: sameAddress(url, current) })
  }
  let recents = 0
  for (const url of recent) {
    if (recents >= RECENT_MAX || !match(url) || seen.has(plainAddress(url).toLowerCase())) continue
    seen.add(plainAddress(url).toLowerCase())
    recents++
    out.push({
      kind: 'recent',
      url,
      label: plainAddress(url),
      hint: titles.get(url) ?? '',
      current: sameAddress(url, current),
    })
  }
  return out
}

/** 整页打不开的原因（Chromium 网络错误码 → 一句话）；0 是网页崩溃 */
export function loadFailureReason(code: number): TranslationKey {
  if (code === 0) return 'projectTools.fail.crashed'
  if (code === -102 || code === -109 || code === -324) return 'projectTools.fail.refused'
  if (code === -105 || code === -137) return 'projectTools.fail.notFound'
  if (code === -106 || code === -21) return 'projectTools.fail.offline'
  if (code === -7 || code === -118) return 'projectTools.fail.timeout'
  if (code === -100 || code === -101 || code === -103) return 'projectTools.fail.reset'
  if (code === -6) return 'projectTools.fail.file'
  if (code <= -200 && code > -300) return 'projectTools.fail.cert'
  return 'projectTools.fail.other'
}

/** 标签行：两个以上页面才出；只有一个页面但正在开新页面（没有当前页）时也出，好切回去 */
export const showPageTabs = (pages: readonly BrowserPage[], activeId: string | null): boolean =>
  pages.length >= 2 || (pages.length >= 1 && !pages.some(p => p.id === activeId))

/** 标签上的红点：整页打不开，或者有控制台错误 / 失败请求 */
export const pageHasProblem = (p: BrowserPage): boolean =>
  p.failed !== undefined || (p.issues?.errors ?? 0) + (p.issues?.requests ?? 0) > 0
