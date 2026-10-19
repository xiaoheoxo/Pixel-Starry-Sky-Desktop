// 会话列表的一行（首页和抽屉共用，docs/mobile-remote.md §21.3）：引擎头像（角上是状态点）、标题、时间，
// 第二行是项目名和最后一句回复；等你处理、正在回复、出错时第二行换成带颜色的状态。只管画，文字由调用方算好。
import { Pin } from 'lucide-react'
import type { EngineId } from '@pixelsky/protocol'
import { EngineAvatar } from './EngineAvatar'
import { cn } from './index'

export type SessionTone = 'danger' | 'online' | 'warn'
const TEXT: Record<SessionTone, string> = { danger: 'text-danger', online: 'text-online', warn: 'text-warn' }

export function SessionRow({
  engine,
  title,
  time,
  project,
  preview,
  status,
  pinned,
  active,
  dense,
  divider,
  onClick,
}: {
  engine: EngineId
  title: string
  time: string
  /** 项目名；只有一个项目或已按项目筛过时不传 */
  project?: string
  /** 最后一句回复 */
  preview?: string | null
  /** 不是空闲时的状态：头像角上的点和第二行的文字 */
  status?: { tone: SessionTone; text: string; pulse?: boolean } | null
  pinned?: boolean
  /** 正打开着（抽屉里高亮） */
  active?: boolean
  /** 抽屉里：头像小一点、上下紧一点 */
  dense?: boolean
  /** 和上一行之间画分隔线（首页的卡片里） */
  divider?: boolean
  onClick(): void
}) {
  const second = status ? status.text : preview
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex w-full items-center gap-3 text-left active:bg-hover',
        dense ? 'min-h-14 rounded-xl px-2.5 py-2' : 'min-h-[72px] px-4 py-3',
        active && 'bg-selected',
        divider && 'border-t border-line-subtle',
      )}
    >
      <EngineAvatar
        engine={engine}
        size={dense ? 32 : 40}
        status={status ? { tone: status.tone, pulse: status.pulse } : undefined}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate',
              dense ? 'text-list' : 'text-ui',
              status?.tone === 'danger' && 'font-medium',
            )}
          >
            {title}
          </span>
          {pinned && <Pin size={12} aria-label="已置顶" className="shrink-0 self-center text-fg-faint" />}
          <span className="shrink-0 text-label text-fg-faint">{time}</span>
        </span>
        {(project || second) && (
          <span className="flex min-w-0 items-center gap-1.5 text-meta text-fg-muted">
            {project && <span className="max-w-[45%] shrink-0 truncate">{project}</span>}
            {project && second && <span className="shrink-0 text-fg-faint">·</span>}
            {second && (
              <span className={cn('min-w-0 truncate', status && cn(TEXT[status.tone], 'font-medium'))}>{second}</span>
            )}
          </span>
        )}
      </span>
    </button>
  )
}
