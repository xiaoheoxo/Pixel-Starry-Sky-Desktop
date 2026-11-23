// 设置 › 模型通道 › 菜单里显示的模型（docs/ui/menu-models.md 方案 A）：按厂商分组、组开关、筛选、隐藏旧版本；
// 每行显示名 + id、新 / 旧版、能跑它的工具、线路数、最低倍率、上下文窗口（灰字是官方标的窗口，留空时引擎用自己知道的）、开关
import { useEffect, useMemo, useRef, useState } from 'react'
import type { EngineId } from '@pixelsky/protocol'
import { ChevronRight } from 'lucide-react'
import { EngineIcon, Switch, cn } from '@/ui'
import { tr, translateMessage } from '../../../i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import {
  formatMultiplier,
  groupsForModel,
  setModelHidden,
  setModelsHidden,
  showAllModels,
  usePlatformCatalog,
} from '@/features/account/platform'
import { ContextWindowInput } from './ContextWindowInput'
import { formatTokens } from './tokenCount'
import {
  defaultWindow,
  freshModels,
  groupByVendor,
  groupState,
  oldModels,
  prettyModelName,
  type Vendor,
} from './menuModelRules'
import {
  modelEngines,
  routeCount,
  sharedWindow,
  windowEngines,
  type EngineModelLists,
  type EngineWindowMaps,
} from './modelWindows'

const SEEN_KEY = 'pixelsky.platform.seenModels'

function readSeen(): string[] | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    const list: unknown = raw ? JSON.parse(raw) : null
    return Array.isArray(list) ? list.filter((m): m is string => typeof m === 'string') : null
  } catch {
    return null
  }
}

type Filter = 'all' | 'shown' | 'hidden'
const norm = (s: string) => s.toLowerCase().replace(/[\s-]+/g, '')

export function MenuModels({
  models,
  lists,
  groups,
  windows,
  hidden,
  windowError,
  onWindow,
}: {
  models: string[]
  lists: EngineModelLists
  /** 各引擎的线路（数线路用） */
  groups: Partial<Record<EngineId, ReadonlyArray<{ id: string; models: readonly string[] }>>>
  windows: EngineWindowMaps
  hidden: string[]
  windowError: string | null
  onWindow(model: string, value: number | null): void
}) {
  useI18n()
  const catalog = usePlatformCatalog()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [closed, setClosed] = useState<Set<Vendor>>(() => new Set(['image']))
  // 「新」：和打开这一页之前记下的比；记录在下面的 effect 里更新，这一次打开的标记留到离开
  const [seenBefore] = useState(readSeen)
  const fresh = freshModels(models, seenBefore)
  const modelsKey = models.join('\n')
  const saved = useRef('')
  useEffect(() => {
    if (!modelsKey || saved.current === modelsKey || window.pixelsky?.demo) return
    saved.current = modelsKey
    const all = new Set([...(readSeen() ?? []), ...modelsKey.split('\n')])
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify([...all]))
    } catch {
      /* 存不下只是少个标记 */
    }
  }, [modelsKey])

  const old = useMemo(() => oldModels(models), [models])
  const shownCount = models.filter(m => !hidden.includes(m)).length
  const q = norm(query)
  const pass = (m: string) =>
    (!q || norm(m).includes(q) || norm(prettyModelName(m)).includes(q)) &&
    (filter === 'all' || (filter === 'shown') === !hidden.includes(m))
  const oldShown = [...old].filter(m => !hidden.includes(m))
  const sections = groupByVendor(models)
    .map(g => ({ ...g, rows: g.models.filter(pass) }))
    .filter(g => g.rows.length > 0)

  return (
    <>
      <div className="mb-2">
        <div className="text-ui font-medium text-fg">{tr('settings.models.ModelsSection.modelsShownInMenu')}</div>
        <p className="mt-1 text-meta text-fg-muted">{tr('menuModels.hint')}</p>
        {windowError && (
          <p role="alert" className="mt-1 text-meta text-danger">
            {translateMessage(windowError)}
          </p>
        )}
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={tr('menuModels.search')}
          aria-label={tr('menuModels.search')}
          spellCheck={false}
          className="h-8 min-w-44 flex-1 rounded-lg border border-transparent bg-surface px-2.5 text-meta text-fg shadow-sm outline-none placeholder:text-fg-faint focus:border-accent-line"
        />
        <div role="tablist" className="inline-flex rounded-md bg-subtle p-0.5">
          {(
            [
              ['all', 'menuModels.filterAll', models.length],
              ['shown', 'menuModels.filterShown', shownCount],
              ['hidden', 'menuModels.filterHidden', models.length - shownCount],
            ] as const
          ).map(([f, key, n]) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded px-2.5 py-1 text-meta whitespace-nowrap',
                filter === f ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg',
              )}
            >
              {tr(key, { n })}
            </button>
          ))}
        </div>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {oldShown.length > 0 && (
          <button
            type="button"
            onClick={() => setModelsHidden(oldShown, true)}
            className="h-6 rounded-full border border-dashed border-line-strong px-2.5 text-meta text-fg-muted hover:border-solid hover:text-fg"
          >
            {tr('menuModels.hideOld', { n: oldShown.length })}
          </button>
        )}
        {hidden.some(m => models.includes(m)) && (
          <button
            type="button"
            onClick={showAllModels}
            className="h-6 rounded-full border border-dashed border-line-strong px-2.5 text-meta text-fg-muted hover:border-solid hover:text-fg"
          >
            {tr('settings.models.ModelsSection.showAll')}
          </button>
        )}
      </div>
      <div className="overflow-hidden rounded-xl bg-surface shadow-sm">
        {sections.length === 0 && (
          <div className="px-4 py-3 text-center text-meta text-fg-faint">
            {tr('session.ModelSourceMenu.noMatchingModels')}
          </div>
        )}
        {sections.map(g => {
          const isClosed = closed.has(g.vendor) && !q
          const state = groupState(g.models, hidden)
          const rates = g.models.map(m => groupsForModel(catalog.groups, m)[0]?.rate_multiplier ?? Infinity)
          const minRate = Math.min(...rates)
          const vendor = tr(`menuModels.vendor.${g.vendor}`)
          return (
            <div key={g.vendor} className="border-t border-line-subtle first:border-t-0">
              <div className="flex h-9 items-center gap-2 bg-subtle pr-3">
                <button
                  type="button"
                  aria-expanded={!isClosed}
                  onClick={() =>
                    setClosed(s => {
                      const next = new Set(s)
                      if (next.has(g.vendor)) next.delete(g.vendor)
                      else next.add(g.vendor)
                      return next
                    })
                  }
                  className="flex h-full min-w-0 flex-1 items-center gap-2 pl-3 text-left"
                >
                  <ChevronRight
                    size={12}
                    className={cn('shrink-0 text-fg-muted transition-transform', !isClosed && 'rotate-90')}
                  />
                  <span className="text-list font-medium text-fg">{vendor}</span>
                  <span className="truncate text-meta text-fg-faint">
                    {tr('menuModels.groupCount', {
                      n: g.models.length,
                      shown: g.models.length - g.models.filter(m => hidden.includes(m)).length,
                    })}
                    {g.vendor === 'image' && ` · ${tr('menuModels.imageHint')}`}
                  </span>
                </button>
                {Number.isFinite(minRate) && (
                  <span className="shrink-0 text-meta text-fg-faint tabular-nums" title={tr('menuModels.rateTip')}>
                    {tr('menuModels.fromRate', { rate: formatMultiplier(minRate) })}
                  </span>
                )}
                <Switch
                  size="sm"
                  checked={state === 'on'}
                  label={tr('menuModels.groupSwitch', { vendor })}
                  onChange={on => setModelsHidden(g.models, !on)}
                />
              </div>
              {!isClosed &&
                g.rows.map(m => {
                  const shown = !hidden.includes(m)
                  const name = prettyModelName(m)
                  const routes = routeCount(m, groups)
                  const rate = groupsForModel(catalog.groups, m)[0]?.rate_multiplier
                  const canWindow = windowEngines(m, lists).length > 0
                  const def = defaultWindow(m)
                  return (
                    <div
                      key={m}
                      className="group flex min-h-9 items-center gap-2.5 border-t border-line-subtle px-3 hover:bg-hover"
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-1.5">
                        <span className={cn('truncate text-list', shown ? 'text-fg' : 'text-fg-faint')}>{name}</span>
                        {name.toLowerCase() !== m.toLowerCase() && (
                          <span className="truncate font-mono text-label text-fg-faint">{m}</span>
                        )}
                        {fresh.has(m) && (
                          <span
                            title={tr('menuModels.newTip')}
                            className="shrink-0 rounded bg-accent-soft px-1 text-label text-accent-fg"
                          >
                            {tr('menuModels.new')}
                          </span>
                        )}
                        {old.has(m) && (
                          <span
                            title={tr('menuModels.oldTip')}
                            className="shrink-0 rounded bg-subtle px-1 text-label text-fg-muted"
                          >
                            {tr('menuModels.old')}
                          </span>
                        )}
                      </span>
                      <span className="flex shrink-0 items-center gap-0.5">
                        {modelEngines(m, lists).map(e => (
                          <EngineIcon key={e} engine={e} size={12} />
                        ))}
                      </span>
                      <span className="w-14 shrink-0 text-right text-meta text-fg-faint tabular-nums">
                        {tr(
                          routes === 1 ? 'settings.models.ModelsSection.route' : 'settings.models.ModelsSection.routes',
                          {
                            n: routes,
                          },
                        )}
                      </span>
                      <span
                        className="w-12 shrink-0 text-right text-meta text-fg-secondary tabular-nums"
                        title={tr('menuModels.rateTip')}
                      >
                        {rate === undefined ? '' : formatMultiplier(rate)}
                      </span>
                      {canWindow ? (
                        <ContextWindowInput
                          ghost
                          value={sharedWindow(m, lists, windows)}
                          placeholder={def ? formatTokens(def) : undefined}
                          label={tr('contextWindow.of', { model: m })}
                          commit="blur"
                          onChange={value => onWindow(m, value)}
                        />
                      ) : (
                        <span
                          className="w-20 shrink-0"
                          title={g.vendor === 'image' ? undefined : tr('menuModels.agyWindow')}
                        />
                      )}
                      <Switch
                        size="sm"
                        checked={shown}
                        label={tr('settings.models.ModelsSection.showInMenu', { p0: m })}
                        onChange={on => setModelHidden(m, !on)}
                      />
                    </div>
                  )
                })}
            </div>
          )
        })}
      </div>
    </>
  )
}
