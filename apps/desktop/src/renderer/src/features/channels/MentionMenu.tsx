import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { useLayoutEffect, useRef } from 'react'
import { Users } from 'lucide-react'
import { cn } from '@/ui'
import type { ChannelMember } from '@/data/types'
import type { TeamRole } from '../../../../shared/types/channels'
import { agentMeta, MemberAvatar } from './ChannelMessage'
import { roleLabel } from './TeamParts'
import { canDispatch, mentionNote } from './teamModel'

/** 输入框里的 @ 菜单（docs/ui/channels.md §6）；结构和键盘处理照 features/session/CommandMenu.tsx */
export function MentionMenu({
  id,
  members,
  all,
  selected,
  onChoose,
  team = false,
  role,
  selfId = null,
}: {
  id: string
  members: readonly ChannelMember[]
  /** 最上面的「全体 AI 成员」（issue #83）：有它时是第 0 项，成员从第 1 项开始；token 是插入的写法 */
  all?: { count: number; token: string; approval: number } | null
  selected: number
  /** index 和 selected 同一套编号（含「全体」那一项） */
  onChoose: (index: number) => void
  /** 团队频道：真人写团队角色，AI 成员写归属，观察者不能派活 */
  team?: boolean
  role?: TeamRole
  /** 我在团队里的 id：「指定的人」名单里有我就不用同意 */
  selfId?: string | null
}) {
  const offset = all ? 1 : 0
  const allBlocked = team && !canDispatch(role)
  useI18n()
  const listRef = useRef<HTMLDivElement>(null)

  // 只滚动候选列表，避免 scrollIntoView 连带移动时间线
  useLayoutEffect(() => {
    const list = listRef.current,
      option = list?.querySelector<HTMLElement>(`[data-mention-index="${selected}"]`)
    if (!list || !option) return
    const viewport = list.getBoundingClientRect(),
      row = option.getBoundingClientRect()
    if (row.top < viewport.top) list.scrollTop += row.top - viewport.top
    else if (row.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom
  }, [members, selected])

  return (
    <div className="no-drag absolute right-0 bottom-full left-0 z-30 mb-2 overflow-hidden rounded-lg border border-line-card bg-popover p-1 shadow-menu">
      <div
        ref={listRef}
        id={id}
        role="listbox"
        aria-label={tr('channels.mention.label')}
        className="max-h-64 overflow-y-auto overscroll-contain"
      >
        {members.length === 0 && !all && (
          <div className="px-3 py-2 text-meta text-fg-muted">{tr('channels.mention.empty')}</div>
        )}
        {all && (
          <button
            type="button"
            role="option"
            tabIndex={-1}
            id={`${id}-0`}
            data-mention-index={0}
            data-mention-all=""
            aria-selected={selected === 0}
            aria-disabled={allBlocked || undefined}
            onMouseDown={e => e.preventDefault()}
            onClick={() => onChoose(0)}
            className={cn(
              'flex w-full min-w-0 flex-wrap items-center gap-x-2.5 rounded-md px-2.5 text-left text-list',
              allBlocked || all.approval ? 'min-h-9 py-1' : 'h-9',
              allBlocked && 'opacity-50',
              selected === 0 ? 'bg-selected' : 'hover:bg-hover',
            )}
          >
            <span className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-fg">
              <Users size={13} strokeWidth={1.75} />
            </span>
            <span className="shrink-0 font-medium text-fg">@{all.token}</span>
            <span className="min-w-0 truncate text-meta text-fg-faint">{tr('channels.mention.all')}</span>
            <span className="ml-auto shrink-0 text-meta text-fg-faint">
              {tr('channels.mention.allCount', { count: all.count })}
            </span>
            {(allBlocked || !!all.approval) && (
              <span className="basis-full pl-[32px] text-meta text-fg-faint">
                {allBlocked ? tr('team.mention.observer') : tr('channels.mention.allApproval', { count: all.approval })}
              </span>
            )}
          </button>
        )}
        {members.map((member, i) => {
          const index = i + offset
          const meta =
            agentMeta(member) ??
            (member.kind === 'human' && member.role
              ? team
                ? roleLabel(member.role)
                : tr(member.role === 'owner' ? 'channels.role.owner' : 'channels.role.member')
              : '')
          const note = team ? mentionNote(member, role, selfId) : null
          const foreign = member.kind === 'agent' && member.mine === false ? member : null
          return (
            <button
              type="button"
              role="option"
              tabIndex={-1}
              key={member.id}
              id={`${id}-${index}`}
              data-mention-index={index}
              aria-selected={index === selected}
              aria-disabled={note === 'observer' || undefined}
              onMouseDown={e => e.preventDefault()}
              onClick={() => onChoose(index)}
              className={cn(
                'flex w-full min-w-0 flex-wrap items-center gap-x-2.5 rounded-md px-2.5 text-left text-list',
                note ? 'min-h-9 py-1' : 'h-9',
                note === 'observer' && 'opacity-50',
                index === selected ? 'bg-selected' : 'hover:bg-hover',
              )}
            >
              <MemberAvatar member={member} size={22} />
              <span className="shrink-0 font-medium text-fg">{member.name}</span>
              {foreign?.ownerName && (
                <span className="shrink-0 text-meta text-fg-faint">
                  · {tr('team.panel.agentOf', { owner: foreign.ownerName })}
                </span>
              )}
              {meta && <span className="min-w-0 truncate text-meta text-fg-faint">{meta}</span>}
              {member.kind === 'agent' && (member.config || member.ownerId) && (
                <span
                  className={cn(
                    'ml-auto shrink-0 text-meta',
                    member.status === 'waiting' ? 'text-warn' : 'text-fg-faint',
                  )}
                >
                  {member.status === 'running' || member.status === 'waiting'
                    ? tr('channels.mention.busy', { count: (member.task ? 1 : 0) + (member.queued ?? 0) })
                    : tr(member.status === 'offline' ? 'channels.status.offline' : 'channels.status.idle')}
                </span>
              )}
              {note && (
                <span className="basis-full pl-[32px] text-meta text-fg-faint">
                  {note === 'observer'
                    ? tr('team.mention.observer')
                    : note === 'owner'
                      ? tr('team.mention.ownerOnly', { owner: foreign?.ownerName ?? '?' })
                      : tr('team.mention.needsApproval', { owner: foreign?.ownerName ?? '?' })}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
