// 从编辑器等地方往会话输入框里放内容（docs/ui/editor-quote.md §2）：找哪个输入框、放完把光标移过去
import { composerInputFor } from './composerInput/ComposerInput'
import { isLive } from '@/features/engine'
import { getEngineState } from '@/features/engine/store'
import { getPaneState } from '@/features/panes/store'
import { focusedTab, isFileTab, visibleTabs } from '@/features/panes/tree'
import { tuiModeOf } from './tuiMode'

export interface ComposerTarget {
  /** 输入框的草稿键（appendComposerDraft 用） */
  key: string
  /** 会话的工作目录；新任务还没开始时为 null */
  cwd: string | null
}

/** 当前焦点的会话输入框；焦点在文件标签上时找另一个能看到的会话。没有时为 null */
export function composerTarget(): ComposerTarget | null {
  const layout = getPaneState().layout
  const focused = focusedTab(layout)
  const recordOf = (id: string) => getEngineState().sessions.find(s => s.record.id === id)?.record
  // 终端（TUI）模式的会话不挂输入框，放进去的草稿用户看不到
  const usable = (id: string): boolean => !isFileTab(id) && tuiModeOf(recordOf(id)) !== 'terminal'
  const tab = focused && usable(focused) ? focused : visibleTabs(layout).find(usable)
  if (!tab) return null
  const record = recordOf(tab)
  return { key: isLive ? tab : `demo:${tab}`, cwd: record?.cwd ?? null }
}

/** 把光标放到这个输入框的末尾（输入框要在页面上） */
export function focusComposer(key: string): void {
  // 等这次渲染把追加的草稿写进输入框
  requestAnimationFrame(() => composerInputFor(key)?.focusEnd())
}
