import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { useToast } from '@/ui'
import { bridge } from '@/features/engine'
import { getActiveWorkspace } from '@/features/editor/target'
import { fixRequest } from '../../../../shared/types/checks'
import { CheckSummary } from './CheckSummary'
import { useSessionCheck } from './sessionChecks'

/** 输入框上方：这个会话上一轮的自动检查（docs/ui/channels-collab-v2.md §8）；「让它修」把失败的部分发给会话 */
export function SessionCheckBar({ sessionId }: { sessionId: string | null }) {
  useI18n()
  const toast = useToast()
  const run = useSessionCheck(sessionId)
  if (!run || !sessionId) return null
  const fix = async () => {
    if (!bridge) return
    await bridge
      .send(sessionId, { text: fixRequest(run), clientMessageId: crypto.randomUUID() })
      .catch(e => toast(tr('checks.fixFailed', { error: translateMessage((e as Error).message) })))
  }
  return (
    <section data-session-check="" className="mb-2 rounded-lg border border-line-card bg-surface px-3 py-1.5">
      <CheckSummary
        run={run}
        onFix={fix}
        onOpenPage={url =>
          // 和 PortTip 一样：浏览器标签跟着右侧面板当前的工作区走
          window.dispatchEvent(
            new CustomEvent('pixelsky:open-browser', {
              detail: { ref: getActiveWorkspace().ref ?? { sessionId }, url },
            }),
          )
        }
      />
    </section>
  )
}
