import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../../i18n/core'
// 设置 › 模型通道（docs/ui/model-channels.md §2.1）：最上面四张通道卡和「新对话用」（model-channels/ChannelsSettings.tsx，
// 自定义 API 的接口列在第四张卡里，docs/ui/custom-api.md）；下面是平台线路一览、菜单里显示的模型。AI 写提交信息、语音输入在「AI 辅助」，请求重试在「本机引擎」（docs/ui/settings-reorg.md）。
import type { EngineId } from '@pixelsky/protocol'
import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { EngineIcon, Spinner, Switch, cn } from '@/ui'
import { useAccount } from '@/features/account/useAccount'
import {
  billingLabel,
  formatMultiplier,
  groupProblem,
  MODEL_SEARCH_MIN,
  matchModels,
  noRouteReason,
  platformModels,
  refreshPlatform,
  setModelHidden,
  showAllModels,
  usePlatform,
} from '@/features/account/platform'
import { GroupTitle, SectionTitle } from '../SettingRow'
import { takeModelsScroll } from './scroll'
import { ChannelsSettings } from '@/features/model-channels/ChannelsSettings'
import { AccountsPage } from '@/features/model-channels/AccountsPage'
import { openAccountsPage, useAccountsPage } from '@/features/model-channels/accountsStore'
import { KeyChip, KeyLegend, KeyModeRow } from './PlatformKeyMode'
import { useKeyMode } from '@/features/account/keyMode'
import { ContextWindowInput } from './ContextWindowInput'
import { CustomModelWindows } from './CustomModelWindows'
import { setContextWindow, useContextWindows } from './contextWindows'
import {
  mergedModels,
  modelBadge,
  routeCount,
  sharedWindow,
  windowBackfill,
  windowEngines,
  type EngineModelLists,
  type EngineWindowMaps,
} from './modelWindows'
import { scrollInPane } from '@/ui/scrollInPane'

/** 把平台模型的窗口写进各引擎的设置；写不进去的报给界面 */
function writeWindows(
  list: Array<{ engine: EngineId; model: string; value: number | null }>,
  onError: (message: string) => void,
): void {
  Promise.all(list.map(w => setContextWindow(w.engine, 'platform', w.model, w.value))).catch((e: unknown) =>
    onError((e as Error).message),
  )
}

export function ModelsSection() {
  useI18n()
  const platform = usePlatform()
  const account = useAccount()
  const keyMode = useKeyMode().mode
  const codexPlatform = usePlatform('codex')
  const pixelPlatform = usePlatform('pixel')
  // 菜单里显示的模型和上下文窗口：三个引擎的云端模型合在一起（GitHub #20），只有像素星空能跑的线路也列出来
  const lists: EngineModelLists = {
    claude: platformModels(platform.groups),
    codex: platformModels(codexPlatform.groups),
    pixel: platformModels(pixelPlatform.groups),
  }
  const models = mergedModels(lists)
  const windows: EngineWindowMaps = {
    claude: useContextWindows('claude').platform,
    codex: useContextWindows('codex').platform,
    pixel: useContextWindows('pixel').platform,
  }
  const [windowError, setWindowError] = useState<string | null>(null)
  // 一个模型一个值，写给每个能跑它的引擎（像素星空没填时按系列自动定，engine pixel/context-window.ts）
  const saveWindow = (model: string, value: number | null): void => {
    setWindowError(null)
    writeWindows(
      windowEngines(model, lists).map(engine => ({ engine, model, value })),
      setWindowError,
    )
  }
  // 老版本只写了 Claude Code / Codex 的：补给同样能跑这个模型、却还没填的引擎，显示的和实际用的才一致
  const backfillKey = JSON.stringify(windowBackfill(models, lists, windows))
  const backfilled = useRef(new Set<string>())
  useEffect(() => {
    const todo = (JSON.parse(backfillKey) as ReturnType<typeof windowBackfill>).filter(
      w => !backfilled.current.has(`${w.engine}|${w.model}|${w.value}`),
    )
    if (!todo.length) return
    for (const w of todo) backfilled.current.add(`${w.engine}|${w.model}|${w.value}`)
    writeWindows(todo, setWindowError)
  }, [backfillKey])
  const accountsPage = useAccountsPage()
  // 离开模型通道（换到别的设置页、关掉设置）时回到通道页
  useEffect(() => () => openAccountsPage(null), [])
  const visibilityRef = useRef<HTMLDivElement>(null)
  const [modelQuery, setModelQuery] = useState('')
  useEffect(() => {
    if (takeModelsScroll() && visibilityRef.current) scrollInPane(visibilityRef.current, 'start')
  }, [])

  // 子页面「模型通道 › ChatGPT 账号」（docs/ui/engine-accounts.md §6）
  if (accountsPage) return <AccountsPage channel={accountsPage} />
  return (
    <section>
      <SectionTitle>{tr('modelChannels.title')}</SectionTitle>
      <p className="-mt-2 mb-5 text-meta text-fg-muted">{tr('modelChannels.intro')}</p>

      <ChannelsSettings />

      {/* 平台线路一览（登录了像素星空才有） */}
      {platform.email && <GroupTitle>{tr('session.ModelSourceMenu.platform')}</GroupTitle>}
      {platform.email && (
        <div className="mt-3">
          <div className="mb-2 flex items-center justify-end gap-3 text-meta text-fg-muted">
            <button
              type="button"
              disabled={platform.loading}
              onClick={() => void refreshPlatform()}
              className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 hover:bg-hover hover:text-fg disabled:opacity-50"
            >
              <RefreshCw size={12} className={cn(platform.loading && 'animate-spin')} />
              {platform.loading ? tr('session.ModelSourceMenu.refreshing') : tr('account.AccountMenu.refresh')}
            </button>
          </div>
          <KeyModeRow />
          {platform.groups.some(g => g.key) && (
            <p className="mb-2 text-right text-meta text-fg-muted">{tr('platformKey.routesHint')}</p>
          )}
          {platform.groups.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-meta text-fg-muted">
              {platform.loading ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner />
                  {tr('session.ModelSourceMenu.loadingRoutes')}{' '}
                </span>
              ) : (
                noRouteReason(platform, account.account?.balance ?? null).message
              )}
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-line">
              {platform.groups.map(g => {
                const problem = groupProblem(g, account.account?.balance ?? null)
                return (
                  <div
                    key={g.id}
                    className="flex items-center gap-3 border-t border-line-subtle px-4 py-2.5 first:border-t-0"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui text-fg">{g.name}</span>
                      <span className={cn('block text-meta', problem ? 'text-danger' : 'truncate text-fg-muted')}>
                        {billingLabel(g)} ·{' '}
                        {problem ?? tr('settings.models.ModelsSection.models', { p0: g.models.length })}
                      </span>
                    </span>
                    <KeyChip value={g.key} mode={keyMode} />
                    <span className="min-w-11 shrink-0 text-right text-ui text-fg-secondary tabular-nums">
                      {formatMultiplier(g.rate_multiplier)}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
          {platform.groups.some(g => g.key) && <KeyLegend mode={keyMode} />}
        </div>
      )}

      {/* 菜单里显示的模型（§8）：只记隐藏的，线路新加的模型默认显示 */}
      {platform.email && models.length > 0 && (
        <div ref={visibilityRef} data-setting-title="菜单里显示的模型" className="mt-5 scroll-mt-4">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <div>
              <div className="text-ui font-medium text-fg">{tr('settings.models.ModelsSection.modelsShownInMenu')}</div>
              <p className="mt-1 text-meta text-fg-muted">
                {tr('settings.models.ModelsSection.hiddenModelsAreRemoved')}
              </p>
              <p className="mt-1 text-meta text-fg-muted">{tr('contextWindow.platformHint')}</p>
              {windowError && (
                <p role="alert" className="mt-1 text-meta text-danger">
                  {translateMessage(windowError)}
                </p>
              )}
            </div>
            {platform.hiddenModels.some(m => models.includes(m)) && (
              <button
                type="button"
                onClick={showAllModels}
                className="shrink-0 text-meta text-accent-fg hover:underline"
              >
                {tr('settings.models.ModelsSection.showAll')}{' '}
              </button>
            )}
          </div>
          {models.length > MODEL_SEARCH_MIN && (
            <input
              value={modelQuery}
              onChange={e => setModelQuery(e.target.value)}
              placeholder={tr('session.ModelSourceMenu.searchModels')}
              aria-label={tr('session.ModelSourceMenu.searchModels')}
              spellCheck={false}
              className="mb-2 h-8 w-full max-w-xs rounded-md border border-line bg-subtle px-2.5 font-mono text-meta text-fg outline-none placeholder:font-sans placeholder:text-fg-faint focus:border-line-strong focus:bg-surface"
            />
          )}
          <div className="overflow-hidden rounded-lg border border-line">
            {matchModels(models, modelQuery).length === 0 && (
              <div className="px-4 py-2 text-meta text-fg-faint">{tr('session.ModelSourceMenu.noMatchingModels')}</div>
            )}
            {matchModels(models, modelQuery).map(m => {
              const shown = !platform.hiddenModels.includes(m)
              const lines = routeCount(m, {
                claude: platform.groups,
                codex: codexPlatform.groups,
                pixel: pixelPlatform.groups,
              })
              const badge = modelBadge(m, lists)
              return (
                <div key={m} className="flex items-center gap-3 border-t border-line-subtle px-4 py-2 first:border-t-0">
                  <span
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-1.5 font-mono text-meta',
                      shown ? 'text-fg' : 'text-fg-faint',
                    )}
                  >
                    {badge && <EngineIcon engine={badge} size={12} />}
                    <span className="truncate">{m}</span>
                  </span>
                  <span className="shrink-0 text-meta text-fg-faint">
                    {tr(lines === 1 ? 'settings.models.ModelsSection.route' : 'settings.models.ModelsSection.routes', {
                      n: lines,
                    })}
                  </span>
                  <ContextWindowInput
                    value={sharedWindow(m, lists, windows)}
                    label={tr('contextWindow.of', { model: m })}
                    commit="blur"
                    onChange={value => saveWindow(m, value)}
                  />
                  <Switch
                    checked={shown}
                    label={tr('settings.models.ModelsSection.showInMenu', { p0: m })}
                    onChange={on => setModelHidden(m, !on)}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 自定义 API 的模型也能在这里填窗口（docs/ui/context-settings-branch-switch.md §2.3.1） */}
      <CustomModelWindows />
    </section>
  )
}
