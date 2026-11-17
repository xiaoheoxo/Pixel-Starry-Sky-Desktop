// 运行胶囊里的内置浏览器（docs/ui/panel-pill.md §8.1）：浏览器标签不在眼前、又开着页面时，显示当前页的地址和错误数
import { browserIssueText, type BrowserState } from '../../../../shared/types/project-browser'

export interface BrowserPill {
  pageId: string
  /** 去掉协议和结尾斜杠的地址：localhost:5173/settings */
  label: string
  url: string
  title: string
  loading: boolean
  /** 整页打不开的原因 */
  error: string | null
  /** 控制台错误 + 失败请求 */
  issues: number
  last: string[]
}

export const shortUrl = (url: string): string => url.replace(/^[a-z][a-z\d+.-]*:\/\//i, '').replace(/\/$/, '')

/** inView：右栏开着而且当前是浏览器标签 */
export function browserPillOf(state: BrowserState | null, inView: boolean): BrowserPill | null {
  if (inView || !state) return null
  const page = state.pages.find(p => p.id === state.activeId)
  if (!page || !page.url || page.url === 'about:blank') return null
  return {
    pageId: page.id,
    label: shortUrl(page.url),
    url: page.url,
    title: page.title,
    loading: page.loading,
    error: page.error,
    issues: (page.issues?.errors ?? 0) + (page.issues?.requests ?? 0),
    last: page.issues?.last ?? [],
  }
}

/** 胶囊是红的：页面打不开，或者有错误 */
export const browserFailed = (pill: BrowserPill): boolean => !!pill.error || pill.issues > 0

/** 「把错误发给 AI」放进输入框的那段（文字在 shared，给 AI 看的不走界面词典） */
export function browserIssueQuote(pill: BrowserPill): string {
  return browserIssueText(pill.url, pill.issues + (pill.error ? 1 : 0), [
    ...(pill.error ? [pill.error] : []),
    ...pill.last,
  ])
}
