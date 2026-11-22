import { ChevronDown, Hash, Mic, Monitor, Phone, type LucideIcon } from 'lucide-react'
import type { DotAttachment, DotOverview } from '@pixelsky/engine'
import type { WorkflowRun } from '@pixelsky/protocol'
import type { DotEntry } from '../../../../shared/types/dot-chat'
import { cn } from '@/ui'
import { tr } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { DotAvatar } from './DotAvatar'
import { DotFile, isDotImage } from './DotFile'
import { DotStatusIcon, DotStatusPill, dotPresence, dotStatus, presenceTone, statusTone } from './status'
import { dotError } from './errors'

export const dotWebUrl = (id?: string): string =>
  id ? `https://chatgpt.com/dots/${encodeURIComponent(id)}` : 'https://chatgpt.com/dots'

/** 详情栏最多画几张缩略图，其余的图片和文件一起排成行 */
const THUMBS = 6

/** 跳到 ChatGPT 网页的小按钮：图标 + 两三个字，完整的说明放悬停提示 */
function WebButton({
  href,
  icon: Icon,
  label,
  title,
}: {
  href: string
  icon: LucideIcon
  label: string
  title: string
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="dot-quick" title={title} aria-label={title}>
      <Icon size={16} />
      {label}
    </a>
  )
}

export function DotProfilePanel({
  entry,
  overview,
  overviewError,
  outputs,
  workflows = [],
  lastReplyAt,
  onOpenComputer,
  onRefresh,
}: {
  entry: DotEntry | null
  overview?: DotOverview
  overviewError?: string
  outputs: DotAttachment[]
  workflows?: WorkflowRun[]
  lastReplyAt?: number
  onOpenComputer?: () => void
  onRefresh?: () => void
}) {
  const { locale } = useI18n()
  const web = dotWebUrl(entry?.id)
  const name = entry?.name ?? 'Dot'
  const active = Math.max(entry?.lastActiveAt ?? 0, lastReplyAt ?? 0)
  const minutes = active ? Math.max(0, Math.floor((Date.now() - active) / 60_000)) : null
  const ago =
    minutes === null
      ? null
      : new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
          minutes < 60 ? -minutes : minutes < 1440 ? -Math.floor(minutes / 60) : -Math.floor(minutes / 1440),
          minutes < 60 ? 'minute' : minutes < 1440 ? 'hour' : 'day',
        )
  const environment = overview?.environment
  const desktop = environment?.capabilities.find(c => c.type === 'remote_desktop')?.status ?? environment?.status
  const recent = new Map<string, { id: string; title: string; status: string }>()
  for (const item of [...(overview?.tasks ?? []), ...(overview?.activity ?? [])]) {
    if (!recent.has(item.id)) recent.set(item.id, item)
  }
  for (const task of overview?.roomTasks ?? []) {
    if (!recent.has(task.id)) recent.set(task.id, task)
  }
  // Verified workflow cards are still available when the optional recent activity feed is missing.
  for (const flow of [...workflows].sort((a, b) => b.startedAt - a.startedAt)) {
    if (!recent.has(flow.id)) recent.set(flow.id, { id: flow.id, title: flow.name, status: flow.status })
  }
  const uniqueFiles = new Map<string, DotAttachment>()
  for (const file of [...outputs, ...(overview?.roomOutputs ?? [])]) {
    const key = file.fileId || file.url || file.name
    if (!uniqueFiles.has(key)) uniqueFiles.set(key, file)
  }
  const files = [...uniqueFiles.values()]
  const recentRows = [...recent.values()]
  const renderTask = (item: (typeof recentRows)[number]) => {
    const tone = statusTone(item.status)
    return (
      <a
        key={item.id}
        href={web}
        target="_blank"
        rel="noreferrer"
        className="dot-output-row"
        title={dotStatus(item.status)}
      >
        <DotStatusIcon status={item.status} size={18} />
        <span className={cn('min-w-0 flex-1 truncate', item.status === 'completed' && 'text-fg-muted')}>
          {item.title || tr('dot.task')}
        </span>
        {(tone === 'warn' || tone === 'danger') && <DotStatusPill status={item.status} />}
      </a>
    )
  }
  // 能取到的图片排成缩略图，其余排成行
  const pictures = files.filter(file => isDotImage(file) && file.fileId).slice(0, THUMBS)
  const rows = files.filter(file => !pictures.includes(file))
  return (
    <aside className="dot-profile-panel" aria-label={tr('dot.details')}>
      <div className="dot-profile-identity">
        <DotAvatar name={name} url={entry?.avatarUrl} size={44} status={entry?.status} />
        <div className="min-w-0">
          <h2>{name}</h2>
          <p title={active ? new Date(active).toLocaleString(locale) : undefined}>
            {entry ? dotPresence(entry.status) : tr('dot.notLoaded')}
            {ago && ` · ${tr('dot.lastActive', { p0: ago })}`}
          </p>
        </div>
      </div>
      <button type="button" className="dot-computer-card" onClick={onOpenComputer}>
        <span className="dot-computer-icon">
          <Monitor size={17} strokeWidth={1.6} />
        </span>
        <span className="min-w-0 flex-1 text-left">
          <strong>{tr('dot.computer')}</strong>
          <span className="dot-computer-status">
            <i className="dot-presence-dot" data-tone={presenceTone(desktop)} />
            {dotStatus(desktop)}
          </span>
        </span>
        <span className="shrink-0 text-meta text-fg-muted">{tr('dot.view')}</span>
      </button>
      <section>
        <h3>
          {tr('dot.recentTasks')}{' '}
          {onRefresh && (
            <button type="button" className="dot-small-button ml-2" onClick={onRefresh}>
              {tr('dot.refresh')}
            </button>
          )}
        </h3>
        {recentRows.length ? (
          <>
            {recentRows.slice(0, 5).map(renderTask)}
            {recentRows.length > 5 && (
              <details className="dot-more-outputs">
                <summary>
                  <ChevronDown size={15} />
                  {tr('dot.showMore')}
                </summary>
                {recentRows.slice(5).map(renderTask)}
              </details>
            )}
          </>
        ) : overview?.tasks || overview?.activity ? (
          <p className="dot-panel-empty">{tr('dot.noActivity')}</p>
        ) : overview ? (
          <a className="dot-panel-empty dot-web-link" href={web} target="_blank" rel="noreferrer">
            {tr('dot.activityUnavailable')}
          </a>
        ) : (
          <p className="dot-panel-empty">{tr('dot.notLoaded')}</p>
        )}
      </section>
      <section>
        <h3>
          {tr('dot.outputs')}
          {files.length > 0 && ` · ${files.length}`}
        </h3>
        {files.length ? (
          <>
            {!!pictures.length && (
              <div className="dot-thumbs">
                {pictures.map(file => (
                  <DotFile key={file.fileId} file={file} thumb />
                ))}
              </div>
            )}
            {!!rows.length && (
              <div className="dot-output-list">
                {rows.slice(0, 5).map((file, i) => (
                  <DotFile key={file.fileId ?? i} file={file} compact />
                ))}
              </div>
            )}
            {rows.length > 5 && (
              <details className="dot-more-outputs">
                <summary>
                  <ChevronDown size={15} />
                  {tr('dot.showMore')}
                </summary>
                {rows.slice(5).map((file, i) => (
                  <DotFile key={file.fileId ?? i} file={file} compact />
                ))}
              </details>
            )}
          </>
        ) : (
          <p className="dot-panel-empty">{tr('dot.noOutputs')}</p>
        )}
      </section>
      <section>
        <h3>{tr('dot.inChatGpt')}</h3>
        <div className="flex gap-1.5">
          <WebButton href={web} icon={Phone} label={tr('dot.call')} title={tr('dot.callName', { name })} />
          <WebButton href={web} icon={Mic} label={tr('dot.voiceShort')} title={tr('dot.voice')} />
          <WebButton href={web} icon={Hash} label="Slack" title={tr('dot.slack')} />
        </div>
      </section>
      {overview?.roomContentPartial && (
        <p className="dot-panel-empty">
          <a href={web} target="_blank" rel="noreferrer">
            {tr('dot.partialRoomContent')}
          </a>
        </p>
      )}
      {Array.from(new Set([...(overview?.errors ?? []), ...(overviewError ? [overviewError] : [])])).map((error, i) => (
        <p key={i} className={cn('text-meta text-warn', i === 0 && 'mt-2')}>
          {dotError(error)}
        </p>
      ))}
    </aside>
  )
}
