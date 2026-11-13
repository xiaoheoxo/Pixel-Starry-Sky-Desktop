// 「概况」标签上的提醒点（docs/ui/desktop-parity.md §3.1）：右栏开着别的标签时，当前会话有要你动手的。
// 只算 store 里现成的：等审批、检查没过、上下文到 90%；MCP、PR、额度要打开概况才读，不算
import type { ApprovalRequest } from '@pixelsky/protocol'
import { useSessionCheck } from '@/features/checks/sessionChecks'
import { useEngineState } from '@/features/engine'
import { usePaneState } from '@/features/panes/store'
import { focusedTab } from '@/features/panes/tree'
import { sessionTab } from '../connectors/ConnectorsPanel'
import { useDismissed } from './attentionDismissed'
import { attentionItems } from './overviewModel'

const NO_PENDING: ApprovalRequest[] = []

export function useOverviewAlert(enabled: boolean): boolean {
  const tab = usePaneState(s => focusedTab(s.layout))
  const sessionId = enabled ? sessionTab(tab) : null
  const pending = useEngineState(s => (sessionId ? s.snapshots[sessionId]?.pending : undefined)) ?? NO_PENDING
  const context = useEngineState(s => (sessionId ? (s.snapshots[sessionId]?.context ?? null) : null))
  const check = useSessionCheck(sessionId)
  const dismissed = useDismissed()
  if (!sessionId) return false
  return (
    attentionItems({
      pending,
      cwd: null,
      connectors: [],
      report: null,
      check,
      prs: [],
      context,
      quota: null,
      now: 0,
      dismissed,
    }).length > 0
  )
}
