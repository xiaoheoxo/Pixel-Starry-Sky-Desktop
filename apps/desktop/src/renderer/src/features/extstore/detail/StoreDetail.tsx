import { useState, type ReactNode } from 'react'
import { ArrowLeft, Download } from 'lucide-react'
import type {
  ExtPackContributionKind,
  ExtPackInfo,
  ExtStoreDetail,
  ExtStoreLocal,
  ExtStoreProgress,
  ExtStoreReportInput,
  ExtStoreUpdate,
} from '@pixelsky/protocol'
import { packDescription, packName } from '@pixelsky/protocol'
import { Button, cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { getLocale, tr } from '@/i18n/core'
import { formatDate } from '@/features/account/format'
import { PackBadge } from '@/features/settings/extensions/PackBadge'
import { StoreReadme, isWebUrl } from './StoreReadme'
import { contributionGroupsOf } from './contributionRows'
import { ReportDialog } from './ReportDialog'
import {
  defaultReportVersion,
  detailActions,
  engineMinVersion,
  formatSize,
  type DetailAction,
  type DetailReason,
} from './detailActions'

// 扩展商店的详情页（docs/ui/extension-store-client.md §2.2，示意图 mock-detail.png）。
// props 驱动：不读状态单例、不碰 window；按钮和举报都走回调，接线见 features/extstore 的合并说明。

const KIND_LABELS = {
  grammars: 'extensions.kind.grammars',
  themes: 'extensions.kind.themes',
  snippets: 'extensions.kind.snippets',
  iconThemes: 'extensions.kind.iconThemes',
  taskTemplates: 'extensions.kind.taskTemplates',
  skills: 'extensions.kind.skills',
  prompts: 'extensions.kind.prompts',
} as const satisfies Record<ExtPackContributionKind, string>

const kindLabel = (kind: string): string =>
  kind in KIND_LABELS ? tr(KIND_LABELS[kind as ExtPackContributionKind]) : kind

export interface StoreDetailProps {
  /** 扩展 id；详情还没取到、本机也没有时用它标出这一页 */
  id?: string
  /** 商店详情；接口回 404（已下架 / 被平台停用）时是 null，这时用 localPack 显示本机那份 */
  detail: ExtStoreDetail | null
  /** 本机同 id 的扩展（已装的商店版、内置或开发中）；详情是 null 时靠它显示 */
  localPack?: ExtPackInfo | null
  /** extstore.state().updates[id]：更新 / 换回 */
  update?: ExtStoreUpdate | null
  /** 当前像素星空版本，判断「需要像素星空 X 以上」 */
  appVersion: string
  /** 本机有同 id 的开发中文件夹（装上后会被它替代） */
  devCopy?: boolean
  /** 正在装 / 更新 / 换回时的进度（extstore.state().installing[id]）；有它时右上角显示进度 */
  progress?: ExtStoreProgress | null
  /** 正在卸载或启停（别的操作进行中）：按钮全灰 */
  busy?: boolean
  /** 上一次操作失败的文案（已翻译好），显示在按钮下面 */
  error?: string | null
  /** 图标地址：pixelsky-ext://store-icon/<id>/<version>；取不到时显示首字母 */
  iconSrc?: string | null
  /** 正在取详情（第一次取、或点了重试）；这时不下「已下架」的结论 */
  loading?: boolean
  /** 取详情失败（云端 5xx、连不上等，不含 404）的文案（已翻译好）；有它时不算下架，显示错误和「重试」 */
  loadError?: string | null
  onRetry?(): void
  signedIn: boolean
  onBack(): void
  /** 安装 / 更新 / 换回；换回时 options.rollback 为 true；kind 决定装好后的提示是「已安装」还是「已更新」 */
  onInstall(version: string, options?: { rollback?: boolean; kind?: 'install' | 'update' }): void
  onCancelInstall?(): void
  onUninstall(): void
  onSetEnabled(enabled: boolean): void
  /** 提交举报；失败时抛错（界面翻成文案） */
  onReport(input: ExtStoreReportInput): Promise<void>
  /** 没登录时点「登录后举报」 */
  onLogin(): void
  /** 一开始就打开举报对话框（测试和命令面板用） */
  reportOpen?: boolean
  /** 一开始停在哪个页签 */
  initialTab?: 'readme' | 'versions'
}

function Initial({ name, src, size }: { name: string; src?: string | null; size: number }) {
  const [failed, setFailed] = useState(false)
  const style = { width: size, height: size }
  if (src && !failed)
    return (
      <img
        src={src}
        alt=""
        draggable={false}
        onError={() => setFailed(true)}
        className="shrink-0 rounded-lg"
        style={style}
      />
    )
  return (
    <span
      aria-hidden
      style={style}
      className="flex shrink-0 items-center justify-center rounded-lg bg-avatar text-section font-medium text-avatar-fg"
    >
      {(name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()}
    </span>
  )
}

function SideTitle({ children }: { children: ReactNode }) {
  return <h5 className="mt-5 mb-2 text-meta text-fg-faint first:mt-0">{children}</h5>
}

function reasonText(reason: DetailReason | undefined): string | null {
  if (!reason) return null
  if (reason.kind === 'engineNeed') return tr('extstoreDetail.engineNeed', { version: reason.version })
  return null
}

function progressLabel(p: ExtStoreProgress): string {
  if (p.phase === 'verifying') return tr('extstoreDetail.progress.verifying')
  if (p.phase === 'installing') return tr('extstoreDetail.progress.installing')
  if (p.total && p.total > 0)
    return tr('extstoreDetail.progress.downloading', {
      percent: Math.min(100, Math.floor((p.received / p.total) * 100)),
    })
  return tr('extstoreDetail.progress.downloadingUnknown')
}

export function StoreDetail(props: StoreDetailProps) {
  const {
    detail,
    localPack,
    update,
    appVersion,
    devCopy,
    progress,
    busy,
    error,
    iconSrc,
    loading,
    loadError,
    signedIn,
  } = props
  const { locale, t } = useI18n()
  const [tab, setTab] = useState<'readme' | 'versions'>(props.initialTab ?? 'readme')
  const [confirming, setConfirming] = useState(false)
  const [reporting, setReporting] = useState(props.reportOpen ?? false)

  const manifest = detail?.manifest ?? localPack?.manifest ?? null
  const id = detail?.extension.id ?? localPack?.id ?? props.id ?? ''
  const name = manifest ? packName(manifest, locale) : (detail?.extension.name ?? id)
  const description = manifest ? packDescription(manifest, locale) : (detail?.extension.description ?? '')
  const publisher = detail?.extension.publisher ?? (manifest ? { name: manifest.publisher, official: false } : null)
  const version = detail?.extension.version ?? manifest?.version ?? localPack?.store?.version ?? ''

  // 本机那份：localPack 优先——它跟着扩展列表实时变（启停、停用名单更新）；详情带的 local 是主进程取详情那一刻的，
  // 只在扩展列表还没有这一项时用（两边挑本机那份的规则相同，见 market/ipc.ts 的 localOf）
  const local: ExtStoreLocal | null = localPack
    ? {
        key: localPack.key,
        version: localPack.store?.version ?? localPack.manifest?.version ?? null,
        source: localPack.source,
        enabled: localPack.enabled,
        ...(localPack.blocked ? { blocked: localPack.blocked } : {}),
      }
    : (detail?.local ?? null)
  const blockedReason = local?.blocked?.reason ?? null
  // 只有确实取过、云端回了 404 才算下架；还在取、或取失败（5xx、连不上）都不下这个结论
  const delisted = detail === null && local !== null && !loading && !loadError

  const engineRange = detail?.manifest?.engines.pixelsky ?? null
  const working = !!busy || !!progress
  const { actions, notes } = detailActions({
    latest: detail ? { version: detail.latest.version, engineRange } : null,
    local,
    update,
    appVersion,
    devCopy,
    busy: working,
  })

  const actionLabel = (a: DetailAction): string => {
    switch (a.id) {
      case 'install':
        return t('extstoreDetail.install')
      case 'update':
        return t('extstoreDetail.update')
      case 'rollback':
        return t('extstoreDetail.rollback', { version: a.version })
      case 'uninstall':
        return t('extstoreDetail.uninstall')
      case 'enable':
        return t('extstoreDetail.enable')
      case 'disable':
        return t('extstoreDetail.disable')
    }
  }
  const run = (a: DetailAction): void => {
    if (a.disabled) return
    if (a.id === 'install') props.onInstall(a.version as string, { kind: 'install' })
    else if (a.id === 'update') props.onInstall(a.version as string, { kind: 'update' })
    else if (a.id === 'rollback') props.onInstall(a.version as string, { rollback: true, kind: 'update' })
    else if (a.id === 'uninstall') setConfirming(true)
    else props.onSetEnabled(a.id === 'enable')
  }

  const groups = contributionGroupsOf(manifest, locale)
  const sep = t('extstoreDetail.listSeparator')
  const updated = formatDate(detail?.extension.updatedAt)
  const reasons = actions.map(a => reasonText(a.reason)).filter((x): x is string => !!x)
  const versions = detail?.versions ?? []
  const license = detail?.license ?? manifest?.license ?? null
  const repository = detail?.repository ?? manifest?.repository ?? null
  const homepage = detail?.homepage ?? manifest?.homepage ?? null
  const needEngine = engineRange ? engineMinVersion(engineRange) : null

  const linkRow = (label: string, href: string | null): ReactNode =>
    href && (
      <div className="truncate">
        {label}{' '}
        {isWebUrl(href) ? (
          <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent-fg hover:underline">
            {href.replace(/^https?:\/\//i, '')}
          </a>
        ) : (
          <span>{href}</span>
        )}
      </div>
    )

  return (
    <div data-store-detail={id}>
      <button
        type="button"
        onClick={props.onBack}
        className="press no-drag mb-3 inline-flex items-center gap-1 text-ui text-fg-muted hover:text-fg"
      >
        <ArrowLeft size={14} strokeWidth={1.5} />
        {t('extstoreDetail.back')}
      </button>

      {loadError && !loading && (
        <div
          data-store-load-error
          role="alert"
          className="mb-3 flex items-center gap-3 rounded-md border border-line bg-subtle px-3 py-2 text-ui"
        >
          <p className="selectable min-w-0 flex-1 break-words text-danger">
            {t('extstoreDetail.loadFailed', { error: loadError })}
          </p>
          {props.onRetry && (
            <Button variant="outline" data-store-retry onClick={props.onRetry}>
              {t('extstoreDetail.retry')}
            </Button>
          )}
        </div>
      )}

      {(delisted || blockedReason) && (
        <div data-store-notice className="mb-3 rounded-md border border-line bg-subtle px-3 py-2 text-ui">
          {delisted && <p className="text-fg-secondary">{t('extstoreDetail.delisted')}</p>}
          {blockedReason && (
            <p className="selectable text-danger">{t('extstoreDetail.blockedReason', { reason: blockedReason })}</p>
          )}
        </div>
      )}

      {!detail && !localPack ? (
        // 取失败时上面已经写了错误，这里不再说「不在商店里」
        <p className="text-ui text-fg-muted">{loading ? '…' : loadError ? null : t('extstoreDetail.notFound')}</p>
      ) : (
        <>
          <div className="flex items-start gap-4">
            <Initial name={name} src={iconSrc} size={64} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-title font-semibold text-fg">{name}</h4>
                {publisher?.official && <PackBadge>{t('extstoreDetail.official')}</PackBadge>}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-meta text-fg-faint">
                {publisher && <span>{publisher.name}</span>}
                {version && <span>· v{version}</span>}
                {detail && (
                  <span className="inline-flex items-center gap-0.5">
                    · <Download size={11} strokeWidth={1.5} />
                    {detail.extension.downloads.toLocaleString(getLocale())}
                  </span>
                )}
                {updated && <span>· {t('extstoreDetail.updatedAt', { date: updated })}</span>}
                {local?.version && local.source === 'store' && local.version !== version && (
                  <span>· {t('extstoreDetail.installedVersion', { version: local.version })}</span>
                )}
              </div>
              {description && <p className="mt-1 text-ui text-fg-secondary">{description}</p>}
            </div>
            <div data-store-actions className="flex shrink-0 flex-col items-end gap-1.5">
              {progress ? (
                <div className="flex items-center gap-2">
                  <Button variant="primary" disabled>
                    {progressLabel(progress)}
                  </Button>
                  {props.onCancelInstall && progress.phase === 'downloading' && (
                    <Button variant="ghost" onClick={props.onCancelInstall}>
                      {t('extstoreDetail.cancel')}
                    </Button>
                  )}
                </div>
              ) : confirming ? (
                <span className="inline-flex items-center gap-2 text-ui text-fg-muted">
                  {t('extstoreDetail.uninstallConfirm')}
                  <Button
                    disabled={working}
                    onClick={() => {
                      setConfirming(false)
                      props.onUninstall()
                    }}
                  >
                    {t('extstoreDetail.uninstallYes')}
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirming(false)}>
                    {t('extstoreDetail.cancel')}
                  </Button>
                </span>
              ) : (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {actions.map(a => (
                    <Button
                      key={a.id}
                      data-action={a.id}
                      variant={a.id === 'install' || a.id === 'update' || a.id === 'rollback' ? 'primary' : 'outline'}
                      disabled={a.disabled}
                      onClick={() => run(a)}
                    >
                      {actionLabel(a)}
                    </Button>
                  ))}
                </div>
              )}
              {!progress &&
                reasons.map(r => (
                  <p key={r} data-action-reason className="text-meta text-fg-muted">
                    {r}
                  </p>
                ))}
              {!progress &&
                notes.map(n => (
                  <p key={n.kind} data-action-note={n.kind} className="max-w-xs text-right text-meta text-fg-muted">
                    {n.kind === 'devReplace'
                      ? t('extstoreDetail.devReplace')
                      : t('extstoreDetail.updateNeeds', { version: n.version })}
                  </p>
                ))}
              {error && (
                <p role="alert" className="selectable max-w-xs break-words text-right text-meta text-danger">
                  {error}
                </p>
              )}
            </div>
          </div>

          <div className="mt-5 flex gap-6 border-b border-line">
            {detail &&
              (['readme', 'versions'] as const).map(k => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={tab === k}
                  onClick={() => setTab(k)}
                  className={cn(
                    'press no-drag -mb-px border-b-2 px-1 pb-2 text-ui',
                    tab === k ? 'border-accent font-medium text-fg' : 'border-transparent text-fg-muted hover:text-fg',
                  )}
                >
                  {t(k === 'readme' ? 'extstoreDetail.tab.readme' : 'extstoreDetail.tab.versions')}
                </button>
              ))}
          </div>

          <div className="mt-4 flex flex-col gap-6 md:flex-row">
            <div className="min-w-0 flex-1">
              {detail ? (
                tab === 'readme' ? (
                  detail.readme.trim() ? (
                    <StoreReadme text={detail.readme} />
                  ) : (
                    <p className="text-ui text-fg-faint">{t('extstoreDetail.noReadme')}</p>
                  )
                ) : versions.length ? (
                  <ul data-store-versions className="divide-y divide-line-subtle">
                    {versions.map(v => (
                      <li key={v.version} className="flex items-center gap-3 py-2 text-ui">
                        <span className="font-medium text-fg">v{v.version}</span>
                        {v.version === detail.latest.version && (
                          <PackBadge>{t('extstoreDetail.versionLatest')}</PackBadge>
                        )}
                        {local?.version === v.version && local.source === 'store' && (
                          <PackBadge>{t('extstoreDetail.versionInstalled')}</PackBadge>
                        )}
                        <span className="ml-auto text-meta text-fg-faint">
                          {formatDate(v.publishedAt) ?? ''} {v.size > 0 ? `· ${formatSize(v.size)}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-ui text-fg-faint">{t('extstoreDetail.versionsEmpty')}</p>
                )
              ) : null}
            </div>

            <aside className="w-full shrink-0 border-line md:w-60 md:border-l md:pl-5">
              <SideTitle>{t('extstoreDetail.contents')}</SideTitle>
              {groups.length ? (
                <ul data-store-contents className="space-y-1 text-ui text-fg">
                  {groups.map(g => (
                    <li key={g.kind}>
                      ✓{' '}
                      {g.names.length
                        ? t('extstoreDetail.contentRow', {
                            n: g.count,
                            kind: kindLabel(g.kind),
                            names: g.names.join(sep),
                          })
                        : t('extstoreDetail.contentRowPlain', { n: g.count, kind: kindLabel(g.kind) })}
                    </li>
                  ))}
                </ul>
              ) : detail && detail.contents.length ? (
                <ul data-store-contents className="space-y-1 text-ui text-fg">
                  {detail.contents.map(c => (
                    <li key={c.kind}>
                      ✓ {t('extstoreDetail.contentRowPlain', { n: c.count, kind: kindLabel(c.kind) })}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-ui text-fg-faint">{t('extstoreDetail.contentsEmpty')}</p>
              )}

              <SideTitle>{t('extstoreDetail.permissions')}</SideTitle>
              <PackBadge>{t('extstoreDetail.noPermissions')}</PackBadge>

              <SideTitle>{t('extstoreDetail.info')}</SideTitle>
              <div className="space-y-0.5 text-meta text-fg-muted">
                {license && <div>{t('extstoreDetail.license', { value: license })}</div>}
                {linkRow(t('extstoreDetail.source'), repository)}
                {linkRow(t('extstoreDetail.homepage'), homepage)}
                {detail && detail.latest.size > 0 && (
                  <div>{t('extstoreDetail.size', { value: formatSize(detail.latest.size) })}</div>
                )}
                {needEngine && <div>{t('extstoreDetail.engineNeed', { version: needEngine })}</div>}
              </div>

              {detail && (
                <button
                  type="button"
                  data-report-open
                  onClick={() => (signedIn ? setReporting(true) : props.onLogin())}
                  className="press no-drag mt-6 text-meta text-fg-faint hover:text-fg"
                >
                  {signedIn ? t('extstoreDetail.report') : t('extstoreReport.signIn')}
                </button>
              )}
            </aside>
          </div>
        </>
      )}

      {reporting && detail && (
        <ReportDialog
          name={name}
          defaultVersion={defaultReportVersion(local, detail)}
          versions={versions.map(v => v.version)}
          signedIn={signedIn}
          onSubmit={props.onReport}
          onLogin={props.onLogin}
          onClose={() => setReporting(false)}
        />
      )}
    </div>
  )
}
