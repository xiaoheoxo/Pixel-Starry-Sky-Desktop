import type { ExtPackInfo, ExtStoreUpdate } from '@pixelsky/protocol'
import { packDescription } from '@pixelsky/protocol'
import { Button, cn, Switch } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { PackIcon } from '@/features/settings/extensions/PackList'
import { packTitle } from '@/features/settings/extensions/model'
import { ShadowedMark, SourceBadge } from './InstalledBadges'
import { formatMonthDay, packVersion, rowState } from './installedModel'

export interface InstalledRowProps {
  pack: ExtPackInfo
  update: ExtStoreUpdate | undefined
  site: string | null
  /** 这一行正在装（更新 / 换回） */
  installing: boolean
  /** 有别的操作在跑：开关和按钮都不可点 */
  busy: boolean
  onOpen(key: string): void
  onToggle(key: string, enabled: boolean): void
  onUpdate(pack: ExtPackInfo): void
  onRollback(pack: ExtPackInfo, version: string): void
  /** 点「卸载」：由页签弹确认框 */
  onUninstall(pack: ExtPackInfo): void
}

/** 已安装页的一行：开关、来源小标、版本 / 更新那一行、更新 / 换回 / 卸载 */
export function InstalledRow(p: InstalledRowProps) {
  const { pack } = p
  const { locale, t } = useI18n()
  const state = rowState(pack, p.update, p.site)
  const title = packTitle(pack, locale)
  const version = packVersion(pack)
  const line = state.line
  let status: React.ReactNode = pack.manifest ? packDescription(pack.manifest, locale) : null
  if (state.blocked) {
    status = (
      <span data-blocked className="text-danger">
        {t('extstore.installed.line.blocked', {
          reason: state.blocked.reason,
          date: formatMonthDay(state.blocked.at),
        })}
      </span>
    )
  } else if (state.shadowedBy) {
    status = <ShadowedMark by={state.shadowedBy} />
  } else if (line?.kind === 'available') {
    status = (
      <span className="text-warn">
        {t('extstore.installed.line.available', { from: line.from, latest: line.latest })}
      </span>
    )
  } else if (line?.kind === 'engineNeed') {
    status = <span className="text-warn">{t('extstore.installed.line.engineNeed', { need: line.need })}</span>
  } else if (line?.kind === 'otherSite') {
    status = <span>{t('extstore.installed.line.otherSite', { site: line.site })}</span>
  }
  const showVersion = version && !state.blocked && line?.kind !== 'available'
  return (
    <li
      data-pack-key={pack.key}
      data-tone={state.tone}
      className={cn(
        'flex items-center gap-3 px-3 py-2.5 first:rounded-t-lg last:rounded-b-lg hover:bg-hover',
        state.tone === 'blocked' && 'bg-danger/10',
        state.tone === 'shadowed' && 'opacity-60',
      )}
    >
      <button
        type="button"
        onClick={() => p.onOpen(pack.key)}
        className="no-drag flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <PackIcon pack={pack} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-ui font-medium text-fg">{title}</span>
            <SourceBadge source={pack.source} />
            {showVersion && <span className="shrink-0 text-meta text-fg-faint">v{version}</span>}
          </span>
          <span className="mt-0.5 block truncate text-meta text-fg-muted">{status}</span>
        </span>
      </button>
      {state.canUpdate && (
        <Button disabled={p.busy} onClick={() => p.onUpdate(pack)}>
          {p.installing ? t('extstore.installed.updating') : t('extstore.installed.update')}
        </Button>
      )}
      {state.rollbackTo && (
        <Button disabled={p.busy} onClick={() => p.onRollback(pack, state.rollbackTo!)}>
          {t('extstore.installed.rollback', { version: state.rollbackTo })}
        </Button>
      )}
      <Switch
        checked={pack.enabled}
        disabled={p.busy || state.switchDisabled}
        label={t('extensions.enable', { name: title })}
        onChange={on => p.onToggle(pack.key, on)}
      />
      {state.canUninstall && (
        <Button variant="ghost" disabled={p.busy} onClick={() => p.onUninstall(pack)}>
          {pack.source === 'folder' ? t('extensions.detail.remove') : t('extstore.installed.uninstall')}
        </Button>
      )}
    </li>
  )
}
