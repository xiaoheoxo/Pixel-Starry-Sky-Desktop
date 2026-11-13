// 右栏「概况」：当前窗格那个会话的摘要和常用操作（规则 docs/ui/desktop-parity.md §3.1，样稿 docs/ui/session-overview-pill-mockup.html）
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
import { OutputsSection } from './OutputsSection'
import { useOverviewMcp, type OverviewMcp } from './overviewData'
import { useOverviewPrefs } from './overviewPrefs'
import { PrSection } from './PrSection'
import { ProgressSection } from './ProgressSection'
import { StatusGroup } from './Section'
import { SessionHead } from './SessionHead'
import { TasksSection } from './TasksSection'
import { UsageSection } from './UsageSection'

export interface SectionProps {
  sessionId: string
  /** 面板看得见：看不见时什么都不订阅 */
  active: boolean
  mcp: OverviewMcp
}

/** 从上到下的顺序，显示设置菜单也按它列。加一块就是加一行；没数据时组件自己返回 null */
export const OVERVIEW_SECTIONS: readonly {
  id: string
  title: TranslationKey
  Component: ComponentType<SectionProps>
}[] = [
  { id: 'attention', title: 'overview.attention', Component: AttentionSection },
  { id: 'env', title: 'workspace.sandbox', Component: EnvSection },
  { id: 'context', title: 'session.ContextWindowButton.context2', Component: ContextSection },
  { id: 'usage', title: 'overview.usage', Component: UsageSection },
  { id: 'mcp', title: 'overview.mcp', Component: McpSection },
  { id: 'loaded', title: 'overview.loaded', Component: LoadedSection },
  { id: 'progress', title: 'session.progress.title', Component: ProgressSection },
  { id: 'changes', title: 'overview.changes', Component: ChangesSection },
  { id: 'outputs', title: 'overview.outputs', Component: OutputsSection },
  { id: 'checks', title: 'checks.title', Component: ChecksSection },
  { id: 'pr', title: 'overview.pr', Component: PrSection },
  { id: 'tasks', title: 'engine.labels.backgroundTask', Component: TasksSection },
]

/** 这几项合成「状态」一组，每项一行；显示设置里仍是分开的四项 */
const STATUS_IDS = ['context', 'usage', 'mcp', 'loaded']

/** 「全部折叠」收哪些：「要处理」不收 */
export const FOLDABLE_IDS = [
  'status',
  ...OVERVIEW_SECTIONS.map(s => s.id).filter(id => id !== 'attention' && !STATUS_IDS.includes(id)),
]

/** 列表里的说明：和分组一样是一张卡片 */
const NOTE = 'rounded-2xl bg-ov-card px-3 py-2.5 text-meta text-fg-muted'

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
  const shown = (id: string): boolean => !hidden.includes(id)
  const render = ({ id, Component }: (typeof OVERVIEW_SECTIONS)[number]) => (
    <Component key={id} sessionId={sessionId} active={active} mcp={mcp} />
  )
  return (
    <div data-overview className="flex min-h-0 flex-1 flex-col">
      {active && <SessionHead sessionId={sessionId} fresh={fresh} />}
      <div
        data-overview-list
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2.5 pb-4 [scrollbar-width:thin] [&>*]:shrink-0"
      >
        {OVERVIEW_SECTIONS.map(section => {
          const { id } = section
          if (STATUS_IDS.includes(id))
            return id === STATUS_IDS[0] ? (
              <StatusGroup key="status">
                {OVERVIEW_SECTIONS.filter(s => STATUS_IDS.includes(s.id) && shown(s.id)).map(render)}
              </StatusGroup>
            ) : null
          return (
            <Fragment key={id}>
              {/* 隐藏了进度也留着这个位置：概况开着时卡片仍然停靠过来，只是看不见。卡片的底色和圆角在这，停靠的进度卡片自己不画框 */}
              {id === 'progress' && (
                <div
                  ref={setOverviewSlot}
                  data-overview-section="progress"
                  className={shown(id) ? 'rounded-2xl bg-ov-card px-1.5 pt-1 pb-2.5 empty:hidden' : 'hidden'}
                />
              )}
              {shown(id) && render(section)}
            </Fragment>
          )
        })}
        {fresh && <div className={NOTE}>{tr('overview.fresh')}</div>}
        {OVERVIEW_SECTIONS.every(s => hidden.includes(s.id)) && <div className={NOTE}>{tr('overview.allHidden')}</div>}
      </div>
    </div>
  )
}
