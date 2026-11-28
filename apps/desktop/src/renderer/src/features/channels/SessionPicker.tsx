// 「添加 AI 成员」的「已有会话」一块（docs/ui/import-collab.md 第 5 项 ②b，样稿 docs/ui/channel-add-session-mockup.html 排法 A）：
// 选一个已有的会话加进频道，频道派来的活就在它里面接着做。选中的会话、名字、职责由 AgentDialog 管，加入也在那边
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { cn, EngineIcon, Select } from '@/ui'
import { useEngineState } from '@/features/engine'
import { relativeTime } from '@/features/engine/labels'
import type { Channel } from '@/data/types'
import { useChannels } from './store'
import { pickBlocked, sessionCandidates, type SessionCandidate } from './sessionPick'

const INPUT =
  'w-full min-w-0 rounded-md border border-line bg-surface px-3 py-2 text-ui text-fg outline-none focus:border-accent-line focus:ring-2 focus:ring-composer-ring'

export function SessionPicker({
  channel,
  picked,
  onPick,
  name,
  onName,
  instructions,
  onInstructions,
  onSubmit,
}: {
  channel: Channel
  picked: SessionCandidate | null
  onPick: (c: SessionCandidate) => void
  name: string
  onName: (v: string) => void
  instructions: string
  onInstructions: (v: string) => void
  /** 名字框里按回车：加入 */
  onSubmit: () => void
}) {
  useI18n()
  const sessions = useEngineState(s => s.sessions)
  const projects = useEngineState(s => s.projects)
  const engines = useEngineState(s => s.engines)
  const currentProject = useEngineState(s => s.currentProjectId)
  const members = useChannels(s => s.members)
  // 下拉的「这个项目」：频道的项目，没设时用当前项目
  const home = channel.projectId ?? currentProject ?? ''
  const homeProject = projects.find(p => p.id === home)
  const [query, setQuery] = useState('')
  // 频道的项目里没有能选的会话（只有灰掉的或一个都没有）：直接看全部项目
  const [scope, setScope] = useState(() =>
    homeProject &&
    sessionCandidates({ sessions, projects, members, channel, projectId: home, query: '' }).list.some(
      c => !pickBlocked(c),
    )
      ? home
      : '',
  )
  const { list, more } = useMemo(
    () => sessionCandidates({ sessions, projects, members, channel, projectId: scope || null, query }),
    [sessions, projects, members, channel, scope, query],
  )
  const engineName = (id: string) => engines.find(e => e.id === id)?.name ?? id
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-fg-muted focus-within:border-accent-line">
          <Search size={14} strokeWidth={1.5} className="shrink-0" />
          <input
            type="search"
            data-pick-search
            value={query}
            maxLength={200}
            onChange={e => setQuery(e.target.value)}
            aria-label={tr('channels.pick.search')}
            placeholder={tr('channels.pick.search')}
            className="min-w-0 flex-1 bg-transparent text-list text-fg outline-none placeholder:text-fg-faint"
          />
        </label>
        {homeProject && (
          <Select
            label={tr('channels.pick.scope')}
            value={scope}
            options={[
              { value: home, label: homeProject.name },
              { value: '', label: tr('channels.pick.allProjects') },
            ]}
            onChange={setScope}
          />
        )}
      </div>
      {list.length === 0 ? (
        <p className="px-1 py-3 text-meta text-fg-faint">{tr('channels.pick.empty')}</p>
      ) : (
        <div className="flex flex-col gap-1">
          <div
            role="listbox"
            aria-label={tr('channels.pick.list')}
            data-pick-list
            className="-mx-1 flex max-h-[236px] flex-col gap-0.5 overflow-y-auto px-1 [scrollbar-width:thin]"
          >
            {list.map(c => {
              const blocked = pickBlocked(c)
              const selected = picked?.id === c.id
              return (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-disabled={blocked || undefined}
                  data-pick-row={c.id}
                  onClick={() => !blocked && onPick(c)}
                  className={cn(
                    'flex min-h-9 w-full items-center gap-2 rounded-md border px-1.5 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-composer-ring',
                    selected ? 'border-accent-line bg-accent-soft' : 'border-transparent',
                    blocked ? 'cursor-default opacity-55' : !selected && 'hover:bg-hover',
                  )}
                >
                  <EngineIcon engine={c.engine} size={14} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-list text-fg">{c.title}</span>
                    <span className="truncate text-meta text-fg-faint">
                      {scope ? relativeTime(c.updatedAt) : `${c.project} · ${relativeTime(c.updatedAt)}`}
                    </span>
                  </span>
                  {c.tag?.kind === 'in' || c.tag?.kind === 'used' ? (
                    <span className="shrink-0 rounded-md bg-subtle px-1.5 text-meta text-fg-muted">
                      {tr(c.tag.kind === 'in' ? 'channels.pick.in' : 'channels.pick.used', { name: c.tag.name })}
                    </span>
                  ) : c.tag ? (
                    <span
                      className={cn(
                        'shrink-0 rounded-md px-1.5 text-meta text-accent-fg',
                        selected ? 'bg-surface' : 'bg-accent-soft',
                      )}
                    >
                      {tr('channels.pick.bound', { name: c.tag.name })}
                    </span>
                  ) : null}
                  {c.running && (
                    <span className="shrink-0 rounded-md bg-active/12 px-1.5 text-meta text-active">
                      {tr('channels.pick.running')}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          <p className="px-1 text-meta text-fg-faint">
            {more ? tr('channels.pick.more', { n: list.length }) : tr('channels.pick.footer')}
          </p>
        </div>
      )}
      {picked && (
        <form
          data-pick-picked
          className="flex flex-col gap-3 rounded-lg border border-line-subtle bg-subtle p-3"
          onSubmit={e => {
            e.preventDefault()
            onSubmit()
          }}
        >
          {picked.tag?.kind === 'bound' ? (
            <p className="text-meta text-fg-muted">{tr('channels.pick.sameMember', { name: picked.tag.name })}</p>
          ) : (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-meta font-medium text-fg-muted">{tr('channels.join.name')}</span>
                <input value={name} maxLength={40} onChange={e => onName(e.target.value)} className={INPUT} />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-meta font-medium text-fg-muted">{tr('channels.join.instructions')}</span>
                <textarea
                  value={instructions}
                  maxLength={2000}
                  rows={2}
                  placeholder={tr('channels.join.instructionsHint')}
                  onChange={e => onInstructions(e.target.value)}
                  className={`${INPUT} resize-none`}
                />
              </label>
            </>
          )}
          <div className="flex flex-wrap gap-1.5">
            {[
              engineName(picked.engine),
              picked.project,
              tr('channels.pick.keepSettings'),
              tr('channels.pick.shared'),
            ].map(text => (
              <span key={text} className="rounded-md bg-surface px-1.5 text-meta text-fg-secondary">
                {text}
              </span>
            ))}
          </div>
          <p className="text-meta text-fg-muted">
            {tr('channels.join.hint')}
            {picked.running ? ` ${tr('channels.pick.runningHint')}` : ''}
          </p>
          <button type="submit" hidden />
        </form>
      )}
    </div>
  )
}
