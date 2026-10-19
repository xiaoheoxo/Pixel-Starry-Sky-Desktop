// 开设置独立窗口时，主窗口里「先记一笔、设置页打开后取走」的请求怎么带过去、在设置窗口里怎么放回来。
// 这几处都存在模块内存里（models/scroll、extstore/nav、engines/nav、logs/focus、feedback/focus），不会跨窗口。
import type { SettingsHints } from '../../../../shared/types/settings-window'
import { consumeExtSearchFocus, getExtTab, openExtSearch, openExtTab } from '@/features/extstore/nav'
import { requestFeedback, takeFeedbackFocus, type FeedbackTarget } from '@/features/feedback/focus'
import { restoreLogFocus, takeLogFocus } from '@/features/logs/focus'
import { getEngineDetail, openEngineDetail } from './engines/nav'
import { requestModelsScroll, takeModelsScroll } from './models/scroll'

/** 取走这个窗口里记下的请求（取走就清掉，之后在这个窗口里不会再触发） */
export function collectSettingsHints(): SettingsHints | undefined {
  const logFocus = takeLogFocus()
  const feedback = takeFeedbackFocus()
  const extTab = getExtTab()
  const engineDetail = getEngineDetail()
  const hints: SettingsHints = {
    ...(takeModelsScroll() && { modelsScroll: true as const }),
    ...(extTab !== 'installed' && { extTab }),
    ...(consumeExtSearchFocus() && { extSearch: true as const }),
    ...(engineDetail && { engineDetail }),
    ...(logFocus && { logFocus }),
    ...(feedback && { feedback: feedback as Record<string, unknown> }),
  }
  // 带走了就别留在这个窗口里：不然下次不管从哪打开都又带一遍
  if (extTab !== 'installed') openExtTab('installed')
  if (engineDetail) openEngineDetail(null)
  return Object.keys(hints).length ? hints : undefined
}

/** 在设置窗口里把带来的请求放回各自的模块（设置页挂载或收到后取走） */
export function applySettingsHints(hints: SettingsHints | undefined): void {
  if (!hints) return
  if (hints.modelsScroll) requestModelsScroll()
  if (hints.extTab) openExtTab(hints.extTab)
  if (hints.extSearch) openExtSearch()
  if (hints.engineDetail) openEngineDetail(hints.engineDetail as Parameters<typeof openEngineDetail>[0])
  if (hints.logFocus) restoreLogFocus(hints.logFocus)
  if (hints.feedback) requestFeedback(hints.feedback as FeedbackTarget)
}
