import { useSyncExternalStore } from 'react'
import type { CodexWorkspaceImportResult } from '../../../../shared/types/codex-import'

export interface CodexImportState {
  running: boolean
  result: CodexWorkspaceImportResult | null
  error: string | null
}

/** 页面卸载不丢失读取任务；同一窗口的重复触发共用 Promise。 */
export class CodexImportStore {
  private state: CodexImportState = { running: false, result: null, error: null }
  private listeners = new Set<() => void>()
  private pending: Promise<void> | null = null

  constructor(private readonly load: () => Promise<CodexWorkspaceImportResult>) {}
  getSnapshot = (): CodexImportState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private set(patch: Partial<CodexImportState>): void {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(listener => listener())
  }
  read = (): Promise<void> => {
    if (this.pending) return this.pending
    this.set({ running: true, error: null })
    const run = this.load()
      .then(
        result => this.set({ result }),
        error => this.set({ error: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => {
        this.pending = null
        this.set({ running: false })
      })
    this.pending = run
    return run
  }
}

const store = new CodexImportStore(async () => {
  const bridge = window.pixelsky?.engine
  if (!bridge) throw new Error('引擎不可用')
  return bridge.importCodexSessions()
})
export const readCodexSessions = store.read
export const useCodexImport = (): CodexImportState =>
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
