import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { useMemo, useState } from 'react'
import type { Session } from '@/data'
import { useSessionCards } from '@/features/board/useSessionCards'
import { cardsOf, lanesOf } from './runFilter'
import { SessionItem } from './SessionItem'
import { ArchivedRows, MoreRow } from './ProjectTree'
import { extraConversations, nextBatchCount, visibleSessions } from './projectTreeModel'

/** 侧栏「对话」分组：不用项目的对话，和项目下面的对话一样先列 5 个，其余分批收进「还有 N 个对话」，归档的收进「已归档 N 个」 */
export function ChatList({
  chats,
  archived,
  selectedSessionId,
  onSelectSession,
  filtering = false,
  expandedPages,
  onExpandMore,
  onExpandAll,
  onCollapseMore,
}: {
  chats: Session[]
  /** 归档了的对话；按状态筛选时传空 */
  archived: Session[]
  selectedSessionId: string | null
  onSelectSession: (id: string) => void
  /** 侧栏按状态筛选时：全部列出，右边写原因 */
  filtering?: boolean
  /** 由侧栏统一协调的手风琴展开批数（不传时退回本组件局部状态） */
  expandedPages?: number
  onExpandMore?: () => void
  onExpandAll?: () => void
  onCollapseMore?: () => void
}) {
  useI18n()
  const cards = useSessionCards()
  const lanes = useMemo(() => lanesOf(cards), [cards])
  const cardById = useMemo(() => cardsOf(cards), [cards])
  const [localPages, setLocalPages] = useState(0)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [archivedShown, setArchivedShown] = useState<number>()

  const pages = expandedPages ?? localPages
  const preview = visibleSessions(chats, { all: filtering, selected: selectedSessionId, lanes })
  const { shown, hidden } = pages
    ? visibleSessions(chats, {
        all: filtering || !Number.isFinite(pages),
        additional: extraConversations(pages),
        selected: selectedSessionId,
        lanes,
      })
    : preview

  const expandMore = onExpandMore ?? (() => setLocalPages(p => p + 1))
  const expandAll = onExpandAll ?? (() => setLocalPages(Infinity))
  const collapseMore = onCollapseMore ?? (() => setLocalPages(0))

  return (
    <div data-chat-sessions className="flex flex-col gap-px">
      {shown.map(s => (
        <SessionItem
          key={s.id}
          session={s}
          selected={s.id === selectedSessionId}
          onSelect={onSelectSession}
          lane={lanes.get(s.id)}
          card={cardById.get(s.id)}
          reason={filtering}
          flipKey={`chat/${s.id}`}
        />
      ))}
      {!filtering && preview.hidden > 0 && (
        <MoreRow
          label={hidden > 0 ? tr('sidebar.tree.more', { count: hidden }) : tr('sidebar.tree.less')}
          open={!hidden}
          title={hidden > 0 ? tr('sidebar.tree.moreHint', { batch: nextBatchCount(pages, hidden) }) : undefined}
          onClick={() => (hidden > 0 ? expandMore() : collapseMore())}
          onShowAll={hidden > 0 ? expandAll : undefined}
          onCollapse={hidden > 0 && pages > 0 ? collapseMore : undefined}
        />
      )}
      <ArchivedRows
        archived={archived}
        scope={{ kind: 'chat' }}
        selectedSessionId={selectedSessionId}
        onSelectSession={onSelectSession}
        open={archivedOpen}
        onToggle={() => setArchivedOpen(!archivedOpen)}
        limit={archivedShown}
        onMore={setArchivedShown}
      />
    </div>
  )
}
