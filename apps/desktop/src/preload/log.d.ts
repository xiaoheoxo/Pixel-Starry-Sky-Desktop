// 本机日志：设置 › 日志用（docs/ui/logging.md §4.7）
import type { LogEntry, LogQuery, LogSettings } from '@pixelsky/protocol'
import type { RendererMemorySample } from '../shared/types/memory'

/** 画面停止 / 恢复刷新（docs/ui/logging.md §4.9）：页面量的数，主进程补上窗口状态和各进程内存再写 */
export interface FrameReport {
  state: 'stalled' | 'recovered'
  stalledMs: number
  sinceInputMs?: number
  sinceVisibleMs?: number
  elements?: number
  heapMb?: number
  inactiveDuring?: boolean
}

export interface LogBridge {
  /** 按条件读最近的条目（跨重启，从文件读），按时间先后 */
  read(query: LogQuery): Promise<LogEntry[]>
  /** 实时条目；返回取消订阅 */
  onEntry(callback: (entry: LogEntry) => void): () => void
  settings(): Promise<LogSettings>
  /** 打开或关闭详细日志（打开后 24 小时自动关闭） */
  setVerbose(on: boolean): Promise<LogSettings>
  openFolder(): Promise<void>
  /** 弹保存对话框写诊断文件；取消时为 null */
  exportDiagnostics(): Promise<string | null>
  /** 渲染进程报错写进日志（限流） */
  write(level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void
  /** 界面里的 React 根被未接住的错误卸载（白屏）：通知主进程按崩溃处理，自动重新加载 */
  uncaught(): void
  /** 画面停止 / 恢复刷新（不占 write 的限额，主进程另有限流） */
  frames(report: FrameReport): void
  /** 内存采样（docs/ui/renderer-memory.md §3.2）：界面的数，主进程补上自己那边的；回复下一次采样的间隔 */
  sample(sample: RendererMemorySample): Promise<{ intervalMs: number; freeMb?: number }>
}
