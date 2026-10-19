import type { ExtStoreCheckReport, ExtStoreMyVersion } from '@pixelsky/protocol'
import { cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { PackBadge } from '@/features/settings/extensions/PackBadge'
import { CheckReport } from './CheckReport'
import { VERSION_STATUS_KEY, canWithdraw, versionReason, versionTone } from './publishModel'

/** 一个版本：状态、原因、N 条提示、撤回；点开看本机存的逐条检查结果（report 为 undefined 表示没读到，null 表示这台电脑上没有） */
export function VersionRow({
  version,
  open,
  report,
  busy,
  onToggle,
  onWithdraw,
}: {
  version: ExtStoreMyVersion
  open: boolean
  report?: ExtStoreCheckReport | null
  busy?: boolean
  onToggle(): void
  onWithdraw(): void
}) {
  const { t } = useI18n()
  const reason = versionReason(version)
  const tone = versionTone(version.status)
  return (
    <li data-version={version.version} data-status={version.status} className="border-t border-line px-3 py-2">
      <div className="flex items-start gap-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="no-drag flex min-w-0 flex-1 items-start gap-3 text-left"
        >
          <span className="w-16 shrink-0 font-mono text-ui text-fg">{version.version}</span>
          <PackBadge tone={tone === 'danger' ? 'danger' : tone === 'warn' ? 'warn' : 'neutral'}>
            {t(VERSION_STATUS_KEY[version.status])}
          </PackBadge>
          <span className={cn('min-w-0 flex-1 text-meta break-words', reason ? 'text-fg-muted' : 'text-fg-faint')}>
            {reason}
            {version.hints > 0 && (
              <span data-hints className={cn(reason && 'ml-2')}>
                {t('extstore.publish.version.hints', { count: version.hints })}
              </span>
            )}
          </span>
        </button>
        {canWithdraw(version) && (
          <button
            type="button"
            disabled={busy}
            onClick={onWithdraw}
            className="press no-drag shrink-0 text-ui text-accent disabled:opacity-50"
          >
            {t('extstore.publish.version.withdraw')}
          </button>
        )}
      </div>
      {open && report !== undefined && (
        <div className="mt-2 pl-[4.75rem]">
          <CheckReport report={report} />
        </div>
      )}
    </li>
  )
}
