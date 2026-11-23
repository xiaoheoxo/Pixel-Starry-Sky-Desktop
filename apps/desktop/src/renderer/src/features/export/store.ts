// 「导出对话」对话框的打开请求：命令面板、对话区右键菜单都往这里放，ExportHost 接住并显示
import { useSyncExternalStore } from 'react'

export interface ExportRequest {
  /** 每次打开请求不同（openExport 填）：请求变了就重建对话框 */
  key?: number
  sessionId: string
  /** 从对话里某条消息打开：范围预选它所在的那一轮 */
  itemId?: string
  /** 一打开就选好的格式：omp 是 oh-my-pi 自己的 HTML */
  format?: 'omp'
}

let request: ExportRequest | null = null
let seq = 0
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach(l => l())

export function openExport(next: ExportRequest): void {
  request = { ...next, key: ++seq }
  emit()
}

export function closeExport(): void {
  request = null
  emit()
}

export function useExportRequest(): ExportRequest | null {
  return useSyncExternalStore(
    l => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => request,
  )
}

// ---- 上次的选择（格式、是否带工具调用 / 思考）----

export interface ExportPrefs {
  format: 'md' | 'html' | 'json'
  tools: boolean
  thinking: boolean
}
const PREFS_KEY = 'pixelsky.export-prefs'
const DEFAULT_PREFS: ExportPrefs = { format: 'md', tools: true, thinking: false }

export function loadPrefs(): ExportPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<ExportPrefs>
    return {
      format: v.format === 'html' || v.format === 'json' || v.format === 'md' ? v.format : DEFAULT_PREFS.format,
      tools: typeof v.tools === 'boolean' ? v.tools : DEFAULT_PREFS.tools,
      thinking: typeof v.thinking === 'boolean' ? v.thinking : DEFAULT_PREFS.thinking,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function savePrefs(prefs: ExportPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // 存不下就算了，下次打开用默认
  }
}
