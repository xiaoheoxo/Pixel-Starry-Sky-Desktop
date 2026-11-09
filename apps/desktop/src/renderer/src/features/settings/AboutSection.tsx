import { translateMessage } from '../../i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateText } from '../../i18n/core'
import { useEffect, useState, type ReactNode } from 'react'
import { ArrowDownToLine, Check, Copy, ExternalLink, FolderOpen, RefreshCw, RotateCw } from 'lucide-react'
import type { AppInfo, AppLink } from '../../../../shared/types/app-info'
import { useAccount } from '@/features/account'
import { Button, Logo, Switch, cn } from '@/ui'
import { updateActions, useUpdateState } from '@/features/update/store'
import { RELEASE_NOTES, useWhatsNew, whatsNewActions } from '@/features/update/whatsNew'
import type { UpdateState } from '../../../../shared/types/update'
import { Toggle } from './SettingRow'
import { useSettings } from './SettingsProvider'
import { requestFeedback } from '../feedback/focus'

const CHANNEL_LABELS: Record<AppInfo['channel'], string> = {
  get dev() {
    return tr('settings.AboutSection.developmentMode')
  },
  get portable() {
    return tr('settings.AboutSection.portable')
  },
  get installed() {
    return tr('settings.AboutSection.installed')
  },
}

/** 开源组件致谢：只列直接依赖的主要部分 */
const CREDITS = ['Electron', 'React', 'Tailwind CSS', 'Lucide', 'Vite', 'Material Icon Theme (MIT)']

/** 设置 → 关于：版本、运行环境、账号服务、本地数据（docs/ui/settings.md §5） */
export function AboutSection({ onOpenAccount }: { onOpenAccount: () => void }) {
  useI18n()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const update = useUpdateState()
  const acc = useAccount()
  const settings = useSettings()

  useEffect(() => {
    const bridge = window.pixelsky?.app
    if (!bridge) {
      setError(tr('settings.AboutSection.applicationInformationIsUnavailable'))
      return
    }
    bridge.getInfo().then(setInfo, (e: unknown) => setError(String((e as Error)?.message ?? e)))
  }, [])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  const open = (link: AppLink) => {
    window.pixelsky?.app.open(link).catch((e: unknown) => setError(String((e as Error)?.message ?? e)))
  }

  const copyInfo = async () => {
    if (!info) return
    try {
      await navigator.clipboard.writeText(diagnostics(info))
      setCopied(true)
    } catch {
      setError(tr('settings.AboutSection.copyFailedSelectAnd'))
    }
  }

  const accountText =
    acc.status === 'signed-in'
      ? tr('settings.AboutSection.signedIn', { p0: acc.user?.email ?? '' })
      : acc.status === 'signing-in'
        ? tr('sidebar.SidebarFooter.signingIn')
        : acc.status === 'loading'
          ? tr('session.live.SessionStrips.loading')
          : tr('sidebar.SidebarFooter.notSignedIn')

  return (
    <section>
      <div className="mb-6 flex items-center gap-4">
        <Logo size={56} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="text-section font-semibold text-fg">
              {translateText(info?.name ?? tr('ui.Logo.pixelStarrySky'))}
            </h3>
            <span className="text-meta text-fg-muted">{info?.englishName ?? 'Pixel Starry Sky'}</span>
          </div>
          <p className="mt-0.5 text-ui text-fg-secondary tabular-nums">
            {info
              ? tr('settings.AboutSection.version', { p0: info.version, p1: CHANNEL_LABELS[info.channel] })
              : tr('settings.AboutSection.version2')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <UpdateButton update={update} />
          <Button icon={copied ? Check : Copy} onClick={copyInfo} disabled={!info} aria-live="polite">
            {copied ? tr('code.CodeBlock.copied') : tr('settings.AboutSection.copyVersionInformation')}
          </Button>
        </div>
      </div>

      {error && <p className="mb-4 rounded-md bg-subtle px-3 py-2 text-meta text-danger">{translateMessage(error)}</p>}

      {update && <UpdateGroup update={update} />}

      <Group title={tr('settings.AboutSection.runtimeEnvironment')}>
        <Row
          label={tr('settings.AboutSection.applicationVersion')}
          value={info?.version}
          mono
          action={
            info && RELEASE_NOTES[info.version] ? (
              <button
                type="button"
                data-whats-new-open
                onClick={() => whatsNewActions.show(info.version)}
                className="press no-drag h-7 shrink-0 rounded-md px-2 text-meta text-fg-secondary hover:bg-hover hover:text-fg"
              >
                {tr('whatsNew.show')}
              </button>
            ) : undefined
          }
        />
        <Row label="Electron" value={info?.electron} mono />
        <Row label="Chromium" value={info?.chrome} mono />
        <Row label="Node.js" value={info?.node} mono />
        <Row label={tr('settings.AboutSection.system')} value={info && `${info.os}（${info.arch}）`} />
      </Group>

      <Group title={tr('settings.AboutSection.accountAndData')}>
        <Row
          label={tr('settings.AboutSection.account')}
          value={accountText}
          action={
            <button
              type="button"
              onClick={onOpenAccount}
              className="press no-drag h-7 shrink-0 rounded-md px-2 text-meta text-fg-secondary hover:bg-hover hover:text-fg"
            >
              {tr('settings.AboutSection.manage')}{' '}
            </button>
          }
        />
        <Row
          label={tr('settings.AboutSection.authenticationService')}
          value={info?.authUrl.replace(/^https?:\/\//, '')}
          mono
          action={
            <LinkButton
              label={tr('settings.AboutSection.openAuthenticationServiceIn')}
              onClick={() => open('auth')}
              icon="external"
            />
          }
        />
        {info?.cloudRoute.route && (
          <Row
            label={tr('settings.AboutSection.cloudRoute')}
            value={routeText(info.cloudRoute)}
            title={tr('settings.AboutSection.cloudRouteHint')}
          />
        )}
        <Row
          label={tr('settings.AboutSection.dataDirectory')}
          value={info?.dataDir}
          mono
          title={info?.dataDir}
          action={
            <LinkButton
              label={tr('settings.AboutSection.openDataDirectory')}
              onClick={() => open('data-dir')}
              icon="folder"
            />
          }
        />
      </Group>

      <Group title={tr('settings.AboutSection.links')}>
        <Row
          label={tr('settings.AboutSection.sourceRepository')}
          value={info?.repoUrl.replace(/^https:\/\//, '')}
          mono
          action={
            <LinkButton
              label={tr('settings.AboutSection.openSourceRepositoryIn')}
              onClick={() => open('repo')}
              icon="external"
            />
          }
        />
        <Row
          label={tr('feedback.aboutTitle')}
          value={tr('feedback.aboutDesc')}
          action={
            <button
              type="button"
              onClick={() => {
                requestFeedback({})
                settings.openSettings('feedback')
              }}
              className="press no-drag h-7 shrink-0 rounded-md px-2 text-meta text-fg-secondary hover:bg-hover hover:text-fg"
            >
              {tr('feedback.send')}
            </button>
          }
        />
      </Group>

      <p className="mt-6 text-meta text-fg-faint">
        {tr('settings.AboutSection.builtWith')} {CREDITS.join('、')}
        {tr('settings.AboutSection.andOtherOpenSource')} <br />© 2026 Pixel Starry Sky
      </p>
    </section>
  )
}

/** 顶部按钮：按更新状态变成「检查更新 / 正在检查 / 下载 x% / 重启以更新 / 去下载」 */
function UpdateButton({ update }: { update: UpdateState | null }) {
  useI18n()
  const status = update?.status
  if (status === 'ready')
    return (
      <Button
        variant="primary"
        icon={RotateCw}
        disabled={update?.installing}
        onClick={() => void updateActions.install()}
      >
        {tr(update?.installing ? 'update.restarting' : 'update.restart')}
      </Button>
    )
  if (status === 'available')
    return (
      <Button variant="primary" icon={ArrowDownToLine} onClick={() => void updateActions.download()}>
        {tr('update.download')}
      </Button>
    )
  const busy = status === 'checking' || status === 'downloading'
  return (
    <Button
      icon={RefreshCw}
      disabled={!update || status === 'unsupported' || busy}
      title={status === 'unsupported' ? tr('update.unsupported') : undefined}
      onClick={() => void updateActions.check()}
      className={cn(status === 'checking' && '[&_svg]:animate-spin')}
    >
      {status === 'checking'
        ? tr('update.checking')
        : status === 'downloading'
          ? tr('update.downloading', { p0: update?.percent ?? 0 })
          : tr('settings.AboutSection.checkForUpdates')}
    </Button>
  )
}

/** 「更新」分组：当前状态、更新说明、接收测试版开关 */
function UpdateGroup({ update }: { update: UpdateState }) {
  useI18n()
  const { status, version } = update
  const line =
    status === 'unsupported'
      ? tr('update.unsupported')
      : status === 'checking'
        ? tr('update.checking')
        : status === 'latest'
          ? tr('update.latest')
          : status === 'error'
            ? tr('update.error', { p0: translateMessage(update.error ?? '') })
            : status === 'downloading'
              ? `${tr('update.downloadingTitle', { p0: version ?? '' })} · ${update.percent ?? 0}%`
              : status === 'ready'
                ? tr('update.readyTitle', { p0: version ?? '' })
                : status === 'available'
                  ? tr('update.availableTitle', { p0: version ?? '' })
                  : null
  const hint =
    status === 'ready'
      ? tr('update.readyHint')
      : status === 'available'
        ? tr(update.channel === 'portable' ? 'update.portableHint' : 'update.manualHint')
        : status === 'downloading'
          ? tr('update.downloadingHint')
          : null
  return (
    <Group title={tr('update.group')}>
      {line && (
        <div data-update-status={status} className="border-b border-line-subtle px-4 py-2.5">
          <p className={cn('text-ui', status === 'error' ? 'text-danger' : 'text-fg')}>{line}</p>
          {hint && <p className="mt-0.5 text-meta text-fg-muted">{hint}</p>}
          {status === 'downloading' && (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-subtle">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${update.percent ?? 0}%` }}
              />
            </div>
          )}
          {update.notes && (status === 'ready' || status === 'available' || status === 'downloading') && (
            <div className="mt-2">
              <p className="text-meta font-medium text-fg-muted">{tr('update.notes')}</p>
              <p className="selectable mt-1 max-h-40 overflow-y-auto text-meta whitespace-pre-wrap text-fg-secondary">
                {update.notes}
              </p>
            </div>
          )}
        </div>
      )}
      <WhatsNewToggle />
      <div className="flex min-h-10 items-center gap-4 px-4 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-ui text-fg">{tr('update.beta')}</p>
          <p className="text-meta text-fg-muted">{tr('update.betaHint')}</p>
        </div>
        <Switch
          checked={update.beta}
          disabled={status === 'unsupported'}
          label={tr('update.beta')}
          onChange={on => void updateActions.setBeta(on)}
        />
      </div>
    </Group>
  )
}

/** 「更新后显示更新内容」：关掉就是弹窗里的「不再提示」 */
function WhatsNewToggle() {
  useI18n()
  const { muted } = useWhatsNew()
  return (
    <div className="flex min-h-10 items-center gap-4 border-b border-line-subtle px-4 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-ui text-fg">{tr('whatsNew.setting')}</p>
        <p className="text-meta text-fg-muted">{tr('whatsNew.settingHint')}</p>
      </div>
      <Toggle label={tr('whatsNew.setting')} checked={!muted} onChange={on => whatsNewActions.setMuted(!on)} />
    </div>
  )
}

/** 云端线路一行：「直连 · CDN 1.10 s / 直连 0.80 s」（docs/network-direct.md §3） */
function routeText(c: AppInfo['cloudRoute']): string {
  const name = (id: 'cdn' | 'direct'): string =>
    tr(id === 'cdn' ? 'settings.AboutSection.routeCdn' : 'settings.AboutSection.routeDirect')
  const probe = c.probe
    .map(
      p => `${name(p.id)} ${p.ms === null ? tr('settings.AboutSection.routeDown') : `${(p.ms / 1000).toFixed(2)} s`}`,
    )
    .join(' / ')
  return c.route ? (probe ? `${name(c.route)} · ${probe}` : name(c.route)) : ''
}

/** 复制给别人排查问题用的一段纯文本 */
function diagnostics(info: AppInfo): string {
  return [
    `${translateText(info.name)}（${info.englishName}）${info.version} · ${CHANNEL_LABELS[info.channel]}`,
    `Electron ${info.electron} · Chromium ${info.chrome} · Node.js ${info.node} · V8 ${info.v8}`,
    `${info.os}（${info.arch}）`,
    tr('settings.AboutSection.authenticationService2', { p0: info.authUrl }),
    ...(info.cloudRoute.route ? [`${tr('settings.AboutSection.cloudRoute')}: ${routeText(info.cloudRoute)}`] : []),
  ].join('\n')
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  useI18n()
  return (
    <div className="mb-5">
      <h4 className="mb-2 text-meta font-medium text-fg-muted">{title}</h4>
      <dl className="overflow-hidden rounded-lg border border-line">{children}</dl>
    </div>
  )
}

function Row({
  label,
  value,
  mono,
  title,
  action,
}: {
  label: string
  value: string | null | undefined
  mono?: boolean
  title?: string
  action?: ReactNode
}) {
  const { locale } = useI18n()
  return (
    <div className="flex min-h-10 items-center gap-4 border-b border-line-subtle px-4 py-1.5 last:border-b-0">
      {/* 英文标签比中文长：标签列放宽，只在词与词之间换行，不压到右边的值 */}
      <dt className={cn('shrink-0 text-ui leading-snug text-fg-muted', locale === 'en-US' ? 'w-32' : 'w-20')}>
        {label}
      </dt>
      <dd
        title={title}
        className={`selectable min-w-0 flex-1 truncate text-ui text-fg ${mono ? 'font-mono text-meta' : ''}`}
      >
        {value ?? '—'}
      </dd>
      {action}
    </div>
  )
}

function LinkButton({ label, onClick, icon }: { label: string; onClick: () => void; icon: 'external' | 'folder' }) {
  useI18n()
  const Icon = icon === 'folder' ? FolderOpen : ExternalLink
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="press no-drag flex size-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
    >
      <Icon size={15} strokeWidth={1.5} />
    </button>
  )
}
