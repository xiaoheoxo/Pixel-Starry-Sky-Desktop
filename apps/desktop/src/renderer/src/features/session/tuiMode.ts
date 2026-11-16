// 会话界面 ⇄ 终端（TUI）切换（docs/ui/tui-toggle.md）
import type { EngineId, SessionRecord, SessionSnapshot } from '@pixelsky/protocol'
import type { TranslationKey } from '@/i18n/core'
import { stopTargets } from './live/subagentStop'

export type TuiMode = 'ui' | 'terminal'

export const DEMO_TUI_TERMINAL_ID = 'demo-tui'

export function tuiActive(record: SessionRecord | null | undefined): boolean {
  return record?.tui != null
}

export function tuiModeOf(record: SessionRecord | null | undefined): TuiMode {
  return tuiActive(record) ? 'terminal' : 'ui'
}

/** 能切到终端的引擎（宿主 host/index.ts 的 TUI_ENGINES 要一起改）；除 Pixel 外都能「从 /resume 导入」 */
export const TUI_ENGINES = ['claude', 'codex', 'antigravity', 'pixel'] as const
export type TuiEngine = (typeof TUI_ENGINES)[number]
export const isTuiEngine = (engine: EngineId | undefined): engine is TuiEngine =>
  (TUI_ENGINES as readonly string[]).includes(engine ?? '')

/** 顶栏要不要画开关：TUI_ENGINES 里的引擎显示；无记录不画 */
export function tuiToggleVisible(record: SessionRecord | null | undefined): boolean {
  return isTuiEngine(record?.engine)
}

/** 开关能不能点：灰着时返回原因（i18n key），能点返回 null。外部占用由主进程的 tuiCheck 另查 */
export function tuiDisabledReason(snapshot: SessionSnapshot | null | undefined): TranslationKey | null {
  if (!snapshot) return 'session.tui.disabledBusy'
  const { record, state, queue, pending } = snapshot
  if (!isTuiEngine(record.engine)) return 'session.tui.disabledEngine'
  if (record.tui) return null // 已在终端：不因自己的 TUI 变灰
  // Codex 不能预先指定线程 id，界面进程也不能 warm（切之前落实不了回退 / 分叉）：先在界面里发一条消息
  if (record.engine === 'codex' && (!record.engineSessionId || record.pendingRewind || record.pendingFork))
    return 'session.tui.disabledFresh'
  // 后台子智能体还在跑也不行：切过去要关界面进程，会把它们一起停掉
  if (state !== 'idle' || queue.length > 0 || (pending?.length ?? 0) > 0 || stopTargets(snapshot).length > 0)
    return 'session.tui.disabledBusy'
  // Claude 的 pendingRewind/Fork：切终端时由 prepareTui 起一次进程落实，不在这里灰掉
  return null
}

/** 主进程 tuiCheck 返回的原因代码（engine/host 的 TuiBlock）→ 文字；不认识的代码当能切 */
const BLOCK_KEY: Record<string, TranslationKey> = {
  engine: 'session.tui.disabledEngine',
  fresh: 'session.tui.disabledFresh',
  busy: 'session.tui.disabledBusy',
  liveTerminal: 'session.tui.disabledLiveTerminal',
  liveOther: 'session.tui.disabledLiveOther',
}

export const tuiBlockKey = (code: string | null): TranslationKey | null => (code ? (BLOCK_KEY[code] ?? null) : null)

/** tuiCheck 的提示代码（能切，但要先知道）：noNode 是 Pixel 切过去要先下载 Node.js（§12.8） */
export const tuiNeedsNode = (code: string | null): boolean => code === 'noNode'

export function isTuiRunningError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string; message?: string }
  return e.code === 'tui.running' || e.message === 'tui.running'
}

export function isDemoTuiTerminal(terminalId: string | null | undefined): boolean {
  return terminalId === DEMO_TUI_TERMINAL_ID
}

/**
 * 「终端还在运行，结束并切回？」等确认的会话。顶栏和对话区各有一份 useTuiToggle，确认框只在对话区画：
 * 状态放这里共用，顶栏开关碰到 tui.running 时对话区那份也能弹出来
 */
const confirming = new Set<string>()
const confirmListeners = new Set<() => void>()
export const tuiConfirm = {
  has: (sessionId: string): boolean => confirming.has(sessionId),
  set(sessionId: string, on: boolean): void {
    if (on === confirming.has(sessionId)) return
    if (on) confirming.add(sessionId)
    else confirming.delete(sessionId)
    for (const listener of confirmListeners) listener()
  },
  subscribe(listener: () => void): () => void {
    confirmListeners.add(listener)
    return () => confirmListeners.delete(listener)
  },
}
