// 右栏「概况」：当前窗格那个会话的摘要和常用操作（规则 docs/ui/desktop-parity.md §3.1，样稿 docs/ui/session-overview-mockup.html）
import { Fragment, type ComponentType } from 'react'
import { LayoutDashboard } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, type TranslationKey } from '@/i18n/core'
import { useEngineState } from '@/features/engine'
import { usePaneState } from '@/features/panes/store'
import { focusedTab } from '@/features/panes/tree'
import { sessionTab } from '../connectors/ConnectorsPanel'
import { EmptyState, PanelCard } from '../PanelSurface'
import { setOverviewSlot } from '../overviewSlot'
import { AttentionSection } from './AttentionSection'
import { ChangesSection } from './ChangesSection'
import { ChecksSection } from './ChecksSection'
import { ContextSection } from './ContextSection'
import { EnvSection } from './EnvSection'
import { LoadedSection } from './LoadedSection'
import { McpSection } from './McpSection'
import { useOverviewMcp, type OverviewMcp } from './overviewData'
import { useOverviewPrefs } from './overviewPrefs'
import { PrSection } from './PrSection'
import { ProgressSection } from './ProgressSection'
import { TasksSection } from './TasksSection'
import { UsageSection } from './UsageSection'

export interface SectionProps {
  sessionId: string
  /** 面板看得见：看不见时什么都不订阅 */
  active: boolean
  mcp: OverviewMcp
}

/** 从上到下的顺序，滑杆菜单也按它列。加一块就是加一行；没数据时组件自己返回 null */
export const OVERVIEW_SECTIONS: readonly {
  id: string
  title: TranslationKey
  Component: ComponentType<SectionProps>
}[] = [
  { id: 'attention', title: 'overview.attention', Component: AttentionSection },
  { id: 'progress', title: 'session.progress.title', Component: ProgressSection },
  { id: 'changes', title: 'overview.changes', Component: ChangesSection },
  { id: 'checks', title: 'checks.title', Component: ChecksSection },
  { id: 'pr', title: 'overview.pr', Component: PrSection },
  { id: 'tasks', title: 'engine.labels.backgroundTask', Component: TasksSection },
  { id: 'mcp', title: 'overview.mcp', Component: McpSection },
  { id: 'context', title: 'session.ContextWindowButton.context2', Component: ContextSection },
  { id: 'usage', title: 'overview.usage', Component: UsageSection },
  { id: 'loaded', title: 'overview.loaded', Component: LoadedSection },
  { id: 'env', title: 'workspace.sandbox', Component: EnvSection },
]

const NOTE = 'rounded-lg border border-dashed border-line-card px-3 py-2.5 text-meta text-fg-muted'

export function OverviewPanel({ active }: { active: boolean }) {
  useI18n()
  const tab = usePaneState(s => focusedTab(s.layout))
  const sessionId = sessionTab(tab)
  if (!sessionId)
    return (
      <div className="flex min-h-0 flex-1 p-3">
        <PanelCard>
          <EmptyState icon={LayoutDashboard} title={tr('connectors.noSession')} hint={tr('overview.noSessionHint')} />
        </PanelCard>
      </div>
    )
  // key：各分组里的状态（读到的服务、展开的行、要确认的压缩）都是这个会话的
  return <SessionOverview key={sessionId} sessionId={sessionId} active={active} />
}

function SessionOverview({ sessionId, active }: { sessionId: string; active: boolean }) {
  const { hidden } = useOverviewPrefs()
  const mcp = useOverviewMcp(sessionId, active)
  // 用的是当前窗格已经持有的快照（SessionView 的 useSession），不用再 retain；也不用整个 snapshot，它每来一个字都变
  const fresh = useEngineState(s => active && s.snapshots[sessionId]?.items.length === 0)
  return (
    <div
      data-overview-list
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5 [scrollbar-width:thin] [&>*]:shrink-0"
    >
      {fresh && <div className={NOTE}>{tr('overview.fresh')}</div>}
      {OVERVIEW_SECTIONS.map(({ id, Component }) => (
        <Fragment key={id}>
          {/* 隐藏了进度也留着这个位置：概况开着时卡片仍然停靠过来，只是看不见（样稿 place()） */}
          {id === 'progress' && (
            <div ref={setOverviewSlot} className={hidden.includes(id) ? 'hidden' : 'empty:hidden'} />
          )}
          {!hidden.includes(id) && <Component sessionId={sessionId} active={active} mcp={mcp} />}
        </Fragment>
      ))}
      {OVERVIEW_SECTIONS.every(s => hidden.includes(s.id)) && <div className={NOTE}>{tr('overview.allHidden')}</div>}
    </div>
  )
}
