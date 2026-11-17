import { useEffect, useRef } from 'react'
import { isLive, setViewingSet, useEngineState } from '@/features/engine'
import { useAppMode } from '@/features/coding/mode'
import { usePage } from '@/features/layout/page'
import { paneActions, usePaneState } from './store'
import { focusedTab, isFileTab, isNewTab, visibleTabs } from './tree'
import { useDots } from '@/features/dot/store'
import { dotSessionIds } from '@/features/dot/visibility'

/**
 * 窗格的后台维护，不管当前是对话模式还是代码模式都要跑（原来在 Workspace 里，代码模式下 Workspace 不挂载）：
 * 1. 标记「正在看」的会话，回复完不标新回复；
 * 2. 引擎读出会话列表后，去掉已经不存在的会话标签（只做一次）；
 * 3. 核对过本机没登录 ChatGPT Pro（登出、换成 Plus）时关掉 Dot 的标签（docs/ui/dot-optimize.md §2）。
 */
export function usePaneHousekeeping(): void {
  const mode = useAppMode()
  const page = usePage()
  // 对话模式：所有窗格里正在显示的会话都算「正在看」
  const visibleKey = usePaneState(s =>
    mode === 'code'
      ? // 代码模式只有右栏的焦点会话可见
        (() => {
          const tab = focusedTab(s.layout)
          return tab && !isNewTab(tab) && !isFileTab(tab) ? tab : ''
        })()
      : visibleTabs(s.layout)
          .filter(t => !isNewTab(t) && !isFileTab(t))
          .join('|'),
  )
  // 在协作频道页时没有会话算「正在看」，后台回复完照常标新回复（docs/ui/channels.md §2）
  useEffect(() => setViewingSet(page === 'workbench' && visibleKey ? visibleKey.split('|') : []), [visibleKey, page])

  // 真实引擎读出会话列表后，去掉已经不存在的会话标签（只做一次）
  const ready = useEngineState(s => s.ready)
  const sessions = useEngineState(s => s.sessions)
  const pruned = useRef(false)
  useEffect(() => {
    if (!isLive || !ready || pruned.current) return
    pruned.current = true
    const ids = new Set(sessions.map(s => s.record.id))
    paneActions.prune(tab => isNewTab(tab) || ids.has(tab))
  }, [ready, sessions])

  const dots = useDots()
  useEffect(() => {
    if (!isLive || !ready || !dots.checked || dots.eligible) return
    const ids = dotSessionIds(sessions)
    if (ids.size) paneActions.prune(tab => !ids.has(tab))
  }, [ready, sessions, dots.checked, dots.eligible])
}
