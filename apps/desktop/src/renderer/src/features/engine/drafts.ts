// 每个会话共用草稿，切换会话 / 重启不丢；撤回通过函数更新保留已有内容。
import { useCallback, useSyncExternalStore } from 'react'
const STORAGE = 'pixelsky.composer-drafts'
let drafts: Record<string, string> = {}
try {
  const saved: unknown = JSON.parse(localStorage.getItem(STORAGE) ?? '{}')
  if (saved && typeof saved === 'object' && !Array.isArray(saved))
    drafts = Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === 'string'))
} catch {
  /* 使用空草稿 */
}
// 每按一个键都把全部草稿 stringify 写一遍太费（docs/perf-audit-2026-10-18.md D9）：攒 400 ms 再写；
// 窗口切到后台、关闭前马上写，不丢最后几个字
let timer: ReturnType<typeof setTimeout> | null = null
function flush(): void {
  if (timer) clearTimeout(timer)
  timer = null
  try {
    localStorage.setItem(STORAGE, JSON.stringify(drafts))
  } catch {
    /* 当前窗口内仍保留 */
  }
}
function persist(): void {
  if (!timer) timer = setTimeout(flush, 400)
}
// 测试里可能只有 window 没有 document（别的测试文件挂了个假的 window）
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('pagehide', () => timer && flush())
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && timer && flush())
}

const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 旧版本的新会话共用一个草稿键，升级时交给一个现有新标签，避免复制或丢失。 */
export function migrateNewComposerDraft(key: string): void {
  if (!drafts['new-session'] || drafts[key] !== undefined) return
  drafts = { ...drafts, [key]: drafts['new-session'] }
  delete drafts['new-session']
  persist()
  listeners.forEach(listener => listener())
}

export function useComposerDraft(key: string): [string, (value: string | ((previous: string) => string)) => void] {
  const value = useSyncExternalStore(subscribe, () => drafts[key] ?? '')
  const set = useCallback(
    (next: string | ((previous: string) => string)) => {
      const text = typeof next === 'function' ? next(drafts[key] ?? '') : next
      drafts = { ...drafts, [key]: text }
      if (!text) delete drafts[key]
      persist()
      listeners.forEach(listener => listener())
    },
    [key],
  )
  return [value, set]
}

/** 某个输入框现在的草稿（不在输入框组件里读，例如侧栏判断新会话标签里写没写东西） */
export const composerDraft = (key: string): string => drafts[key] ?? ''

/** 不在输入框组件里时追加草稿（回退把原文放回发起窗格的输入框）；已有内容时换行追加。 */
export function appendComposerDraft(key: string, text: string): void {
  if (!text) return
  const current = drafts[key] ?? ''
  drafts = { ...drafts, [key]: current ? `${current}\n${text}` : text }
  persist()
  listeners.forEach(listener => listener())
}

/** 接在草稿末尾、同一行（@路径 这类）：前面不是空白时补一个空格 */
export function appendComposerInline(key: string, text: string): void {
  if (!text) return
  const current = drafts[key] ?? ''
  drafts = { ...drafts, [key]: !current || /\s$/.test(current) ? current + text : `${current} ${text}` }
  persist()
  listeners.forEach(listener => listener())
}

/** 撤销回退时去掉回退放进来的原文（只在草稿正好以它结尾时去掉，用户改过就不动） */
export function removeComposerDraftTail(key: string, text: string): void {
  const current = drafts[key] ?? ''
  if (!text || !current.endsWith(text)) return
  const rest = current.slice(0, current.length - text.length).replace(/\n$/, '')
  drafts = { ...drafts, [key]: rest }
  persist()
  listeners.forEach(listener => listener())
}
