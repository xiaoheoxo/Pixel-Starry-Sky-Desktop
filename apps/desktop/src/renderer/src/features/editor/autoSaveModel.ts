// 内置编辑器的自动保存（参考 VS Code 的 files.autoSave）：设置的读写和「这个文件现在能不能自动保存」的判断。
// 设置存在本机（localStorage），多个窗口经 storage 事件同步，云同步白名单里登记了同一个键（settings/sync/registry.ts）。
// 真正保存的是 autoSave.ts；这里不碰编辑器、不发请求，node 环境的测试可以直接 import。
import { useSyncExternalStore } from 'react'

export type AutoSaveMode = 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange'
export const AUTO_SAVE_MODES: readonly AutoSaveMode[] = ['off', 'afterDelay', 'onFocusChange', 'onWindowChange']

export interface AutoSavePrefs {
  mode: AutoSaveMode
  /** afterDelay：停止输入多少毫秒后保存 */
  delay: number
}

export const AUTO_SAVE_KEY = 'pixelsky.editor.autoSave'
export const DELAY_DEFAULT = 1000
export const DELAY_MIN = 200
export const DELAY_MAX = 60_000
export const DEFAULT_AUTO_SAVE: AutoSavePrefs = { mode: 'off', delay: DELAY_DEFAULT }

/** 读回来的值不认识就用默认值；延迟取整、夹在 200 ms 到 60 秒之间 */
export function sanitizeAutoSave(raw: unknown): AutoSavePrefs {
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const mode = AUTO_SAVE_MODES.includes(v.mode as AutoSaveMode) ? (v.mode as AutoSaveMode) : 'off'
  const n = typeof v.delay === 'number' && Number.isFinite(v.delay) ? Math.round(v.delay) : DELAY_DEFAULT
  return { mode, delay: Math.min(DELAY_MAX, Math.max(DELAY_MIN, n)) }
}

function load(): AutoSavePrefs {
  try {
    return sanitizeAutoSave(JSON.parse(localStorage.getItem(AUTO_SAVE_KEY) ?? 'null'))
  } catch {
    return DEFAULT_AUTO_SAVE
  }
}
let prefs: AutoSavePrefs | null = null
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach(fn => fn())

export function getAutoSave(): AutoSavePrefs {
  if (!prefs) prefs = typeof localStorage === 'undefined' ? DEFAULT_AUTO_SAVE : load()
  return prefs
}

export function setAutoSave(patch: Partial<AutoSavePrefs>): void {
  prefs = sanitizeAutoSave({ ...getAutoSave(), ...patch })
  try {
    localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(prefs))
  } catch {
    /* 当前窗口里照样生效 */
  }
  emit()
}

function onStorage(event: StorageEvent): void {
  if (event.storageArea === localStorage && (event.key === AUTO_SAVE_KEY || event.key === null)) {
    prefs = load()
    emit()
  }
}
export function subscribeAutoSave(fn: () => void): () => void {
  if (!listeners.size) window.addEventListener('storage', onStorage)
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
    if (!listeners.size) window.removeEventListener('storage', onStorage)
  }
}
export function useAutoSave(): AutoSavePrefs {
  return useSyncExternalStore(subscribeAutoSave, getAutoSave, getAutoSave)
}

export const EDITOR_BLUR_EVENT = 'pixelsky:editor-blur'

/** 编辑器（CodeMirror）失去焦点时调（autoSave.ts 监听）：焦点挪到编辑器自己的搜索框等内部元素时不调 */
export function notifyEditorBlur(tabId: string): void {
  window.dispatchEvent(new CustomEvent<string>(EDITOR_BLUR_EVENT, { detail: tabId }))
}

// ---- 判断 ----

/** 判断要用的标签页字段（files/store 的 OpenFile 的一部分） */
export interface AutoSaveTab {
  id: string
  ref: { sessionId?: string; projectId?: string }
  root: string
  draft: string
  document: { kind: string; readonly?: boolean; content?: string } | null
  external: unknown
  loading: boolean
  saving: boolean
}

/** 判断要用的会话字段（SessionSummary 的一部分） */
export interface AutoSaveSession {
  record: { id: string; projectId: string; cwd: string }
  state: string
  background?: number
}

const norm = (path: string, caseInsensitive: boolean): string => {
  const p = path.replaceAll('\\', '/').replace(/\/+$/, '')
  return caseInsensitive ? p.toLowerCase() : p
}

/** 两个文件夹是同一个，或一个在另一个里面 */
export function pathsOverlap(a: string, b: string, caseInsensitive: boolean): boolean {
  const x = norm(a, caseInsensitive),
    y = norm(b, caseInsensitive)
  if (!x || !y) return false
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/')
}

/**
 * 这个文件所在的地方有 AI 会话正在跑（含后台子智能体）：先不自动保存，避免和 AI 抢同一个文件
 * （docs/ui/coding-mode-impl.md D8）。会话本身、同一个项目、或工作目录和文件根目录有重叠都算
 */
export function aiBusyFor(
  tab: Pick<AutoSaveTab, 'ref' | 'root'>,
  sessions: readonly AutoSaveSession[],
  caseInsensitive: boolean,
): boolean {
  return sessions.some(
    s =>
      (s.state !== 'idle' || !!s.background) &&
      (tab.ref.sessionId === s.record.id ||
        (!!tab.ref.projectId && tab.ref.projectId === s.record.projectId) ||
        pathsOverlap(tab.root, s.record.cwd, caseInsensitive)),
  )
}

export type AutoSaveVerdict =
  /** 可以保存 */
  | 'save'
  /** 不用存或不能存：没改动、只读、正在读 / 存、和磁盘冲突、上次这份内容存失败了 */
  | 'skip'
  /** AI 正在跑：等它停下再存 */
  | 'wait'

export function autoSaveVerdict(input: {
  tab: AutoSaveTab
  dirty: boolean
  /** 上次自动保存失败时的内容；没改过就不再试（失败原因已经显示在标签页上） */
  failedDraft: string | undefined
  sessions: readonly AutoSaveSession[]
  caseInsensitive: boolean
}): AutoSaveVerdict {
  const { tab } = input
  if (!input.dirty || tab.document?.kind !== 'text' || tab.document.readonly) return 'skip'
  if (tab.loading || tab.saving || tab.external) return 'skip'
  if (input.failedDraft === tab.draft) return 'skip'
  if (aiBusyFor(tab, input.sessions, input.caseInsensitive)) return 'wait'
  return 'save'
}
