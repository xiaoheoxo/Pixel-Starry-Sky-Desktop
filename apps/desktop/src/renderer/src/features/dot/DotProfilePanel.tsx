import { Monitor, Phone, ExternalLink, ChevronDown, LayoutGrid } from 'lucide-react'
import type { DotAttachment, DotOverview } from '@pixelsky/engine'
import type { DotEntry } from '../../../../shared/types/dot-chat'
import { tr, translateMessage } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { DotAvatar } from './DotAvatar'
import { DotFile } from './DotFile'

export const dotWebUrl = (id?: string): string =>
  id ? `https://chatgpt.com/dots/${encodeURIComponent(id)}` : 'https://chatgpt.com/dots'

export function dotStatus(status?: string): string {
  const keys = {
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
  return status && status in keys ? tr(keys[status as keyof typeof keys]) : status || tr('dot.notLoaded')
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
  const files = [...new Map(outputs.map(a => [a.fileId || a.url || a.name, a])).values()]
  return (
    <aside className="dot-profile-panel" aria-label={tr('dot.details')}>
      <div className="dot-profile-identity">
        <DotAvatar name={entry?.name ?? 'Dot'} url={entry?.avatarUrl} size={76} />
        <div className="min-w-0">
          <h2>{entry?.name ?? 'Dot'}</h2>
          <p title={active ? new Date(active).toLocaleString(locale) : undefined}>
            {tr('dot.lastActive', { p0: ago })}
          </p>
        </div>
      </div>
      <div className="dot-profile-actions">
        <a href={web} target="_blank" rel="noreferrer" title={tr('dot.callInWeb')}>
          <Phone size={18} />
          {tr('dot.call')}
          <ExternalLink size={11} className="opacity-50" />
        </a>
        <a href={web} target="_blank" rel="noreferrer" title={tr('dot.slackInWeb')}>
          <LayoutGrid size={18} />
          Slack
          <ExternalLink size={11} className="opacity-50" />
        </a>
      </div>
      <button type="button" className="dot-computer-card text-left" onClick={onOpenComputer}>
        <span className="dot-computer-icon">
          <Monitor size={26} strokeWidth={1.3} />
        </span>
        <span className="min-w-0">
          <strong>{tr('dot.computer')}</strong>
          <span>
            {dotStatus(environment?.capabilities.find(c => c.type === 'remote_desktop')?.status ?? environment?.status)}
          </span>
        </span>
        <ExternalLink size={13} className="ml-auto shrink-0 opacity-40" />
      </button>
      <section>
        <h3>{tr('dot.devices')}</h3>
        {environment?.capabilities.length ? (
          environment.capabilities.map((device, i) => (
            <div className="dot-device" key={`${device.type}-${i}`}>
              <span className="relative">
                <Monitor size={17} strokeWidth={1.4} />
                <i className={device.status === 'ready' ? 'is-online' : ''} />
              </span>
              <span className="min-w-0 flex-1 truncate">
                {device.type === 'remote_desktop' ? tr('dot.cloudDesktop') : device.type}
              </span>
              <span className="text-meta text-fg-muted">{dotStatus(device.status)}</span>
            </div>
          ))
        ) : (
          <p className="dot-panel-empty">{tr('dot.devicesUnavailable')}</p>
        )}
      </section>
      <section>
        <h3>{tr('dot.recentActivity')}</h3>
        {overview?.activity?.length ? (
          overview.activity.map(item => (
            <a href={web} key={item.id} target="_blank" rel="noreferrer" className="dot-output-row">
              <span className="truncate">{item.title || dotStatus(item.status)}</span>
            </a>
          ))
        ) : (
          <p className="dot-panel-empty">{tr(overview?.activity ? 'dot.noActivity' : 'dot.notLoaded')}</p>
        )}
        {!!overview?.tasks?.length && (
          <div className="mt-3 space-y-2">
            {overview.tasks.map(item => (
              <a key={item.id} href={web} target="_blank" rel="noreferrer" className="dot-output-row">
                <span className="min-w-0 flex-1 truncate">{item.title || tr('dot.task')}</span>
                <span className="text-meta text-fg-muted">{dotStatus(item.status)}</span>
              </a>
            ))}
          </div>
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
      <p className="dot-profile-account" title={entry?.accountName}>
        {entry?.accountName}
      </p>
      {overview?.errors.map((error, i) => (
        <p key={i} className="text-meta text-warn">
          {translateMessage(error)}
        </p>
      ))}
    </aside>
  )
}
