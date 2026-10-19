import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { cn } from '@/ui'
import { SessionMarks, SessionStatusMark, StatusLabel, ringOf } from './SessionMarks'
import { StatusHover } from './SessionStatusCard'
import { useRowStatus } from './useRowStatus'
import type { SessionCard, SessionLane } from '@/features/board/sessionLanes'
import { LANE_LABEL, LANE_TONE } from './RunStatusPill'
import type { Session } from '@/data'
import { SessionRow } from './SessionRow'
import { useSessionChannel } from '@/features/channels/store'

/**
 * 项目下面的对话（docs/ui/sidebar-styles.md「大文件夹」版）：标题和项目名对齐，状态挂在项目文件夹图标正下方，
 * 右边是时间（有问题的写「等你 / 要登录 / 出错…」）；新回复的标题用主色加粗，当前打开的有底色。
 * 状态格放什么见 sessionStatusModel.statusOf（docs/ui/sidebar-status-icons.md），鼠标停上去弹出详情和操作
 */
export function SessionItem({
  session,
  selected,
  onSelect,
  lane,
  card,
  reason,
  flipKey,
}: {
  session: Session
  selected: boolean
  onSelect: (id: string) => void
  /** 看板 / 胶囊里的分类，决定标题左边的状态 */
  lane?: SessionLane
  /** 看板卡片（等你批准的请求、错误原文、队列）；没有要处理的就没有 */
  card?: SessionCard
  /** 侧栏按状态筛选时：右边写原因（等你处理 / 出错 / 运行中…），代替时间 */
  reason?: boolean
  /** 换顺序时滑动用的标记（useFlip），见 SessionRow */
  flipKey?: string
}) {
  useI18n()
  const running = session.status === 'running'
  const unread = session.status === 'unread'
  const fresh = unread || lane === 'unread'
  // 协作频道派活开出来的会话（docs/ui/channels-phase-b.md §2.4）
  const channel = useSessionChannel(session.id)
  const status = useRowStatus(session.id, { card, running, unread })
  const ring = ringOf(selected)
  return (
    <SessionRow
      target={{
        id: session.id,
        title: session.title,
        bottomed: !!session.bottomedAt,
        pinned: !!session.pinnedAt,
        archived: !!session.archivedAt,
        running,
      }}
      selected={selected}
      onSelect={onSelect}
      flipKey={flipKey}
      className="[&>button]:pl-[28px]"
      trailing={
        reason && lane ? (
          <span className={cn('shrink-0 text-meta', LANE_TONE[lane])}>{tr(LANE_LABEL[lane])}</span>
        ) : status.label ? (
          <StatusLabel status={status} ring={ring} />
        ) : (
          <SessionMarks running={running} unread={unread} time={session.time} status={status} ring={ring} />
        )
      }
    >
      {status.mark && (
        <StatusHover
          sessionId={session.id}
          title={session.title}
          status={status}
          card={card}
          className="absolute left-[5px] flex w-3.5 items-center justify-center"
        >
          <SessionStatusMark status={status} ring={ring} />
        </StatusHover>
      )}
      <span className={cn('min-w-0 truncate', !channel && 'flex-1', fresh && 'font-semibold text-accent-fg')}>
        {session.title}
      </span>
      {channel && <span className="max-w-[45%] shrink-0 truncate text-meta text-fg-faint"># {channel}</span>}
    </SessionRow>
  )
}
