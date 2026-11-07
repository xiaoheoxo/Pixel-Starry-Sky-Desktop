import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { useToast } from '@/ui'
import { bridge } from '@/features/engine'
import { getActiveWorkspace } from '@/features/editor/target'
import { checkAttentionKey, setDismissed } from '@/features/panel/overview/attentionDismissed'
import { fixRequest, type CheckRun } from '../../../../shared/types/checks'
import { CheckSummary } from './CheckSummary'
import { useSessionCheck } from './sessionChecks'

/** 发一条消息让会话去修。先从「要处理」里拿掉，免得再点一次发两遍；没发出去放回来 */
export async function sendFix(
  sessionId: string,
  text: string,
  attentionKey: string,
  toast: (message: string) => void,
): Promise<void> {
  setDismissed(attentionKey, true)
  if (!bridge) return toast(tr('session.ContextWindowButton.engineActionsAreUnavailable'))
  await bridge.send(sessionId, { text, clientMessageId: crypto.randomUUID() }).catch(e => {
    setDismissed(attentionKey, false)
    toast(tr('checks.fixFailed', { error: translateMessage((e as Error).message) }))
  })
}

/** 「让它修」：把失败的部分发给会话 */
export function sendCheckFix(sessionId: string, run: CheckRun, toast: (message: string) => void): Promise<void> {
  return sendFix(sessionId, fixRequest(run), checkAttentionKey(run.id), toast)
}

/** 在内置浏览器打开。和 PortTip 一样：浏览器标签跟着右侧面板当前的工作区走 */
export function openSessionPage(sessionId: string, url: string): void {
  window.dispatchEvent(
    new CustomEvent('pixelsky:open-browser', {
      detail: { ref: getActiveWorkspace().ref ?? { sessionId }, url },
    }),
  )
}

/** 输入框上方：这个会话上一轮的自动检查（docs/ui/channels-collab-v2.md §8）；「让它修」把失败的部分发给会话 */
export function SessionCheckBar({ sessionId }: { sessionId: string | null }) {
  useI18n()
  const toast = useToast()
  const run = useSessionCheck(sessionId)
  if (!run || !sessionId) return null
  return (
    <section data-session-check="" className="mb-2 rounded-lg border border-line-card bg-surface px-3 py-1.5">
      <CheckSummary
        run={run}
        onFix={() => sendCheckFix(sessionId, run, toast)}
        onOpenPage={url => openSessionPage(sessionId, url)}
      />
    </section>
  )
}
