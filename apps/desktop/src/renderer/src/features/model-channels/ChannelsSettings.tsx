import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
// 设置 › 模型通道（docs/ui/model-channels.md §2.1）：四张通道卡（状态 + 授权 / 登录按钮），自定义接口列在第四张里；
// 最下面「新对话用：接着上次 / 固定为」（§2.6）
import { useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Columns2, LogIn, PanelTop } from 'lucide-react'
import { Button, EngineIcon, Popover, Segmented, Select, Spinner, cn } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { useAccount } from '@/features/account/useAccount'
import { usePlatformCatalog } from '@/features/account/platform'
import { useProviders } from '@/features/account/providers'
import { selfModelLabel, selfModelOptions } from '@/features/engine/labels'
import { useEngineCatalog } from '@/features/engine/catalog'
import { useEngineState } from '@/features/engine/store'
import { useMachines } from '@/features/machines/store'
import { useSettings } from '@/features/settings/SettingsProvider'
import { CustomApiSettings } from '@/features/settings/models/CustomApiSettings'
import {
  AUTH_ENGINE,
  buildChannelMenu,
  channelState,
  sameTarget,
  type AuthChannel,
  type ChannelChoice,
  type ChannelId,
} from './channelModel'
import {
  CHANNEL_DIGIT,
  CHANNEL_NUMBER,
  accountText,
  channelFix,
  channelLabel,
  channelShort,
  channelStateText,
  executorName,
} from './channelLabels'
import { setMenuLayout, useChannelPrefs } from './channelPrefs'
import { openAuthDialog } from './authDialogStore'
import { logoutEngine, useChannelEngines } from './loginStore'
import { currentNewTaskChoice, pinNewTask } from './newTaskDefault'
import { ACCOUNT_ENGINE, openAccountsPage, useAccounts } from './accountsStore'
import { AccountPickList } from './AccountsUI'

export function ChannelsSettings() {
  useI18n()
  return (
    <div data-setting-title={tr('modelChannels.title')} className="flex flex-col gap-3">
      <PlatformCard />
      <AuthCard channel="claude" />
      <AuthCard channel="chatgpt" />
      <Card channel="custom" status={tr('modelChannels.custom.desc')}>
        <div className="border-t border-line-subtle px-4 pb-3">
          <CustomApiSettings />
        </div>
      </Card>
      <NewTaskRow />
      <MenuLayoutRow />
    </div>
  )
}

function Card({
  channel,
  status,
  sub,
  icon,
  primary,
  secondary,
  children,
}: {
  channel: ChannelId
  status: ReactNode
  sub?: ReactNode
  /** 右边按钮区分三列：图标、主按钮、次按钮，宽度固定，几张卡的按钮上下对齐（按钮自己用 w-full） */
  icon?: ReactNode
  primary?: ReactNode
  secondary?: ReactNode
  children?: ReactNode
}) {
  return (
    <div
      data-channel-card={channel}
      data-setting-title={channelLabel(channel)}
      className="scroll-mt-4 rounded-lg border border-line"
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-subtle text-meta font-semibold text-fg-secondary">
          {CHANNEL_DIGIT[channel]}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-ui font-medium text-fg">{channelLabel(channel)}</span>
          <span className="block truncate text-meta text-fg-muted">{status}</span>
          {/* 说明和报错可能较长：换行显示，不截断 */}
          {sub && <span className="block break-words text-meta text-fg-faint">{sub}</span>}
        </span>
        {(icon || primary || secondary) && (
          <span className="flex shrink-0 items-center gap-2">
            <span className="flex w-4 justify-center">{icon}</span>
            {secondary ? (
              <>
                <span className="flex w-28">{primary}</span>
                <span className="flex w-24">{secondary}</span>
              </>
            ) : (
              // 只有一个按钮（登录、授权、修复）：占两列，靠右
              <span className="flex w-[13.5rem] justify-end">{primary}</span>
            )}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

function PlatformCard() {
  useI18n()
  const account = useAccount()
  const catalog = usePlatformCatalog()
  const settings = useSettings()
  if (!catalog.email)
    return (
      <Card
        channel="platform"
        status={tr('modelChannels.platform.desc')}
        primary={
          <Button variant="primary" icon={LogIn} onClick={() => void account.login()}>
            {tr('modelChannels.platform.signIn')}
          </Button>
        }
      />
    )
  return (
    <Card
      channel="platform"
      status={
        <>
          <span className="text-fg">{catalog.email}</span>
          {account.balanceText && (
            <span className="tabular-nums">
              {' '}
              {tr('settings.models.ModelsSection.balance', { p0: account.balanceText })}
            </span>
          )}
        </>
      }
      sub={tr('modelChannels.platform.engines')}
      primary={
        <Button className={FILL} onClick={() => settings.openSettings('account')}>
          {tr('modelChannels.platform.account')}
        </Button>
      }
      secondary={
        <Button variant="ghost" className={FILL} onClick={() => void account.logout()}>
          {tr('modelChannels.platform.signOut')}
        </Button>
      }
    />
  )
}

function AuthCard({ channel }: { channel: AuthChannel }) {
  useI18n()
  const engine = AUTH_ENGINE[channel]
  const engines = useChannelEngines()
  const info = engines.find(e => e.id === engine)
  const machine = useMachines().currentId
  const settings = useSettings()
  const [confirm, setConfirm] = useState<'logout' | 'switch' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const state = channelState(channel, {
    platform: { email: null, loaded: false, loading: false, groups: [] },
    engines,
    providers: [],
  })
  const fix = channelFix(state)
  const desc = tr(`modelChannels.${channel}.desc`)
  // 远程机器（SSH / WSL）上的引擎要在那台机器上登录（§6）
  const remote = machine !== 'local'
  // Codex 用 config.toml 里自己的接口（docs/ui/model-channels.md §3 第 6 条）
  const provider = state.kind === 'ready' && info?.auth?.kind === 'provider' ? (info.auth.provider ?? '') : null
  // 订阅账号多开（docs/ui/engine-accounts.md）：本机、用订阅登录的才有账号下拉和「管理账号」
  const accountEngine = ACCOUNT_ENGINE[channel]
  const accounts = useAccounts(accountEngine)
  const multi = !!accountEngine && !!accounts && !remote && provider === null && info?.auth?.kind === 'login'
  const [picker, setPicker] = useState(false)
  const pickerAnchor = useRef<HTMLSpanElement>(null)

  const logout = (then?: () => void): void => {
    setBusy(true)
    setError(null)
    void logoutEngine(engine).then(err => {
      setBusy(false)
      setConfirm(null)
      if (err) setError(err)
      else then?.()
    })
  }

  let status: ReactNode = desc
  let primary: ReactNode = null
  let secondary: ReactNode = null
  if (state.kind === 'loading') status = <Spinner />
  else if (state.kind === 'ready') {
    const signedIn = accountText(info?.account, channel)
    status = (
      <>
        <span className="text-fg">
          {provider !== null
            ? tr('modelChannels.authCard.provider', { p0: provider })
            : signedIn ||
              tr(info?.auth?.kind === 'apiKey' ? 'modelChannels.authCard.apiKey' : 'modelChannels.auth.done')}
        </span>
        {multi && accounts.accounts.length > 1 && (
          <span> · {tr('accounts.count', { n: accounts.accounts.length })}</span>
        )}
      </>
    )
    // 自己配置的接口不用授权、取消不掉：只在同时还登着账号时给「取消授权」
    if (multi) {
      primary = (
        <>
          <span ref={pickerAnchor} className="flex w-full">
            <Button className={FILL} aria-haspopup="menu" aria-expanded={picker} onClick={() => setPicker(v => !v)}>
              {tr('accounts.switch')}
              <ChevronDown size={13} strokeWidth={1.75} className="text-fg-muted" />
            </Button>
          </span>
          <Popover
            open={picker}
            onClose={() => setPicker(false)}
            anchor={pickerAnchor}
            side="bottom"
            align="end"
            className="w-80"
            role="menu"
          >
            <AccountPickList
              engine={accountEngine}
              onDone={() => setPicker(false)}
              onManage={() => {
                setPicker(false)
                openAccountsPage(channel)
              }}
              footer={
                <>
                  <div role="separator" className="my-1 border-t border-line-subtle" />
                  <button
                    type="button"
                    data-menu-item
                    onClick={() => {
                      setPicker(false)
                      setConfirm('logout')
                    }}
                    className="flex h-8 w-full items-center rounded-md px-2 text-left text-ui text-danger hover:bg-hover"
                  >
                    {tr('accounts.logoutCurrent')}
                  </button>
                </>
              }
            />
          </Popover>
        </>
      )
      secondary = (
        <Button variant="ghost" className={FILL} onClick={() => openAccountsPage(channel)}>
          {tr('accounts.manage')}
        </Button>
      )
    } else if (!remote && !(provider !== null && !info?.account)) {
      const logoutButton = (
        <Button variant="ghost" className={FILL} onClick={() => setConfirm('logout')}>
          {tr('modelChannels.authCard.logout')}
        </Button>
      )
      if (provider === null) {
        primary = (
          <Button className={FILL} onClick={() => setConfirm('switch')}>
            {tr('modelChannels.authCard.switch')}
          </Button>
        )
        secondary = logoutButton
      } else primary = logoutButton
    }
  } else if (state.kind === 'auth') {
    primary = remote ? null : (
      <Button variant="primary" onClick={() => openAuthDialog(channel)}>
        {tr(`modelChannels.${channel}.signIn`)}
      </Button>
    )
  } else {
    status = <span className="text-warn">{channelStateText(channel, state)}</span>
    primary = fix && (
      <Button onClick={() => settings.openSettings('engines')}>{tr(`modelChannels.action.${fixKey(fix)}`)}</Button>
    )
  }

  return (
    <>
      <Card
        channel={channel}
        status={status}
        sub={
          remote ? (
            tr('modelChannels.authCard.remote')
          ) : error ? (
            <span className="text-danger">{translateMessage(error)}</span>
          ) : provider !== null ? (
            tr('modelChannels.authCard.providerHint')
          ) : state.kind !== 'ready' && state.kind !== 'auth' ? (
            desc
          ) : null
        }
        icon={<EngineIcon engine={engine} size={14} className="opacity-70" />}
        primary={primary}
        secondary={secondary}
      />
      {confirm && (
        <ConfirmDialog
          title={tr(
            confirm === 'switch' ? 'modelChannels.authCard.switchTitle' : 'modelChannels.authCard.logoutTitle',
            {
              p0: channelLabel(channel),
            },
          )}
          description={tr(
            confirm === 'switch' ? 'modelChannels.authCard.switchDesc' : 'modelChannels.authCard.logoutDesc',
            { p0: info?.name ?? engine },
          )}
          confirmLabel={tr(confirm === 'switch' ? 'modelChannels.authCard.switch' : 'modelChannels.authCard.logout')}
          cancelLabel={tr('modelChannels.auth.cancel')}
          danger={confirm === 'logout'}
          busy={busy}
          error={error}
          onCancel={() => setConfirm(null)}
          onConfirm={() => logout(confirm === 'switch' ? () => openAuthDialog(channel) : undefined)}
        />
      )}
    </>
  )
}

/** 按钮撑满它那一列、文字居中 */
const FILL = 'w-full justify-center'

const fixKey = (fix: NonNullable<ReturnType<typeof channelFix>>): 'install' | 'update' | 'view' =>
  fix === 'install' ? 'install' : fix === 'update' ? 'update' : 'view'

/** 输入框模型菜单的排法：标签页（默认）/ 两栏（§2.3） */
function MenuLayoutRow() {
  useI18n()
  const prefs = useChannelPrefs()
  return (
    <div
      data-setting-title={tr('modelChannels.menu.layout')}
      className="flex items-center justify-between gap-4 rounded-lg border border-line px-4 py-3"
    >
      <div className="min-w-0">
        <div className="text-ui font-medium text-fg">{tr('modelChannels.menu.layout')}</div>
        <p className="mt-0.5 text-meta text-fg-muted">{tr('modelChannels.menu.layoutDesc')}</p>
      </div>
      <Segmented
        label={tr('modelChannels.menu.layout')}
        value={prefs.menuLayout}
        onChange={setMenuLayout}
        options={[
          { value: 'tabs', label: tr('modelChannels.menu.layoutTabs'), icon: PanelTop },
          { value: 'cols', label: tr('modelChannels.menu.layoutCols'), icon: Columns2 },
        ]}
      />
    </div>
  )
}

/** 「新对话用」：接着上次（默认）/ 固定为某个模型 */
function NewTaskRow() {
  useI18n()
  const prefs = useChannelPrefs()
  const defaultEngine = useEngineState(s => s.defaults?.engine) ?? 'claude'
  const catalog = usePlatformCatalog()
  const providers = useProviders()
  const engines = useChannelEngines()
  const claudeCatalog = useEngineCatalog('claude')
  const codexCatalog = useEngineCatalog('codex')
  const fixed = prefs.newTask.mode === 'fixed' ? prefs.newTask.choice : null
  const groups = buildChannelMenu({
    selection: fixed,
    current: null,
    platform: catalog,
    selfModels: {
      claude: selfModelOptions('claude', claudeCatalog?.models),
      chatgpt: selfModelOptions('codex', codexCatalog?.models),
    },
    providers: providers.providers,
    engines,
    remembered: prefs.executors,
  })
  // 每个模型按它能跑的执行者各列一项（能换执行者的模型列两项）
  const options: Array<{ value: string; label: string; choice: ChannelChoice }> = []
  for (const g of groups)
    for (const row of g.rows)
      for (const engine of row.pick.options) {
        const choice: ChannelChoice = { ...row.target, engine }
        const provider = providers.providers.find(p => p.id === row.target.providerId)
        const model =
          g.channel === 'claude' || g.channel === 'chatgpt'
            ? selfModelLabel(engine, row.target.model)
            : (row.target.model ?? '')
        const where = g.channel === 'custom' ? (provider?.name ?? channelShort('custom')) : channelShort(g.channel)
        options.push({
          value: `${row.key}|${engine}`,
          label: `${CHANNEL_NUMBER[g.channel]} ${where} · ${model} · ${executorName(engine)}`,
          choice,
        })
      }
  const value = fixed ? options.find(o => sameTarget(o.choice, fixed) && o.choice.engine === fixed.engine) : undefined
  const missing = !!fixed && !value

  return (
    <div
      data-setting-title={tr('modelChannels.newTask.title')}
      className="mt-2 rounded-lg border border-line px-4 py-3"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-ui font-medium text-fg">{tr('modelChannels.newTask.title')}</div>
          <p className="mt-0.5 text-meta text-fg-muted">{tr('modelChannels.newTask.desc')}</p>
        </div>
        <Segmented
          label={tr('modelChannels.newTask.title')}
          value={prefs.newTask.mode}
          onChange={mode => pinNewTask(mode === 'last' ? null : (value?.choice ?? currentNewTaskChoice(defaultEngine)))}
          options={[
            { value: 'last', label: tr('modelChannels.continueLast') },
            { value: 'fixed', label: tr('modelChannels.newTask.fixed') },
          ]}
        />
      </div>
      {fixed && (
        <div className={cn('mt-3 flex items-center gap-2')}>
          <Select
            label={tr('modelChannels.newTask.fixed')}
            value={value?.value ?? ''}
            placeholder={tr('modelChannels.newTask.pick')}
            options={options.map(o => ({ value: o.value, label: o.label }))}
            onChange={v => {
              const o = options.find(x => x.value === v)
              if (o) pinNewTask(o.choice)
            }}
            className="min-w-0 flex-1"
          />
        </div>
      )}
      {missing && <p className="mt-2 text-meta text-warn">{tr('modelChannels.newTask.missing')}</p>}
    </div>
  )
}
