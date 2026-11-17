import { Monitor, ExternalLink, ChevronDown } from 'lucide-react'
import type { DotAttachment, DotOverview } from '@pixelsky/engine'
import type { DotEntry } from '../../../../shared/types/dot-chat'
import { cn } from '@/ui'
import { tr } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { DotAvatar } from './DotAvatar'
import { DotFile } from './DotFile'
import { dotError } from './errors'

export const dotWebUrl = (id?: string): string =>
  id ? `https://chatgpt.com/dots/${encodeURIComponent(id)}` : 'https://chatgpt.com/dots'

const STATUS_KEYS = {
  active: 'dot.status.active',
  connected: 'dot.status.connected',
  ready: 'dot.status.ready',
  paused: 'dot.status.paused',
  disconnected: 'dot.status.disconnected',
  unavailable: 'dot.status.unavailable',
  thinking: 'dot.status.thinking',
  inProgress: 'dot.status.inProgress',
  needsInput: 'dot.status.needsInput',
  completed: 'dot.status.completed',
  failed: 'dot.status.failed',
  interrupted: 'dot.status.interrupted',
} as const

export function dotStatus(status?: string): string {
  return status && status in STATUS_KEYS
    ? tr(STATUS_KEYS[status as keyof typeof STATUS_KEYS])
    : status || tr('dot.notLoaded')
}

/** 任务状态的颜色：进行中主色、等你处理警告色、失败 / 中断危险色、其余灰 */
export function statusTone(status?: string): 'accent' | 'warn' | 'danger' | 'muted' {
  if (status === 'inProgress' || status === 'thinking') return 'accent'
  if (status === 'needsInput') return 'warn'
  if (status === 'failed' || status === 'interrupted') return 'danger'
  return 'muted'
}

const TONE = {
  accent: 'bg-accent-soft text-accent-fg',
  warn: 'bg-warn/10 text-warn',
  danger: 'bg-danger/10 text-danger',
  muted: 'bg-subtle text-fg-muted',
} as const

export function DotStatusPill({ status }: { status?: string }) {
  return (
    <span className={cn('shrink-0 rounded px-1.5 text-meta leading-5', TONE[statusTone(status)])}>
      {dotStatus(status)}
    </span>
  )
}

/** 跳到 ChatGPT 网页的一行：统一带「↗」，不让人以为在应用里打开 */
function WebLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="dot-output-row">
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ExternalLink size={12} className="shrink-0 text-fg-faint" />
    </a>
  )
}

export function DotProfilePanel({
  entry,
  overview,
  outputs,
  onOpenComputer,
}: {
  entry: DotEntry | null
  overview?: DotOverview
  outputs: DotAttachment[]
  onOpenComputer?: () => void
}) {
  const { locale } = useI18n()
  const web = dotWebUrl(entry?.id)
  const name = entry?.name ?? 'Dot'
  const active = entry?.lastActiveAt
  const minutes = active ? Math.max(0, Math.floor((Date.now() - active) / 60_000)) : null
  const ago =
    minutes === null
      ? tr('dot.notLoaded')
      : new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
          minutes < 60 ? -minutes : minutes < 1440 ? -Math.floor(minutes / 60) : -Math.floor(minutes / 1440),
          minutes < 60 ? 'minute' : minutes < 1440 ? 'hour' : 'day',
        )
  const environment = overview?.environment
  const desktop = environment?.capabilities.find(c => c.type === 'remote_desktop')?.status ?? environment?.status
  // 近期任务：有任务列表用它，没有时退回近期活动
  const recent = overview?.tasks?.length ? overview.tasks : (overview?.activity ?? null)
  const files = [...new Map(outputs.map(a => [a.fileId || a.url || a.name, a])).values()]
  return (
    <aside className="dot-profile-panel" aria-label={tr('dot.details')}>
      <div className="dot-profile-identity">
        <DotAvatar name={name} url={entry?.avatarUrl} size={64} />
        <div className="min-w-0">
          <h2>{name}</h2>
          <p title={active ? new Date(active).toLocaleString(locale) : undefined}>
            {tr('dot.lastActive', { p0: ago })}
          </p>
        </div>
      </div>
      <button type="button" className="dot-computer-card text-left" onClick={onOpenComputer}>
        <span className="dot-computer-icon">
          <Monitor size={22} strokeWidth={1.4} />
        </span>
        <span className="min-w-0">
          <strong>{tr('dot.computer')}</strong>
          <span>{dotStatus(desktop)}</span>
        </span>
      </button>
      <section>
        <h3>{tr('dot.recentTasks')}</h3>
        {recent?.length ? (
          recent.map(item => (
            <a key={item.id} href={web} target="_blank" rel="noreferrer" className="dot-output-row">
              <span className="min-w-0 flex-1 truncate">{item.title || tr('dot.task')}</span>
              <DotStatusPill status={item.status} />
            </a>
          ))
        ) : (
          <p className="dot-panel-empty">{tr(recent ? 'dot.noActivity' : 'dot.notLoaded')}</p>
        )}
      </section>
      <section>
        <h3>{tr('dot.outputs')}</h3>
        {files.length ? (
          <>
            <div className="dot-output-list">
              {files.slice(0, 5).map((file, i) => (
                <DotFile key={file.fileId ?? i} file={file} compact />
              ))}
            </div>
            {files.length > 5 && (
              <details className="dot-more-outputs">
                <summary>
                  <ChevronDown size={15} />
                  {tr('dot.showMore')}
                </summary>
                {files.slice(5).map((file, i) => (
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
        <WebLink href={web}>{tr('dot.callName', { name })}</WebLink>
        <WebLink href={web}>{tr('dot.slack')}</WebLink>
        <WebLink href={web}>{tr('dot.voice')}</WebLink>
      </section>
      {overview?.errors.map((error, i) => (
        <p key={i} className={cn('text-meta text-warn', i === 0 && 'mt-2')}>
          {dotError(error)}
        </p>
      ))}
    </aside>
  )
}
