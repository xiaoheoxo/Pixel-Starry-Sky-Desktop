import { useI18n } from '@/i18n/I18nProvider'
import { useMemo } from 'react'
import { Dot } from '@/ui'
import { projects, type RecentItem as Recent, type SessionStatus } from '@/data'
import { SessionRow } from './SessionRow'
import { StatusGlyph, ringOf } from './SessionMarks'
import { StatusHover } from './SessionStatusCard'
import { statusOf as sessionStatusOf } from './sessionStatusModel'
import { useSessionStatus } from './useSessionStatus'

/** 最近任务如果同时是某个项目下的会话，就沿用它的状态 */
function statusOf(id: string): SessionStatus {
  for (const p of projects) {
    const s = p.sessions.find(x => x.id === id)
    if (s) return s.status
  }
  return 'idle'
}

const DOT_TONE = { idle: 'muted', running: 'success', unread: 'accent' } as const

/** 最近任务：左边 6px 状态圆点，中间标题，右边时间；有 PR 时标题后面是真的 PR 图标（鼠标停上去看详情） */
export function RecentItem({
  item,
  status,
  selected,
  onSelect,
}: {
  item: Recent
  /** 不传时从演示数据里找 */
  status?: SessionStatus
  selected: boolean
  onSelect: (id: string) => void
}) {
  useI18n()
  const prs = useSessionStatus().prs[item.id]
  const prStatus = useMemo(() => sessionStatusOf({ running: false, unread: false, prs }), [prs])
  return (
    <SessionRow
      target={{
        id: item.id,
        title: item.title,
        bottomed: !!item.bottomedAt,
        pinned: !!item.pinnedAt,
        archived: false,
        running: (status ?? statusOf(item.id)) === 'running',
      }}
      selected={selected}
      onSelect={onSelect}
      flipKey={`recent/${item.id}`}
      trailing={<span className="shrink-0 text-meta text-fg-faint">{item.time}</span>}
      className="gap-2.5"
    >
      <span className="flex w-4 shrink-0 justify-center">
        <Dot tone={DOT_TONE[status ?? statusOf(item.id)]} size={6} />
      </span>
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
      {prStatus.pr && (
        <StatusHover sessionId={item.id} title={item.title} status={prStatus} className="flex shrink-0">
          <StatusGlyph kind={prStatus.mark ?? 'pr'} pr={prStatus.pr} size={14} ring={ringOf(selected)} />
        </StatusHover>
      )}
    </SessionRow>
  )
}
