// 「接着 Claude Code / Codex 会话」选择框的打开请求：输入框、命令面板都往这里放，ResumeHost 接住并显示
import { useSyncExternalStore } from 'react'
import type { SessionSettings } from '@pixelsky/protocol'

/** 能接着聊的引擎 */
export type ResumeEngine = 'claude' | 'codex'
export const RESUME_ENGINE_NAMES: Record<ResumeEngine, string> = { claude: 'Claude Code', codex: 'Codex' }

export interface ResumeRequest {
  /** 每次打开请求不同（openResumePicker 填）：ResumeHost 拿它当 key，请求变了就重建选择框 */
  key?: number
  /** 列哪个引擎的会话（输入框传当前执行者，命令面板传自己那条的引擎） */
  engine: ResumeEngine
  /** 列哪个项目的会话；null（没有项目）时选择框只提示先打开项目 */
  projectId: string | null
  /** 预先填进搜索框的关键词（`/resume 关键词`） */
  query?: string
  /** `/resume <完整 uuid>`：不弹列表，直接走选中之后的流程 */
  id?: string | null
  /**
   * 输入框当前的设置（模型、额度来源、权限、推理强度）；命令面板没有，用引擎默认。
   * 选中时才调用，拿输入框最新的状态；输入框还没准备好（刚启动）时返回 undefined
   */
  settingsFor?: (sessionModel: string | null) => Partial<SessionSettings> | undefined
  /** 现在的执行者（选中时调用）；和 engine 对不上说明打开之后被换了，不导入；拿不到（输入框没准备好）返回 undefined */
  executorNow?: () => string | undefined
  /** 新对话打开之后（输入框清掉 /resume） */
  onOpened?: () => void
  /** 关闭之后（把焦点还给输入框） */
  onClosed?: () => void
}

let request: ResumeRequest | null = null
let seq = 0
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach(l => l())

export function openResumePicker(next: ResumeRequest): void {
  request = { ...next, key: ++seq }
  emit()
}

/** restoreFocus 为 false 时（打开了新对话）不把焦点还给原来的输入框 */
export function closeResumePicker(opts: { restoreFocus?: boolean } = {}): void {
  const old = request
  request = null
  emit()
  if (opts.restoreFocus !== false) old?.onClosed?.()
}

export function useResumeRequest(): ResumeRequest | null {
  return useSyncExternalStore(
    l => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => request,
  )
}
