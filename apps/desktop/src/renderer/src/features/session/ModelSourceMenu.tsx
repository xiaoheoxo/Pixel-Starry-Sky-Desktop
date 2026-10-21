import { scrollInPane } from '@/ui/scrollInPane'
import { translateMessage } from '../../i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
// 输入框的模型菜单（docs/ui/model-channels.md §2.3、§2.5）：上面一个跨通道的搜索框，下面按通道分标签页（默认）
// 或两栏（设置里换，窗格放不下时按标签页），没设置的通道收进「＋」。能换执行者的行右边有下拉。
// 平台模型的线路在子页里，按倍率从低到高排（docs/ui/source-switch.md §3.2）。
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns2,
  PanelTop,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  TriangleAlert,
  X,
} from 'lucide-react'
import type { EngineId } from '@pixelsky/protocol'
import { EngineIcon, Kbd, PlanBadge, Popover, Spinner, cn } from '@/ui'
import { useAccount } from '@/features/account/useAccount'
import { useProviders } from '@/features/account/providers'
import {
  billingLabel,
  formatMultiplier,
  groupsForModel,
  noRouteReason,
  refreshPlatform,
  usePlatform,
  usePlatformCatalog,
} from '@/features/account/platform'
import { selfModelLabel, selfModelOptions, type SourceMenuController } from '@/features/engine'
import { useSettings } from '@/features/settings/SettingsProvider'
import { useEngineCatalog } from '@/features/engine/catalog'
import { requestModelsScroll } from '@/features/settings/models/scroll'
import {
  AUTH_ENGINE,
  buildChannelMenu,
  isAuthChannel,
  sameTarget,
  type ChannelChoice,
  type ChannelGroupView,
  type ChannelId,
  type ChannelRow,
  type ModelTarget,
} from '@/features/model-channels/channelModel'
import {
  CHANNEL_DIGIT,
  maskEmail,
  planLabel,
  channelFix,
  channelFixLabel,
  channelLabel,
  channelShort,
  channelStateText,
  executorDesc,
  executorName,
} from '@/features/model-channels/channelLabels'
import { rememberExecutor, setMenuLayout, useChannelPrefs } from '@/features/model-channels/channelPrefs'
import { planInfo, type PlanProvider } from '@/features/model-channels/plans'
import {
  COLS_MENU_WIDTH,
  MENU_ROW,
  highlightParts,
  isBroken,
  listRows,
  resolveView,
  searchChannels,
  splitChannels,
  stepView,
  type MenuLayout,
} from '@/features/model-channels/menuModel'
import { pinNewTask } from '@/features/model-channels/newTaskDefault'
import { openAuthDialog } from '@/features/model-channels/authDialogStore'
import { useChannelEngines } from '@/features/model-channels/loginStore'
import { openAccountsPage, useAccounts } from '@/features/model-channels/accountsStore'
import { AccountPickList } from '@/features/model-channels/AccountsUI'
import { MenuRow, TRIGGER } from './ComposerMenus'
import { QuotaInline } from './quota/QuotaInline'

const CLIPS = /(hidden|clip|auto|scroll)/

/** 祖先里会裁掉溢出内容的容器围出的范围（窗口坐标），也就是模型按钮所在的窗格；没有时是整个窗口 */
function clipRect(el: Element | null | undefined): { top: number; left: number; right: number } {
  let top = 0,
    left = 0,
    right = window.innerWidth
  for (let e = el?.parentElement; e; e = e.parentElement) {
    const style = getComputedStyle(e)
    const y = CLIPS.test(style.overflowY),
      x = CLIPS.test(style.overflowX)
    if (!x && !y) continue
    const r = e.getBoundingClientRect()
    if (y) top = Math.max(top, r.top)
    if (x) {
      left = Math.max(left, r.left)
      right = Math.min(right, r.right)
    }
  }
  return { top, left, right }
}

/** 菜单里的小按钮（设置页的 Button 是 32px 高，这里一行只有 30px） */
const MINI_BUTTON =
  'press inline-flex h-[26px] shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2.5 text-meta'
const MINI_OUTLINE = 'border border-line bg-surface text-fg-secondary hover:border-line-strong hover:text-fg'
const MINI_PRIMARY = 'bg-primary text-primary-fg hover:opacity-90'
/** 标签栏占的高度（px）：搜索时标签栏收起，列表补上这块，菜单不跳 */
const TAB_BAR = 34
/** 两栏左边一个通道的高度（px） */
const SIDE_ITEM = 44

type Page = { kind: 'main' } | { kind: 'routes' }
type View = ChannelId | 'add'

export function ModelSourceMenu({
  live,
  newTask,
  open,
  onOpenChange,
  onRequestChoice,
}: {
  live: SourceMenuController
  /** 欢迎页的输入框：没自己选过时写「接着上次」 */
  newTask?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 已开始的对话换到别的通道：由输入框先弹确认（会重启引擎并接上原对话） */
  onRequestChoice: (choice: ChannelChoice) => void
}) {
  useI18n()
  const engineId: EngineId = live.engine?.id ?? 'claude'
  const platform = usePlatform(engineId)
  const catalog = usePlatformCatalog()
  const ownCatalog = useEngineCatalog(engineId)
  const claudeCatalog = useEngineCatalog('claude')
  const codexCatalog = useEngineCatalog('codex')
  const engines = useChannelEngines()
  const providers = useProviders()
  const prefs = useChannelPrefs()
  const account = useAccount()
  const settings = useSettings()
  const [page, setPage] = useState<Page>({ kind: 'main' })
  const [actionError, setActionError] = useState<string | null>(null)
  /** 看的哪个通道；null 是刚打开，按当前通道定 */
  const [view, setView] = useState<View | null>(null)
  const [query, setQuery] = useState('')
  /** 键盘 ↑/↓ 停在第几个能选的行；-1 是没停 */
  const [active, setActive] = useState(-1)
  /** 开着「谁来执行」下拉的那一行 */
  const [exMenu, setExMenu] = useState<string | null>(null)
  /** 这个输入框里自己选过模型：不再显示「接着上次」 */
  const [picked, setPicked] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState({ height: 420, cols: true })
  // Claude / ChatGPT 账号行的「切换账号」：存了的账号列成子菜单（docs/ui/engine-accounts.md §6、engine-accounts-claude.md）；
  // 远程机器上为 null，还是去设置
  const accountLists = { claude: useAccounts('claude'), chatgpt: useAccounts('codex') }
  const [accountMenu, setAccountMenu] = useState(false)
  const accountAnchor = useRef<HTMLButtonElement>(null)
  // 菜单向上弹出，最高只到裁剪它的容器（窗格）顶部，不能按窗口顶部算：
  // 窗格在顶栏下面（分屏时可能更低），按窗口算时长菜单的上半截会被窗格裁掉。
  // 两栏也按窗格算：窗格放不下 540px（两边各留 8px）时按标签页显示；菜单横向挪进窗格里（Popover within）。
  useLayoutEffect(() => {
    if (!open) return
    const measure = (): void => {
      const el = trigger.current
      const r = el?.getBoundingClientRect()
      const clip = clipRect(el)
      setFit({
        height: Math.max(120, Math.min(window.innerHeight * 0.7, (r?.top ?? window.innerHeight) - clip.top - 32)),
        cols: Math.min(clip.right, window.innerWidth) - clip.left - 16 >= COLS_MENU_WIDTH,
      })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open])

  useEffect(() => {
    if (!open) return
    setPage({ kind: 'main' })
    setActionError(null)
    setView(null)
    setQuery('')
    setActive(-1)
    setExMenu(null)
    void refreshPlatform()
  }, [open])

  useEffect(() => {
    if (open) scrollInPane(list.current?.querySelector('[data-active]'), 'nearest')
  }, [open, active])

  const selection: ModelTarget = { channel: live.channel, model: live.model, providerId: live.providerId }
  const selfModels = {
    claude: selfModelOptions('claude', claudeCatalog?.models),
    chatgpt: selfModelOptions('codex', codexCatalog?.models),
  }
  const groups = buildChannelMenu({
    selection,
    // 已开始的对话沿用当前引擎，换引擎要在行右边的「谁来执行」里选（会先确认）
    current: live.started ? engineId : null,
    platform: catalog,
    selfModels,
    providers: providers.providers,
    engines,
    remembered: prefs.executors,
  })
  const channels = splitChannels(groups, { current: live.channel, started: live.started })
  const layout: MenuLayout = prefs.menuLayout === 'cols' && fit.cols ? 'cols' : 'tabs'
  const narrow = prefs.menuLayout === 'cols' && !fit.cols
  const at = resolveView(view, channels, live.channel)
  const searching = query.trim() !== ''
  /** 标签页只有一个设置好的通道：不要标签栏，信息行写通道名，「添加通道」放底栏 */
  const single = layout === 'tabs' && channels.shown.length === 1
  const route = platform.groups.find(g => g.id === live.groupId)
  const endpoint = providers.providers.find(p => p.id === live.providerId)
  const notReady = live.blocker !== null && live.blocker.kind !== 'balance'

  const run = (fn: () => Promise<void>): void => {
    setActionError(null)
    fn().catch((e: unknown) => setActionError((e as Error).message))
  }
  const manageModels = (): void => {
    onOpenChange(false)
    requestModelsScroll()
    settings.openSettings('models')
  }
  /** 设置 › 模型通道（最上面是四张通道卡） */
  const openChannels = (): void => {
    onOpenChange(false)
    settings.openSettings('models')
  }
  const go = (v: View): void => {
    setView(v)
    setActive(-1)
    setExMenu(null)
  }

  /** 选了一个模型；keepOpen：自定义接口那一行（下面还要选模型） */
  const choose = (target: ModelTarget, engine: EngineId | null, keepOpen = false): void => {
    if (!engine) return
    setPicked(true)
    const choice: ChannelChoice = { ...target, engine }
    // 已开始的对话换通道 / 换引擎：先确认（换引擎会把之前的对话整理成交接内容带过去）
    if (live.started && (target.channel !== live.channel || engine !== engineId)) {
      onOpenChange(false)
      onRequestChoice(choice)
      return
    }
    // 成功了才收起菜单：出错时原因写在菜单里
    run(async () => {
      await live.applyChoice(choice)
      if (!keepOpen) onOpenChange(false)
    })
  }

  /** 通道不能用 / 还没设置时的按钮 */
  const fixChannel = (g: ChannelGroupView): void => {
    const fix = channelFix(g.state)
    if (fix === 'signin') void account.login()
    else if (fix === 'retry') void refreshPlatform()
    else if (fix === 'auth' && isAuthChannel(g.channel)) {
      onOpenChange(false)
      openAuthDialog(g.channel)
    } else if (fix === 'add-endpoint') openChannels()
    else if (fix) {
      onOpenChange(false)
      settings.openSettings('engines')
    }
  }

  const providerOf = (row: ChannelRow) => providers.providers.find(p => p.id === row.target.providerId)
  const selfOption = (c: ChannelId, row: ChannelRow) =>
    isAuthChannel(c) ? selfModels[c].find(m => m.value === row.target.model) : undefined
  const rowTitle = (c: ChannelId, row: ChannelRow): string =>
    c === 'platform'
      ? (row.target.model ?? '')
      : c === 'custom'
        ? (providerOf(row)?.name ?? '')
        : (selfOption(c, row)?.label ??
          selfModelLabel(
            AUTH_ENGINE[c],
            row.target.model,
            c === 'claude' ? claudeCatalog?.models : codexCatalog?.models,
          ))
  /** 名字后面的淡色小字：执行者不可用 > 自动换了执行者 > 接口的模型 / 别名的说明 */
  const rowDesc = (c: ChannelId, row: ChannelRow): string | undefined => {
    const first = row.candidates[0]
    if (row.disabled === 'no-executor' && first) return tr('modelChannels.row.noExecutor', { p0: executorName(first) })
    if (row.pick.fallbackFrom && row.pick.engine)
      return tr('modelChannels.executor.fallbackMissing', {
        p0: executorName(row.pick.fallbackFrom),
        p1: executorName(row.pick.engine),
      })
    if (c === 'custom') {
      const p = providerOf(row)
      return [row.target.model, p && !p.keyHint ? tr('customApi.noKey') : null].filter(Boolean).join(' · ')
    }
    return selfOption(c, row)?.hint
  }
  /** 平台模型右边：最低倍率，多条线路时写条数 */
  const rowMeta = (c: ChannelId, row: ChannelRow): ReactNode => {
    if (c !== 'platform') return null
    const gs = groupsForModel(catalog.groups, row.target.model)
    const min = gs[0]?.rate_multiplier ?? null
    if (min === null) return null
    const rate = formatMultiplier(min)
    return (
      <>
        <span>{gs.some(g => g.rate_multiplier !== min) ? tr('modelChannels.menu.rateFrom', { p0: rate }) : rate}</span>
        {gs.length > 1 && (
          <span className="text-fg-faint">· {tr('modelChannels.menu.routeCount', { p0: gs.length })}</span>
        )}
      </>
    )
  }

  /** 标签 / 左栏写淡：失效、不能用或没有模型 */
  const dim = (g: ChannelGroupView): boolean => isBroken(g) || g.state.kind !== 'ready' || g.rows.length === 0
  const stateText = (g: ChannelGroupView): string | null =>
    g.channel === 'platform' && g.state.kind === 'no-route'
      ? translateMessage(noRouteReason(catalog, account.account?.balance ?? null).message)
      : channelStateText(g.channel, g.state)
  const brokenTitle = (g: ChannelGroupView): string =>
    g.state.kind === 'signin'
      ? tr('modelChannels.menu.broken.signin')
      : g.state.kind === 'auth'
        ? tr('modelChannels.menu.broken.auth', { p0: channelLabel(g.channel) })
        : g.state.kind === 'empty'
          ? tr('modelChannels.menu.broken.empty')
          : (channelStateText(g.channel, g.state) ?? '')
  const authAccount = (c: ChannelId) =>
    isAuthChannel(c) ? engines.find(e => e.id === AUTH_ENGINE[c])?.account : undefined
  /** 两栏左边的第二行、标签的鼠标提示 */
  const status = (g: ChannelGroupView): string => {
    if (isBroken(g)) return brokenTitle(g)
    const text = stateText(g)
    if (text) return text
    const a = authAccount(g.channel)
    if (a?.email || a?.plan)
      return [a.email && maskEmail(a.email), planLabel(g.channel === 'chatgpt' ? 'chatgpt' : 'claude', a.plan)]
        .filter(Boolean)
        .join(' · ')
    const count = tr('modelChannels.menu.usable', { p0: g.rows.length })
    return g.channel === 'platform' && account.balanceText ? `${account.balanceText} · ${count}` : count
  }
  const addTitle = tr('modelChannels.menu.addTitle', {
    p0: channels.unset.map(g => channelLabel(g.channel)).join('、'),
  })

  // 能选的行按显示顺序记下来，键盘 ↑/↓、Enter 用
  const picks: Array<() => void> = []

  const renderRow = (g: ChannelGroupView, row: ChannelRow, inSearch = false): ReactNode => {
    const c = g.channel
    const provider = c === 'custom' ? providerOf(row) : undefined
    const multi = !!provider && provider.models.length > 1
    // 选中的自定义接口有多个模型：下面展开选模型（搜索结果里不展开，选了就回到它的通道展开）
    const expand = multi && row.selected && !inSearch
    const pick = (): void => {
      choose(row.target, row.pick.engine, multi)
      if (multi && inSearch) {
        setQuery('')
        go(c)
      }
    }
    const idx = row.disabled ? -1 : picks.push(pick) - 1
    return (
      <div key={row.key}>
        <ModelRow
          title={rowTitle(c, row)}
          mono={c === 'platform'}
          desc={rowDesc(c, row)}
          descMono={c === 'custom'}
          meta={rowMeta(c, row)}
          query={query}
          selected={row.selected && !expand}
          active={idx >= 0 && idx === active}
          off={row.disabled !== null}
          onPick={pick}
          onHover={idx >= 0 ? () => setActive(idx) : undefined}
          chip={
            // 授权通道只交给官方工具，不用每行写
            !isAuthChannel(c) && (
              <ExecutorChip
                row={row}
                expanded={row.selected || idx === active}
                open={exMenu === row.key}
                onOpenChange={o => setExMenu(o ? row.key : null)}
                onPick={e => {
                  setExMenu(null)
                  // 已开始的对话换引擎要先确认，不提前记
                  if (!live.started) rememberExecutor(row.target, e)
                  choose(row.target, e)
                }}
              />
            )
          }
        />
        {/* 选中的平台模型：下面一行是线路（点开子页） */}
        {c === 'platform' && row.selected && live.channel === 'platform' && !inSearch && (
          <PlatformRoute live={live} onOpenRoutes={() => setPage({ kind: 'routes' })} />
        )}
        {expand &&
          provider!.models.map(m => {
            const pickModel = (): void => choose({ ...row.target, model: m.id }, row.pick.engine)
            const i = picks.push(pickModel) - 1
            return (
              <ModelRow
                key={m.id}
                indent
                mono
                title={m.id}
                selected={m.id === live.model}
                active={i === active}
                onPick={pickModel}
                onHover={() => setActive(i)}
              />
            )
          })}
      </div>
    )
  }

  const renderInfo = (g: ChannelGroupView): ReactNode => {
    if (g.state.kind !== 'ready' || g.rows.length === 0) return null
    const c = g.channel
    const a = authAccount(c)
    const [label, onClick]: [string, () => void] =
      c === 'platform'
        ? [
            tr('modelChannels.platform.account'),
            () => {
              onOpenChange(false)
              settings.openSettings('account')
            },
          ]
        : c === 'custom'
          ? [tr('modelChannels.menu.manageEndpoints'), openChannels]
          : [tr('modelChannels.menu.switchAccount'), openChannels]
    return (
      <div data-channel-info={c} className="flex h-[30px] items-center gap-1.5 px-2 text-label text-fg-muted">
        {single && (
          <>
            <span className="shrink-0 font-medium text-fg-secondary">{channelLabel(c)}</span>
            <span className="text-fg-faint">·</span>
          </>
        )}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {c === 'platform' ? (
            account.balanceText && (
              <span className="truncate">
                {tr('account.AccountMenu.balance')}{' '}
                <span className="font-medium text-fg tabular-nums">{account.balanceText}</span>
              </span>
            )
          ) : c === 'custom' ? (
            <span className="truncate">{providers.providers.map(p => p.name).join('、')}</span>
          ) : (
            <>
              <AccountTag account={a} provider={c === 'chatgpt' ? 'chatgpt' : 'claude'} />
              {/* Claude / ChatGPT 授权账号后面的额度简写；平台那一列已经显示余额，不加 */}
              <QuotaInline provider={c === 'claude' ? 'claude' : 'chatgpt'} />
            </>
          )}
        </span>
        {(c === 'chatgpt' || c === 'claude') && accountLists[c] ? (
          <>
            <button
              ref={accountAnchor}
              type="button"
              aria-haspopup="menu"
              aria-expanded={accountMenu}
              data-account-switch
              onClick={() => setAccountMenu(v => !v)}
              className={cn(
                'flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-label text-fg-muted hover:bg-hover hover:text-fg',
                accountMenu && 'bg-selected text-fg',
              )}
            >
              {label}
              <ChevronRight size={12} strokeWidth={1.75} />
            </button>
            <Popover
              open={accountMenu}
              onClose={() => setAccountMenu(false)}
              anchor={accountAnchor}
              side="right"
              align="start"
              offset={8}
              className="w-72"
              role="menu"
            >
              <AccountPickList
                engine={c === 'claude' ? 'claude' : 'codex'}
                onDone={() => setAccountMenu(false)}
                onManage={() => {
                  setAccountMenu(false)
                  openAccountsPage(c)
                  openChannels()
                }}
                footer={<p className="px-2 pt-1.5 pb-1 text-label text-fg-faint">{tr('accounts.menuHint')}</p>}
              />
            </Popover>
          </>
        ) : (
          <button
            type="button"
            onClick={onClick}
            className="shrink-0 rounded px-1.5 py-0.5 text-label text-fg-muted hover:bg-hover hover:text-fg"
          >
            {label}
          </button>
        )}
      </div>
    )
  }

  /** 已开始的对话正在用的通道失效了：说清楚、给修复按钮，还能先换别的通道 */
  const renderWarn = (g: ChannelGroupView): ReactNode => {
    const fix = channelFix(g.state)
    const label =
      fix === 'signin'
        ? tr('modelChannels.menu.relogin')
        : fix === 'auth'
          ? tr('modelChannels.menu.reauth')
          : fix
            ? channelFixLabel(fix)
            : ''
    const others = channels.shown.filter(x => x !== g && !dim(x)).map(x => tr(`modelChannels.tab.${x.channel}`))
    return (
      <div
        role="alert"
        data-channel-broken={g.channel}
        className="mt-1.5 flex items-center gap-2 rounded-lg bg-warn/10 py-2 pr-2 pl-2.5 text-meta"
      >
        <TriangleAlert size={14} strokeWidth={1.75} className="mt-px shrink-0 self-start text-warn" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium text-fg">{brokenTitle(g)}</span>
          <span className="text-label text-fg-muted">
            {others.length
              ? tr('modelChannels.menu.brokenHint', { p0: label, p1: others.join(' / ') })
              : tr('modelChannels.menu.brokenHintOnly', { p0: label })}
          </span>
        </span>
        {fix && (
          <button type="button" onClick={() => fixChannel(g)} className={cn(MINI_BUTTON, MINI_PRIMARY)}>
            {label}
          </button>
        )}
      </div>
    )
  }

  const renderChannel = (g: ChannelGroupView): ReactNode => {
    const c = g.channel
    const text = stateText(g)
    if (text) {
      const fix = channelFix(g.state)
      return (
        <div className="flex min-h-[30px] items-center gap-2 px-2 py-1.5 text-meta text-fg-muted">
          {g.state.kind === 'loading' && <Spinner />}
          <span className="min-w-0 flex-1">{text}</span>
          {fix && (
            <button
              type="button"
              onClick={() => fixChannel(g)}
              className="flex shrink-0 items-center text-accent-fg hover:underline"
            >
              {channelFixLabel(fix)}
              <ChevronRight size={12} />
            </button>
          )}
        </div>
      )
    }
    // 会话里的完整模型名（比如从平台切回来的 claude-opus-5-5）不在别名表里时也显示出来
    const extraSelf =
      isAuthChannel(c) && live.channel === c && live.model && !g.rows.some(r => r.target.model === live.model)
        ? live.model
        : null
    const deleted =
      c === 'custom' &&
      live.channel === 'custom' &&
      !!live.providerId &&
      !providers.providers.some(p => p.id === live.providerId)
    const hidden =
      c === 'platform' ? catalog.hiddenModels.filter(m => catalog.groups.some(x => x.models.includes(m))).length : 0
    return (
      <>
        {deleted && <p className="px-2 py-1.5 text-meta text-warn">{tr('customApi.endpointDeleted')}</p>}
        {c === 'platform' && g.rows.length === 0 && (
          <p className="px-2 py-1.5 text-meta text-fg-faint">{tr('session.ModelSourceMenu.allModelsAreHidden')}</p>
        )}
        {g.rows.map(row => renderRow(g, row))}
        {extraSelf && <ModelRow selected mono title={extraSelf} desc={tr('session.ModelSourceMenu.modelUsedByThis')} />}
        {c === 'platform' && (
          <button
            type="button"
            onClick={manageModels}
            className="flex h-[30px] w-full items-center rounded-md pr-2 pl-7 text-left text-meta text-fg-muted hover:bg-hover hover:text-fg"
          >
            {tr('modelChannels.menu.manage')}
            {hidden > 0 && (
              <span className="text-fg-faint">{tr('modelChannels.menu.hiddenCount', { p0: hidden })}</span>
            )}
          </button>
        )}
      </>
    )
  }

  /** 「＋」：没设置的通道，一行一个，说明写两行 */
  const renderSetup = (): ReactNode => {
    const none = channels.shown.length === 0
    return (
      <>
        {single && (
          <button
            type="button"
            onClick={() => go(channels.shown[0].channel)}
            className="mt-0.5 flex h-7 items-center gap-1 rounded-md px-1.5 text-label text-fg-muted hover:bg-hover hover:text-fg"
          >
            <ChevronLeft size={13} />
            {channelLabel(channels.shown[0].channel)}
          </button>
        )}
        {none && (
          <div className="px-2 pt-2.5 pb-1.5">
            <p className="text-ui font-medium text-fg">{tr('modelChannels.menu.none')}</p>
            <p className="text-meta text-fg-muted">{tr('modelChannels.menu.noneHint')}</p>
          </div>
        )}
        {channels.unset.map((g, i) => (
          <div
            key={g.channel}
            data-setup-channel={g.channel}
            className={cn('flex items-center gap-2.5 px-2 py-2', i > 0 && 'border-t border-line-subtle')}
          >
            <Digit channel={g.channel} className="mt-0.5 self-start" />
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="text-ui text-fg">{channelLabel(g.channel)}</span>
              <span className="line-clamp-2 text-label text-fg-faint">{tr(`modelChannels.${g.channel}.desc`)}</span>
            </span>
            <button
              type="button"
              onClick={() => fixChannel(g)}
              className={cn(MINI_BUTTON, none && i === 0 ? MINI_PRIMARY : MINI_OUTLINE)}
            >
              {g.channel === 'custom'
                ? tr('modelChannels.action.addEndpoint')
                : g.state.kind === 'missing'
                  ? tr('modelChannels.action.install')
                  : tr(`modelChannels.${g.channel}.signIn`)}
            </button>
          </div>
        ))}
      </>
    )
  }

  /** 搜索：所有显示的通道里找，按通道分组；这个对话跑不了的按通道数一下 */
  const renderSearch = (): ReactNode => {
    const found = searchChannels(channels, query, (g, row) =>
      [rowTitle(g.channel, row), row.target.model ?? '', rowDesc(g.channel, row) ?? ''].join(' '),
    )
    if (!found.length)
      return <Empty title={tr('modelChannels.menu.noMatch')}>{tr('modelChannels.menu.noMatchHint')}</Empty>
    return (
      <>
        {found.map(({ group, rows }, i) => (
          <div key={group.channel}>
            <p className={cn('px-2 pb-0.5 text-label text-fg-muted', i === 0 ? 'pt-1' : 'pt-2')}>
              {channelLabel(group.channel)}
            </p>
            {rows.map(row => renderRow(group, row, true))}
          </div>
        ))}
      </>
    )
  }

  const body = (withInfo: boolean): ReactNode => {
    if (searching) return renderSearch()
    if (at === 'add') return renderSetup()
    const g = channels.shown.find(x => x.channel === at)
    if (!g) return null
    if (isBroken(g)) return renderWarn(g)
    return (
      <>
        {withInfo && renderInfo(g)}
        {renderChannel(g)}
      </>
    )
  }

  // 列表区高度按最长的通道定（切通道不跳），再被 fit.height 压：容器有 max-height，列表可以缩
  const extraRows = (g: ChannelGroupView): number => {
    if (g.channel === 'platform') return live.channel === 'platform' && g.rows.some(r => r.selected) ? 1 : 0
    if (g.channel === 'custom')
      return live.channel === 'custom' && endpoint && endpoint.models.length > 1 ? endpoint.models.length : 0
    return live.channel === g.channel && live.model && !g.rows.some(r => r.target.model === live.model) ? 1 : 0
  }
  const listPx = listRows(channels, extraRows) * MENU_ROW + 4

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      // 先收「谁来执行」、再清搜索，最后才交给 Popover 关菜单
      if (exMenu) setExMenu(null)
      else if (query) {
        setQuery('')
        setActive(-1)
      } else return
      e.stopPropagation()
      return
    }
    if (exMenu) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!picks.length) return
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      const n = picks.length
      setActive(a => (a < 0 || a >= n ? (d > 0 ? 0 : n - 1) : (a + d + n) % n))
    } else if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
      const pick = picks[active]
      if (pick) {
        e.preventDefault()
        pick()
      }
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !searching && channels.shown.length > 0) {
      e.preventDefault()
      go(stepView(at, channels, e.key === 'ArrowRight' ? 1 : -1))
    }
  }

  const searchLabel = tr('modelChannels.menu.search')
  const searchBox = (
    <label className="flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border border-line bg-subtle pr-1.5 pl-2 text-fg-faint focus-within:border-line-strong focus-within:bg-surface">
      <Search size={13} className="shrink-0" />
      <input
        autoFocus
        data-model-search
        value={query}
        onChange={e => {
          setQuery(e.target.value)
          setActive(e.target.value.trim() ? 0 : -1)
          setExMenu(null)
        }}
        placeholder={searchLabel}
        aria-label={searchLabel}
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-meta text-fg outline-none placeholder:text-fg-faint"
      />
      {query && (
        <button
          type="button"
          onClick={() => {
            setQuery('')
            setActive(-1)
          }}
          title={`${tr('modelChannels.menu.clear')} (Esc)`}
          aria-label={tr('modelChannels.menu.clear')}
          className="grid shrink-0 place-items-center rounded p-0.5 hover:bg-hover hover:text-fg"
        >
          <X size={12} />
        </button>
      )}
    </label>
  )

  const dot = (g: ChannelGroupView, className: string): ReactNode =>
    g.channel === live.channel && (
      <span
        title={tr('modelChannels.menu.current')}
        className={cn('size-[5px] shrink-0 rounded-full', isBroken(g) ? 'bg-warn' : 'bg-accent', className)}
      />
    )

  const tabBar = !single && !searching && (
    <div role="tablist" className="mt-1.5 flex shrink-0 gap-0.5 rounded-lg bg-subtle p-0.5">
      {channels.shown.map(g => (
        <button
          key={g.channel}
          type="button"
          role="tab"
          aria-selected={at === g.channel}
          data-channel-tab={g.channel}
          title={`${channelLabel(g.channel)} · ${status(g)}`}
          onClick={() => go(g.channel)}
          className={cn(
            'flex h-6 min-w-0 flex-1 items-center justify-center rounded-md px-1.5 text-label',
            at === g.channel
              ? 'bg-popover font-medium text-fg shadow-sm'
              : dim(g)
                ? 'text-fg-faint hover:text-fg'
                : 'text-fg-muted hover:text-fg',
          )}
        >
          {/* 当前通道：字的右上角一个小点（失效时是黄色） */}
          <span className="relative min-w-0">
            <span className="block truncate">{tr(`modelChannels.tab.${g.channel}`)}</span>
            {dot(g, 'absolute top-0 -right-[7px]')}
          </span>
        </button>
      ))}
      {channels.unset.length > 0 && (
        <button
          type="button"
          role="tab"
          aria-selected={at === 'add'}
          data-channel-tab="add"
          title={addTitle}
          aria-label={addTitle}
          onClick={() => go('add')}
          className={cn(
            'flex h-6 w-[30px] shrink-0 items-center justify-center rounded-md',
            at === 'add' ? 'bg-popover text-fg shadow-sm' : 'text-fg-muted hover:text-fg',
          )}
        >
          <Plus size={13} />
        </button>
      )}
    </div>
  )

  const side = (
    <div
      role="tablist"
      aria-orientation="vertical"
      className="flex w-[172px] shrink-0 flex-col gap-px overflow-y-auto border-r border-line-subtle pr-1.5"
    >
      {channels.shown.map(g => (
        <button
          key={g.channel}
          type="button"
          role="tab"
          aria-selected={at === g.channel}
          data-channel-tab={g.channel}
          onClick={() => go(g.channel)}
          className={cn(
            'flex items-start gap-2 rounded-md px-2 py-1.5 text-left',
            at === g.channel ? 'bg-selected' : 'hover:bg-hover',
          )}
        >
          <Digit channel={g.channel} className="mt-px" />
          <span className="min-w-0 flex-1">
            <span className={cn('block truncate text-meta', dim(g) ? 'text-fg-faint' : 'text-fg')}>
              {channelLabel(g.channel)}
            </span>
            <span className={cn('block truncate text-label', isBroken(g) ? 'text-warn' : 'text-fg-faint')}>
              {status(g)}
            </span>
          </span>
          {dot(g, 'mt-1.5')}
        </button>
      ))}
      {channels.unset.length > 0 && (
        <button
          type="button"
          role="tab"
          aria-selected={at === 'add'}
          data-channel-tab="add"
          title={addTitle}
          onClick={() => go('add')}
          className={cn(
            'mt-auto flex items-center gap-2 rounded-b-md border-t border-line-subtle px-2 pt-2 pb-1.5 text-left',
            at === 'add' ? 'bg-selected' : 'hover:bg-hover',
          )}
        >
          <span className="flex size-4 shrink-0 items-center justify-center rounded border border-dashed border-line-strong text-fg-muted">
            <Plus size={10} />
          </span>
          <span className="min-w-0 flex-1 truncate text-meta text-fg-muted">{tr('modelChannels.menu.add')}</span>
          <span className="text-label text-fg-faint tabular-nums">{channels.unset.length}</span>
        </button>
      )}
    </div>
  )

  const main =
    channels.shown.length === 0 ? (
      <div ref={list} style={{ height: listPx + MENU_ROW }} className="min-h-0 shrink overflow-y-auto">
        {renderSetup()}
      </div>
    ) : layout === 'cols' ? (
      <>
        {searchBox}
        <div
          style={{ height: Math.max(listPx, (channels.shown.length + (channels.unset.length ? 1 : 0)) * SIDE_ITEM) }}
          className="mt-1.5 flex min-h-0 shrink"
        >
          {side}
          <div ref={list} className="min-w-0 flex-1 overflow-y-auto pl-1.5">
            {body(false)}
          </div>
        </div>
      </>
    ) : (
      <>
        {searchBox}
        {tabBar}
        <div
          ref={list}
          style={{ height: listPx + MENU_ROW + (searching && !single ? TAB_BAR : 0) }}
          className="mt-1 min-h-0 shrink overflow-y-auto"
        >
          {body(true)}
        </div>
      </>
    )

  const modelText =
    live.channel === 'claude' || live.channel === 'chatgpt'
      ? selfModelLabel(engineId, live.model, ownCatalog?.models)
      : (live.model ?? tr('session.ModelSourceMenu.chooseModel'))
  const channelText =
    live.channel === 'custom'
      ? (endpoint?.name ?? channelShort('custom'))
      : live.channel === 'platform' && route
        ? `${channelShort('platform')} ${formatMultiplier(route.rate_multiplier)}`
        : channelShort(live.channel)
  const fixed = prefs.newTask.mode === 'fixed' ? prefs.newTask.choice : null
  const current: ChannelChoice = { ...selection, engine: engineId }
  const canPin = !!fixed && !(sameTarget(fixed, current) && fixed.engine === engineId)
  const steps = channels.shown.length + (channels.unset.length ? 1 : 0)

  const footer = (
    <div className="-mx-1.5 mt-1.5 flex shrink-0 items-center gap-0.5 border-t border-line-subtle px-1.5 pt-1.5">
      {canPin && (
        <button
          type="button"
          onClick={() => {
            pinNewTask(current)
            live.saveAsDefault()
          }}
          title={tr('session.ModelSourceMenu.useThisConversationsCredit')}
          className="flex h-[26px] shrink-0 items-center rounded-md px-2 text-meta text-fg-secondary hover:bg-hover hover:text-fg"
        >
          {tr('session.ModelSourceMenu.setAsDefault')}
        </button>
      )}
      {single && channels.unset.length > 0 && at !== 'add' && (
        <button
          type="button"
          onClick={() => go('add')}
          title={addTitle}
          className="flex h-[26px] shrink-0 items-center gap-1 rounded-md px-2 text-meta text-fg-muted hover:bg-hover hover:text-fg"
        >
          <Plus size={13} />
          {tr('modelChannels.menu.add')}
        </button>
      )}
      <div className="flex-1" />
      {narrow ? (
        <span
          title={tr('modelChannels.menu.narrowTitle', { p0: COLS_MENU_WIDTH })}
          className="min-w-0 truncate px-1.5 text-label text-fg-faint"
        >
          {tr('modelChannels.menu.narrow')}
        </span>
      ) : (
        channels.shown.length > 0 && (
          <span className="flex min-w-0 items-center gap-1 overflow-hidden px-1.5 text-label whitespace-nowrap text-fg-faint">
            <Kbd>↑↓</Kbd>
            {tr('modelChannels.menu.keyPick')}
            {steps > 1 && (
              <>
                <Kbd className="ml-1">←→</Kbd>
                {tr('modelChannels.menu.keyChannel')}
              </>
            )}
          </span>
        )
      )}
      <div
        role="radiogroup"
        aria-label={tr('modelChannels.menu.layout')}
        className="flex shrink-0 gap-px rounded-md bg-subtle p-0.5"
      >
        {(
          [
            ['tabs', PanelTop, 'modelChannels.menu.layoutTabs'],
            ['cols', Columns2, 'modelChannels.menu.layoutCols'],
          ] as const
        ).map(([v, Icon, key]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={prefs.menuLayout === v}
            data-menu-layout={v}
            title={tr(key)}
            aria-label={tr(key)}
            onClick={() => setMenuLayout(v)}
            className={cn(
              'flex h-[22px] w-6 items-center justify-center rounded',
              prefs.menuLayout === v ? 'bg-popover text-fg shadow-sm' : 'text-fg-muted hover:text-fg',
            )}
          >
            <Icon size={13} strokeWidth={1.5} />
          </button>
        ))}
      </div>
      <button
        type="button"
        disabled={catalog.loading}
        onClick={() => {
          void refreshPlatform()
          live.redetect()
        }}
        title={tr('modelChannels.menu.refresh')}
        aria-label={tr('modelChannels.menu.refresh')}
        className="flex size-[26px] shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-50"
      >
        <RefreshCw size={12} className={cn(catalog.loading && 'animate-spin')} />
      </button>
      <button
        type="button"
        onClick={openChannels}
        title={tr('modelChannels.menu.settings')}
        aria-label={tr('modelChannels.menu.settings')}
        className="flex size-[26px] shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
      >
        <Settings2 size={14} strokeWidth={1.5} />
      </button>
    </div>
  )

  return (
    // min-w-0 / max-w-full：输入框窄时工具行不换行，模型名截短让出位置，右边的强度、上下文才不会被挤出去
    <div className="relative min-w-0">
      <button
        ref={trigger}
        type="button"
        onClick={() => onOpenChange(!open)}
        className={cn(TRIGGER, 'max-w-full')}
        title={`${modelText} · ${channelText} · ${executorName(engineId)}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <EngineIcon engine={engineId} size={16} />
        <span data-model-name className={cn('max-w-44 min-w-0 truncate', notReady && 'text-warn')}>
          {modelText}
        </span>
        <span data-model-source className="shrink-0 text-meta text-fg-muted">
          · {channelText}
        </span>
        {newTask && !live.started && !picked && prefs.newTask.mode === 'last' && (
          <span
            data-continue-last
            title={tr('modelChannels.continueLastTitle')}
            className="shrink-0 rounded-full bg-accent/10 px-1.5 text-label leading-[18px] text-accent-fg"
          >
            {tr('modelChannels.continueLast')}
          </span>
        )}
        <ChevronDown size={14} strokeWidth={1.5} className="text-fg-muted" />
      </button>
      {/* 两栏的宽度和 COLS_MENU_WIDTH 一致 */}
      <Popover
        open={open}
        onClose={() => onOpenChange(false)}
        side="top"
        align="end"
        offset={8}
        bare
        within={() => clipRect(trigger.current)}
        className={layout === 'cols' ? 'w-[540px] p-1.5' : 'w-96 p-1.5'}
      >
        {page.kind === 'routes' ? (
          <RoutesPage
            live={live}
            routes={groupsForModel(platform.groups, live.model)}
            balance={account.account?.balance ?? null}
            onBack={() => setPage({ kind: 'main' })}
            run={run}
          />
        ) : (
          <div
            data-model-menu={layout}
            onKeyDown={onKeyDown}
            style={{ maxHeight: fit.height }}
            className="flex flex-col"
          >
            {main}
            {actionError && (
              <p role="alert" className="mt-1 shrink-0 rounded-md bg-subtle px-2 py-1.5 text-meta text-danger">
                {translateMessage(actionError)}
              </p>
            )}
            {footer}
          </div>
        )}
      </Popover>
    </div>
  )
}

function Digit({ channel, className }: { channel: ChannelId; className?: string }) {
  return (
    <span
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded bg-subtle text-[10px] leading-none font-semibold text-fg-muted tabular-nums',
        className,
      )}
    >
      {CHANNEL_DIGIT[channel]}
    </span>
  )
}

/** 列表区居中的说明（没有匹配、这个对话一个都跑不了） */
function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="px-4 py-5 text-center text-meta text-fg-faint">
      <p className="mb-0.5 font-medium text-fg-secondary">{title}</p>
      {children}
    </div>
  )
}

/** 搜索命中的那一段标出来 */
function Mark({ text, query }: { text: string; query: string }) {
  const parts = highlightParts(text, query)
  if (!parts) return <>{text}</>
  return (
    <>
      {parts[0]}
      <mark className="rounded-sm bg-warn/25 px-px text-inherit">{parts[1]}</mark>
      {parts[2]}
    </>
  )
}

/** 授权通道的信息行：打码的邮箱 + 套餐小标签，悬停看完整邮箱 */
function AccountTag({
  account,
  provider,
}: {
  account: { email?: string; plan?: string } | undefined
  provider: PlanProvider
}) {
  if (!account?.email && !account?.plan) return null
  const plan = planInfo(provider, account.plan)
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={account.email}>
      {account.email && <span className="truncate">{maskEmail(account.email)}</span>}
      {plan && <PlanBadge label={plan.label} tone={plan.tone} />}
    </span>
  )
}

/** 菜单里的一行（30px 单行）：勾、名字、淡色说明，右边倍率 / 线路数和执行者 */
function ModelRow({
  title,
  mono,
  desc,
  descMono,
  meta,
  chip,
  query = '',
  selected,
  active,
  off,
  offTitle,
  indent,
  onPick,
  onHover,
}: {
  title: string
  mono?: boolean
  desc?: string
  descMono?: boolean
  meta?: ReactNode
  chip?: ReactNode
  query?: string
  selected?: boolean
  /** 键盘或鼠标停在这行 */
  active?: boolean
  /** 这个对话跑不了 / 执行者不可用：灰掉不能点 */
  off?: boolean
  offTitle?: string
  indent?: boolean
  onPick?: () => void
  onHover?: () => void
}) {
  return (
    <div
      data-model-row
      data-active={active || undefined}
      data-selected={selected || undefined}
      title={off ? offTitle : undefined}
      onMouseEnter={onHover}
      className={cn(
        'group flex h-[30px] items-center gap-2 rounded-md pr-1.5',
        indent ? 'pl-6' : 'pl-1.5',
        selected ? 'bg-selected' : active && 'bg-hover',
      )}
    >
      <button
        type="button"
        data-menu-item
        disabled={off || !onPick}
        onClick={onPick}
        className="flex min-w-0 flex-1 items-center gap-2 self-stretch text-left disabled:cursor-default"
      >
        {/* 勾放最左边一列：每行的模型名对齐 */}
        <span className="flex w-3.5 shrink-0 justify-center">
          {selected && <Check size={13} strokeWidth={2.25} className="text-accent-fg" />}
        </span>
        <span
          className={cn(
            'min-w-0 truncate',
            mono ? 'font-mono text-meta' : 'text-ui',
            off ? 'text-fg-faint' : 'text-fg',
          )}
        >
          <Mark text={title} query={query} />
        </span>
        {desc && (
          <span className={cn('min-w-0 flex-1 truncate text-label text-fg-faint', descMono && 'font-mono')}>
            <Mark text={desc} query={query} />
          </span>
        )}
      </button>
      {(meta || chip) && (
        <span className="flex shrink-0 items-center gap-1.5 text-label text-fg-muted tabular-nums">
          {meta}
          {chip}
        </span>
      )}
    </div>
  )
}

/** 行右边的执行者：平时只露图标，悬停 / 选中 / 键盘停在这行时露名字；能换时点开「谁来执行」 */
function ExecutorChip({
  row,
  expanded,
  open,
  onOpenChange,
  onPick,
}: {
  row: ChannelRow
  expanded: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (e: EngineId) => void
}) {
  useI18n()
  const ref = useRef<HTMLButtonElement>(null)
  const engines = useChannelEngines()
  const e = row.pick.engine
  if (!e || row.disabled) return null
  const switchable = row.pick.options.length > 1
  const label = (
    <span className={cn('items-center gap-0.5', expanded || open ? 'inline-flex' : 'hidden group-hover:inline-flex')}>
      {executorName(e)}
      {switchable && <ChevronDown size={10} />}
    </span>
  )
  if (!switchable)
    return (
      <span
        data-executor={e}
        title={`${tr('modelChannels.executor.title')}: ${executorName(e)}`}
        className="flex h-5 shrink-0 items-center gap-1 rounded px-1 text-label text-fg-faint"
      >
        <EngineIcon engine={e} size={12} />
        {label}
      </span>
    )
  return (
    <>
      <button
        ref={ref}
        type="button"
        data-executor={e}
        aria-haspopup="menu"
        aria-expanded={open}
        title={tr('modelChannels.executor.switch')}
        aria-label={`${tr('modelChannels.executor.title')}: ${executorName(e)}`}
        onClick={() => onOpenChange(!open)}
        className={cn(
          'flex h-5 shrink-0 items-center gap-1 rounded border px-1 text-label hover:border-line hover:bg-surface hover:text-fg',
          expanded || open
            ? 'border-line-subtle text-fg-muted'
            : 'border-transparent text-fg-faint group-hover:border-line-subtle group-hover:text-fg-muted',
        )}
      >
        <EngineIcon engine={e} size={12} />
        {label}
      </button>
      <Popover
        open={open}
        onClose={() => onOpenChange(false)}
        anchor={ref}
        align="end"
        role="menu"
        aria-label={tr('modelChannels.executor.title')}
        className="w-52"
      >
        <p className="px-2 pt-1 pb-0.5 text-label text-fg-faint">{tr('modelChannels.executor.title')}</p>
        {row.candidates.map((x, i) => {
          const ok = row.pick.options.includes(x)
          const why =
            engines.find(s => s.id === x)?.status === 'missing'
              ? tr('modelChannels.executor.notInstalled')
              : tr('modelChannels.executor.unavailable')
          return (
            <button
              key={x}
              type="button"
              role="menuitemradio"
              aria-checked={x === e}
              data-menu-item
              data-executor-option={x}
              disabled={!ok}
              onClick={() => onPick(x)}
              title={ok ? executorDesc(x) : why}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-meta text-fg hover:bg-hover disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <span className="flex w-3.5 shrink-0 justify-center">
                {x === e && <Check size={13} strokeWidth={2.25} className="text-accent-fg" />}
              </span>
              <EngineIcon engine={x} size={13} />
              <span className="min-w-0 flex-1 truncate">{executorName(x)}</span>
              {!ok ? (
                <span className="shrink-0 text-label text-fg-faint">{why}</span>
              ) : (
                i === 0 && (
                  <span className="shrink-0 rounded-full border border-accent/40 px-1.5 text-label leading-4 text-accent-fg">
                    {tr('modelChannels.executor.recommended')}
                  </span>
                )
              )}
            </button>
          )
        })}
      </Popover>
    </>
  )
}

/** 选中的平台模型下面一行：线路（点开子页）；读取中、出错时显示对应提示 */
function PlatformRoute({ live, onOpenRoutes }: { live: SourceMenuController; onOpenRoutes: () => void }) {
  useI18n()
  const platform = usePlatform(live.engine?.id ?? 'claude')
  if (!platform.email) return null
  if (!platform.loaded && platform.loading) {
    return (
      <div className="flex h-[30px] items-center gap-2 pr-2 pl-7 text-meta text-fg-muted">
        <Spinner />
        {tr('session.ModelSourceMenu.loadingRoutes')}
      </div>
    )
  }
  const group = platform.groups.find(g => g.id === live.groupId)
  if (!group) return null
  return (
    <button
      type="button"
      onClick={onOpenRoutes}
      className="flex h-[30px] w-full items-center gap-2 rounded-md pr-1.5 pl-7 text-left hover:bg-hover"
      aria-label={tr('session.ModelSourceMenu.chooseRoute')}
    >
      <span className="shrink-0 text-meta text-fg-muted">{tr('session.ModelSourceMenu.route')}</span>
      <span className="min-w-0 flex-1 truncate text-meta text-fg">
        {group.name}
        <span className="text-fg-muted"> · {billingLabel(group)}</span>
      </span>
      <span
        className="shrink-0 text-label text-fg-secondary tabular-nums"
        title={tr('session.ModelSourceMenu.thisAccountsBillingMultiplier')}
      >
        {formatMultiplier(group.rate_multiplier)}
      </span>
      <ChevronRight size={13} className="shrink-0 text-fg-muted" />
    </button>
  )
}

/** 线路子页：只列包含当前模型的分组，按倍率从低到高 */
function RoutesPage({
  live,
  routes,
  balance,
  onBack,
  run,
}: {
  live: SourceMenuController
  routes: ReturnType<typeof groupsForModel>
  balance: number | null
  onBack: () => void
  run: (fn: () => Promise<void>) => void
}) {
  useI18n()
  return (
    <div className="flex max-h-[70vh] flex-col overflow-y-auto">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 rounded-md px-1.5 py-1.5 text-left text-meta text-fg-muted hover:bg-hover hover:text-fg"
      >
        <ChevronLeft size={14} />
        <span className="truncate">
          {tr('session.ModelSourceMenu.route')}
          {live.model ? (
            <span className="font-mono">
              （{live.model}
              {tr('session.ModelSourceMenu.available')}{' '}
            </span>
          ) : null}
        </span>
      </button>
      {routes.map(g => {
        const lowBalance = g.billing_source !== 'plan_only' && balance !== null && balance <= 0
        return (
          <MenuRow
            key={g.id}
            selected={g.id === live.groupId}
            onClick={() => {
              run(() => live.setGroup(g.id))
              onBack()
            }}
            title={
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate">{g.name}</span>
                <span className="shrink-0 text-fg-secondary tabular-nums">{formatMultiplier(g.rate_multiplier)}</span>
              </span>
            }
            hint={
              <span className={cn(lowBalance && 'text-warn')}>
                {billingLabel(g)}
                {lowBalance
                  ? tr('session.ModelSourceMenu.insufficientBalance')
                  : g.description
                    ? ` · ${g.description}`
                    : ''}
              </span>
            }
          />
        )
      })}
      <p className="border-t border-line-subtle px-2 pt-1.5 pb-1 text-label text-fg-faint">
        {tr('session.ModelSourceMenu.onlyRoutesSupportingThis')}
      </p>
    </div>
  )
}
