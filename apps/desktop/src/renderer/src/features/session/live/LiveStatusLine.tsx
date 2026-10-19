import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
// 运行中这一轮的状态行（docs/ui/motion-proposal.html ②）：转圈 + 在做什么 + 本轮用时 + ›，
// 代替以前「执行」行写动作、底部另写「正在思考…」两处轮流出现。点一下展开 / 收起这一轮的「执行」详情
import { useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import type { Item } from '@pixelsky/protocol'
import { Spinner, cn } from '@/ui'
import { formatDuration } from './agentTrace'
import { clockText, liveStatus, turnElapsed, turnWindow } from './currentStep'
import { useNow } from './stepClock'

export function LiveStatusLine({
  items,
  turnId,
  fold,
}: {
  /** 对话里的全部条目（这里自己取最后一轮） */
  items: readonly Item[]
  /** 正在进行的一轮（snapshot.turnId）：本轮用时按它对应的用户消息算 */
  turnId: string | null
  /** 这一轮有「执行」块时给出展开状态和切换；没有可展开的内容时为 null，行末不画 › */
  fold: { open: boolean; toggle: () => void } | null
}) {
  useI18n()
  const turn = useMemo(() => turnWindow(items, turnId), [items, turnId])
  const status = liveStatus(turn.items)
  const now = useNow(true)
  const elapsed = turnElapsed(turn.startedAt, now)
  const text = status.object ? `${status.verb} ${status.object}` : status.verb
  const body = (
    <>
      <Spinner size={13} />
      <span className={cn('text-fg-secondary', status.object ? 'shrink-0' : 'min-w-0 truncate')}>{status.verb}</span>
      {status.object && (
        <span className="min-w-0 truncate font-mono text-meta text-fg-secondary" title={status.object}>
          {status.object}
        </span>
      )}
      {status.more > 0 && <span className="shrink-0 text-fg-faint">{tr('session.step.more', { n: status.more })}</span>}
      {elapsed !== null && (
        <span className="shrink-0 text-meta text-fg-faint tabular-nums">
          <span aria-hidden className="mr-1.5">
            ·
          </span>
          {tr('session.live.elapsed', { time: clockText(elapsed, formatDuration) })}
        </span>
      )}
    </>
  )
  return (
    <div data-live-status className="conversation-message">
      {fold ? (
        <button
          type="button"
          aria-expanded={fold.open}
          title={tr(fold.open ? 'session.process.collapse' : 'session.process.expand')}
          onClick={fold.toggle}
          className="flex h-[30px] max-w-full min-w-0 items-center gap-2 rounded-md px-2 text-list text-fg-muted hover:bg-hover hover:text-fg-secondary"
        >
          {body}
          <ChevronRight
            size={15}
            strokeWidth={1.5}
            className={cn('shrink-0 transition-transform duration-(--dur-fast)', fold.open && 'rotate-90')}
          />
        </button>
      ) : (
        <div className="flex h-[30px] max-w-full min-w-0 items-center gap-2 px-2 text-list text-fg-muted" title={text}>
          {body}
        </div>
      )}
    </div>
  )
}
