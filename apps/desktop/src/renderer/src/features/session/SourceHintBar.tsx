import { translateMessage } from '../../i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
// 输入框上方的额度来源提示条（docs/ui/source-switch.md §3.4、§3.5）：
// - 已开始的会话切换平台 / 自有 / 引擎前的确认（换来源会重启引擎并接上原对话，换引擎会把之前的对话交接过去；运行中换的从下一条消息生效）；
// - 运行中换了来源 / 引擎后的「下一条消息使用 ××」提示，可撤销；
// - 发送前就知道会失败的情况 + 一键按钮。平台失败从不自动改用自有，按钮让用户自己选。
import { useState, type ReactNode } from 'react'
import { ArrowLeftRight, CircleAlert, TriangleAlert } from 'lucide-react'
import { ENGINES } from '@pixelsky/protocol'
import { Spinner, cn } from '@/ui'
import { useAccount } from '@/features/account/useAccount'
import { groupsForModel, refreshPlatform, usePlatform, type CreditSource } from '@/features/account/platform'
import { useSettings } from '@/features/settings/SettingsProvider'
import type { ComposerController } from '@/features/engine'
import { providersFor, useProviders } from '@/features/account/providers'
import {
  isAuthChannel,
  pixelSelfMissing,
  selfSourceReady,
  type AuthChannel,
  type ChannelChoice,
} from '@/features/model-channels/channelModel'
import { useEngineCatalog } from '@/features/engine/catalog'
import { channelLabel } from '@/features/model-channels/channelLabels'
import { openAuthDialog } from '@/features/model-channels/authDialogStore'

/** 等用户确认的切换：从提示条 / 错误卡片来的只有来源，从模型菜单来的带具体的通道和模型（docs/ui/model-channels.md §2.3） */
export interface SourceSwitch {
  source: CreditSource
  choice: ChannelChoice | null
}

function Action({ onClick, children, primary }: { onClick: () => void; children: ReactNode; primary?: boolean }) {
  useI18n()
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'press h-7 shrink-0 rounded-md px-2.5 text-meta',
        primary ? 'bg-primary text-primary-fg hover:opacity-90' : 'text-fg-secondary hover:bg-hover hover:text-fg',
      )}
    >
      {children}
    </button>
  )
}

function Bar({
  tone,
  icon,
  children,
  actions,
}: {
  tone: 'warn' | 'danger' | 'info'
  icon: ReactNode
  children: ReactNode
  actions: ReactNode
}) {
  useI18n()
  return (
    <div
      role={tone === 'info' ? undefined : 'alert'}
      className={cn(
        'mx-3 mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-1.5',
        tone === 'danger'
          ? 'border-danger/30 bg-danger/5'
          : tone === 'warn'
            ? 'border-warn/30 bg-warn/5'
            : 'border-line bg-subtle',
      )}
    >
      <span
        className={cn(
          'flex shrink-0',
          tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-fg-muted',
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1 text-meta text-fg-secondary">{children}</div>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </div>
  )
}

export function SourceHintBar({
  live,
  confirm,
  onCancelConfirm,
  onRequestSource,
  onOpenMenu,
}: {
  live: ComposerController
  /** 等用户确认的切换目标；null 表示没有在确认 */
  confirm: SourceSwitch | null
  onCancelConfirm: () => void
  onRequestSource: (source: CreditSource) => void
  onOpenMenu: () => void
}) {
  useI18n()
  const account = useAccount()
  // 确认换引擎时，线路和接口按要换去的那个引擎的目录来找
  const targetEngineId = confirm?.choice?.engine ?? live.engine?.id ?? 'claude'
  const platform = usePlatform(targetEngineId)
  const settings = useSettings()
  const providers = useProviders()
  // 当前引擎的模型目录：像素星空的「自有」能不能用看它（selfSourceReady）
  const engineId = live.engine?.id ?? 'claude'
  const catalog = useEngineCatalog(engineId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (confirm) {
    const engineName = live.engine?.name ?? 'Claude Code'
    // 换到平台的某个模型：线路按切换时的规则挑（当前线路有这个模型就不换，否则倍率最低的）
    const target = confirm.choice?.channel === 'platform' ? confirm.choice.model : null
    const route = target
      ? (platform.groups.find(g => g.id === live.groupId && g.models.includes(target)) ??
        groupsForModel(platform.groups, target)[0])
      : platform.groups.find(g => g.id === (live.groupId ?? platform.groupId))
    const endpoints = providersFor(providers.providers, targetEngineId)
    const endpoint = endpoints.find(p => p.id === (confirm.choice?.providerId ?? platform.providerId)) ?? endpoints[0]
    // 换引擎：之前的对话交接给新引擎（回到用过的引擎时接上它自己的会话）
    const switchEngine = !!confirm.choice && confirm.choice.engine !== live.engine?.id
    const nextEngineName = switchEngine
      ? (live.engines.find(e => e.id === targetEngineId)?.name ?? ENGINES[targetEngineId].name)
      : ''
    const fromEngineName = live.sessionEngine?.name ?? engineName
    const sourceChanged = !switchEngine || confirm.choice?.channel !== live.channel
    const label = switchEngine
      ? nextEngineName
      : confirm.choice
        ? channelLabel(confirm.choice.channel)
        : confirm.source === 'self'
          ? tr('session.ModelSourceMenu.ownAccount')
          : confirm.source === 'custom'
            ? tr('customApi.source')
            : tr('session.ModelSourceMenu.platform')
    const apply = (): void => {
      setBusy(true)
      setError(null)
      ;(confirm.choice ? live.applyChoice(confirm.choice) : live.setSource(confirm.source))
        .then(onCancelConfirm)
        .catch((e: unknown) => setError((e as Error).message))
        .finally(() => setBusy(false))
    }
    return (
      <Bar
        tone="info"
        icon={<ArrowLeftRight size={14} />}
        actions={
          <>
            <Action onClick={onCancelConfirm}>{tr('account.AccountMenu.cancel')}</Action>
            <Action primary onClick={apply}>
              {busy ? <Spinner /> : tr('session.SourceHintBar.switchTo', { p0: label })}
            </Action>
          </>
        }
      >
        <div className="font-medium text-fg">
          {switchEngine ? (
            tr('session.SourceHintBar.switchEngineTitle', { p0: nextEngineName })
          ) : (
            <>
              {tr('session.SourceHintBar.switchTo2')}
              {label}
              {tr('session.SourceHintBar.toContinueThisConversation')}
            </>
          )}
        </div>
        <div>
          {switchEngine &&
            tr(
              live.engineHasSession(targetEngineId)
                ? 'session.SourceHintBar.switchEngineBodyResume'
                : 'session.SourceHintBar.switchEngineBody',
              { p0: nextEngineName, p1: fromEngineName },
            )}
          {switchEngine && ' '}
          {sourceChanged &&
            (confirm.source === 'self'
              ? tr('session.SourceHintBar.futureRequestsAreBilled', { p0: nextEngineName || engineName })
              : confirm.source === 'custom'
                ? tr('customApi.futureRequests', { p0: endpoint?.name ?? '' })
                : tr('session.SourceHintBar.futureRequestsUsePlatform', {
                    p0: route ? `线路「${route.name}」` : '',
                  }))}
          {switchEngine
            ? live.running && tr('session.SourceHintBar.switchEngineNextMessage')
            : live.running
              ? tr('session.SourceHintBar.takesEffectFromNextMessage')
              : tr('session.SourceHintBar.engineRestartsAndResumes')}{' '}
        </div>
        {error && <div className="text-danger">{translateMessage(error)}</div>}
      </Bar>
    )
  }

  const pending = live.pendingSource
  const pendingEngine = live.pendingEngine
  if (pending || pendingEngine) {
    const sourceLabel = pending
      ? pending.source === 'self'
        ? tr('session.ModelSourceMenu.ownAccount')
        : `${pending.source === 'custom' ? tr('customApi.source') : tr('session.ModelSourceMenu.platform')}${pending.name ? ` · ${pending.name}` : ''}`
      : ''
    // 换引擎和换来源一起记着时合成一条：引擎在前、来源在后；撤销一次两个都还原（引擎先改回，来源再改回原来正在跑的）
    const label = pendingEngine
      ? pending
        ? `${pendingEngine.name} · ${sourceLabel}`
        : pendingEngine.name
      : sourceLabel
    const undo = (): void => {
      setBusy(true)
      setError(null)
      ;(pendingEngine ? pendingEngine.undo() : Promise.resolve())
        .then(() => pending?.undo())
        .catch((e: unknown) => setError((e as Error).message))
        .finally(() => setBusy(false))
    }
    return (
      <Bar
        tone="info"
        icon={<ArrowLeftRight size={14} />}
        actions={<Action onClick={undo}>{busy ? <Spinner /> : tr('session.SourceHintBar.undoSwitch')}</Action>}
      >
        {tr(pendingEngine ? 'session.SourceHintBar.nextMessageUsesEngine' : 'session.SourceHintBar.nextMessageUses', {
          p0: label,
        })}
        {error && <div className="text-danger">{translateMessage(error)}</div>}
      </Bar>
    )
  }

  const b = live.blocker
  if (live.running) return null
  // 像素星空的自有是命令行自己配的 Key：没配时不给「用自有账号」（改过去只会再报一次错）
  const useSelf = selfSourceReady(engineId, catalog) ? (
    <Action onClick={() => onRequestSource('self')}>
      {live.started
        ? tr('session.live.NoticeActions.continueWithOwnAccount')
        : tr('session.SourceHintBar.useOwnAccount')}
    </Action>
  ) : null
  const usePlatformBtn = live.platformAvailable ? (
    <Action onClick={() => onRequestSource('platform')}>
      {live.started ? tr('session.live.NoticeActions.continueWithPlatform') : tr('session.SourceHintBar.usePlatform')}
    </Action>
  ) : null

  const openEndpoints = <Action onClick={() => settings.openSettings('models')}>{tr('customApi.manage')}</Action>
  if (!b) {
    // 发送前就知道会失败：像素星空在用自有，但命令行一个能用的模型都没有（没配 Key）
    if (!pixelSelfMissing(engineId, live.source, catalog)) return null
    return (
      <Bar
        tone="warn"
        icon={<TriangleAlert size={14} />}
        actions={
          <>
            {usePlatformBtn}
            {openEndpoints}
          </>
        }
      >
        {tr('modelChannels.pixelSelf.missing')}
      </Bar>
    )
  }
  switch (b.kind) {
    case 'custom-none':
      return (
        <Bar
          tone="warn"
          icon={<TriangleAlert size={14} />}
          actions={
            <>
              {usePlatformBtn}
              {openEndpoints}
            </>
          }
        >
          {tr('customApi.noEndpointForEngine')}
        </Bar>
      )
    case 'custom-deleted':
      return (
        <Bar
          tone="danger"
          icon={<CircleAlert size={14} />}
          actions={
            <>
              {usePlatformBtn}
              <Action onClick={onOpenMenu}>{tr('customApi.switchEndpoint')}</Action>
            </>
          }
        >
          {tr('customApi.endpointDeleted')}
        </Bar>
      )
    case 'custom-key':
      return (
        <Bar
          tone="warn"
          icon={<TriangleAlert size={14} />}
          actions={<Action onClick={() => settings.openSettings('models')}>{tr('customApi.editEndpoint')}</Action>}
        >
          {b.name} · {tr('customApi.noKey')}
        </Bar>
      )
    case 'signin':
      return (
        <Bar
          tone="warn"
          icon={<TriangleAlert size={14} />}
          actions={
            <>
              {useSelf}
              <Action primary onClick={() => void account.login()}>
                {tr('account.AccountMenu.signIn')}
              </Action>
            </>
          }
        >
          {tr('session.SourceHintBar.signInToPixel')}{' '}
        </Bar>
      )
    case 'account':
      return (
        <Bar tone="warn" icon={<TriangleAlert size={14} />} actions={useSelf}>
          {tr('session.SourceHintBar.thisConversationUses')} {b.account}
          {tr('session.SourceHintBar.sPlatformCreditsSigned')}{' '}
        </Bar>
      )
    case 'no-route':
      return (
        <Bar
          tone="danger"
          icon={<CircleAlert size={14} />}
          actions={
            <>
              {useSelf}
              {b.balance && (
                <Action onClick={() => settings.openSettings('account')}>
                  {tr('session.live.NoticeActions.viewAccount')}
                </Action>
              )}
              <Action onClick={() => void refreshPlatform()}>{tr('session.ModelSourceMenu.retry')}</Action>
            </>
          }
        >
          {translateMessage(b.message)}
        </Bar>
      )
    case 'balance':
      return (
        <Bar
          tone="warn"
          icon={<TriangleAlert size={14} />}
          actions={
            <>
              {useSelf}
              <Action onClick={onOpenMenu}>{tr('session.live.NoticeActions.changeRoute')}</Action>
              <Action onClick={() => settings.openSettings('account')}>
                {tr('session.live.NoticeActions.viewAccount')}
              </Action>
            </>
          }
        >
          {tr('session.SourceHintBar.insufficientBalanceThisRoute')}{' '}
        </Bar>
      )
    case 'self-auth':
    case 'self-missing':
      return (
        <Bar
          tone="warn"
          icon={<TriangleAlert size={14} />}
          actions={
            <>
              {usePlatformBtn}
              <Action onClick={live.redetect}>{tr('session.SourceHintBar.detectAgain')}</Action>
              {b.kind === 'self-auth' && isAuthChannel(live.channel) && (
                <Action primary onClick={() => openAuthDialog(live.channel as AuthChannel)}>
                  {tr('modelChannels.action.auth')}
                </Action>
              )}
            </>
          }
        >
          <span className="selectable">{translateMessage(b.message)}</span>
        </Bar>
      )
  }
}
