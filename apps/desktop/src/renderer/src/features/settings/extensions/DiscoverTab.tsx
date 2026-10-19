import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import type { ExtStoreCatalogPage, ExtStoreItem } from '@pixelsky/protocol'
import { demo, isDemo } from '@/data/demo'
import { Button, cn, Segmented, Spinner } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { usePackState } from '@/features/extpacks/store'
import { debounced } from '@/features/extstore/debounce'
import { consumeExtSearchFocus, openExtDetail, subscribeExtNav } from '@/features/extstore/nav'
import {
  cancelInstall,
  discoverView,
  fetchCatalog,
  installExtension,
  saveDiscoverView,
  useExtStore,
} from '@/features/extstore/store'
import {
  catalogQueryOf,
  clampQuery,
  FEATURED_COUNT,
  installedIdsOf,
  installedVersionsOf,
  isCategorySelectable,
  mergePages,
  nextBeforeOf,
  QUERY_MAX,
  SEARCH_DEBOUNCE_MS,
  showsFeatured,
  STORE_CATEGORIES,
  STORE_CATEGORY_GROUPS,
  STORE_SORTS,
  type DiscoverFilter,
  type StoreCategory,
} from '@/features/extstore/storeModel'
import { StoreFeaturedCard, StoreRow, type CardHandlers, type CardState } from './StoreCard'

// 「发现」页（docs/ui/extension-store-client.md §2.1，示意图 mock-store.png）：搜索 + 排序，左边卡片和列表，右边分类。
// 搜索词、分类、排序、已取的页和滚动位置存在 features/extstore/store.ts，点进详情再回来接着看

/** 往上找出滚动的那一层（设置窗口右边的内容区），记滚动位置、判断「滚到底」都以它为准 */
function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return p
  }
  return null
}

type LoadState = 'loading' | 'ready' | 'error'

export function DiscoverTab() {
  const { t } = useI18n()
  const store = useExtStore()
  const packs = usePackState().packs
  const initial = useRef(discoverView()).current

  const [text, setText] = useState(initial.q)
  const [filter, setFilter] = useState<DiscoverFilter>({
    q: initial.q,
    category: initial.category,
    sort: initial.sort,
  })
  const [pages, setPages] = useState<ExtStoreCatalogPage[]>(initial.pages)
  // pages 是按哪组条件取回来的：换分类 / 排序后新的一页还在路上时，列表仍是旧条件的；存浏览位置、翻页、大卡片都以它为准
  const [loaded, setLoaded] = useState<DiscoverFilter>(filter)
  const [status, setStatus] = useState<LoadState>(initial.pages.length ? 'ready' : 'loading')
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle')
  const [reloadKey, setReloadKey] = useState(0)

  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // 命令面板「扩展：搜索…」：挂载时和之后每次请求都看一眼
  useEffect(() => {
    const focus = (): void => {
      if (consumeExtSearchFocus()) searchRef.current?.focus()
    }
    focus()
    return subscribeExtNav(focus)
  }, [])
  const sentinelRef = useRef<HTMLDivElement>(null)
  const scrollTopRef = useRef(initial.scrollTop)
  const requestId = useRef(0)
  // 从详情回来时已经有页了，第一次不重新取
  const skipFirstLoad = useRef(initial.pages.length > 0)
  const latest = useRef({ loaded, pages })
  latest.current = { loaded, pages }

  // 搜索框输入后等 300 ms 再真正搜；卸载时丢掉没发出去的那次
  const applyQuery = useMemo(
    () => debounced((q: string) => setFilter(f => (f.q === q ? f : { ...f, q })), SEARCH_DEBOUNCE_MS),
    [],
  )
  useEffect(() => () => applyQuery.cancel(), [applyQuery])

  // 条件变了（或点了重试）就从第一页重新取；晚到的旧响应丢掉
  useEffect(() => {
    if (skipFirstLoad.current) {
      skipFirstLoad.current = false
      return
    }
    const id = ++requestId.current
    setStatus('loading')
    setMore('idle')
    fetchCatalog(catalogQueryOf(filter))
      .then(page => {
        if (id !== requestId.current) return
        setPages([page])
        setLoaded(filter)
        setStatus('ready')
      })
      .catch(() => {
        if (id !== requestId.current) return
        setPages([])
        setLoaded(filter)
        setStatus('error')
      })
  }, [filter, reloadKey])

  const nextBefore = nextBeforeOf(pages)
  const loadMore = (): void => {
    const before = nextBeforeOf(latest.current.pages)
    if (!before || more === 'loading') return
    const id = requestId.current
    setMore('loading')
    fetchCatalog(catalogQueryOf(latest.current.loaded, before))
      .then(page => {
        if (id !== requestId.current) return
        setPages(p => [...p, page])
        setMore('idle')
      })
      .catch(() => {
        if (id === requestId.current) setMore('error')
      })
  }

  // 往下滚到底时接着取下一页；没有 IntersectionObserver 时靠「加载更多」按钮
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !nextBefore || more !== 'idle' || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) loadMore()
      },
      { root: scrollParentOf(el), rootMargin: '0px 0px 160px 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
    // loadMore 读的是 ref 里的最新值，只在页数变化时重新挂
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextBefore, more, pages.length])

  // 记滚动位置、卸载时把整个浏览位置存起来；挂载时恢复滚动位置
  useLayoutEffect(() => {
    const parent = scrollParentOf(rootRef.current)
    if (parent && initial.scrollTop > 0) parent.scrollTop = initial.scrollTop
    const onScroll = (): void => {
      scrollTopRef.current = parent?.scrollTop ?? 0
    }
    parent?.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      parent?.removeEventListener('scroll', onScroll)
      // 存的是「列表对应的条件」而不是输入框 / 分类栏上的：新一页还没回来就点进详情时，回来才不会条件和列表对不上
      const { loaded: f, pages: p } = latest.current
      saveDiscoverView({ ...f, pages: p, scrollTop: scrollTopRef.current })
    }
  }, [initial.scrollTop])

  const items = useMemo(() => mergePages(pages), [pages])
  const installedIds = useMemo(() => {
    const ids = installedIdsOf(packs)
    if (isDemo) for (const id of demo().extStore.installed) ids.add(id)
    return ids
  }, [packs])

  const installedVersions = useMemo(() => installedVersionsOf(packs), [packs])

  const handlers: CardHandlers = {
    onOpen: id => openExtDetail(id),
    onInstall: (item, version) =>
      void installExtension(item.id, version, {
        name: item.name,
        kind: installedIds.has(item.id) ? 'update' : 'install',
      }),
    onCancel: id => void cancelInstall(id),
  }
  const stateOf = (item: ExtStoreItem): CardState => ({
    installed: installedIds.has(item.id),
    installedVersion: installedVersions.get(item.id),
    update: store.state.updates[item.id],
    progress: store.state.installing[item.id],
    error: store.installErrors[item.id],
  })

  const featured = status === 'ready' && showsFeatured(loaded) ? items.slice(0, FEATURED_COUNT) : []
  const rest = featured.length ? items.slice(FEATURED_COUNT) : items

  const pick = (category: string): void => {
    if (isCategorySelectable(category)) setFilter(f => (f.category === category ? f : { ...f, category }))
  }

  return (
    <div ref={rootRef} data-ext-discover className="flex flex-col gap-4 @min-[44rem]:flex-row @min-[44rem]:items-start">
      <div className="@container min-w-0 flex-1">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <label className="flex h-8 min-w-40 flex-1 items-center gap-1.5 rounded-md border border-line bg-surface px-2 text-fg-muted focus-within:border-line-strong">
            <Search size={14} strokeWidth={1.5} className="shrink-0" />
            <input
              ref={searchRef}
              value={text}
              onChange={e => {
                const q = clampQuery(e.target.value)
                setText(q)
                applyQuery(q)
              }}
              maxLength={QUERY_MAX}
              placeholder={t('extstore.search')}
              aria-label={t('extstore.search')}
              className="no-drag min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-fg-faint"
            />
          </label>
          <Segmented
            label={t('extstore.sort.label')}
            value={filter.sort}
            onChange={sort => setFilter(f => ({ ...f, sort }))}
            options={STORE_SORTS.map(s => ({ value: s.value, label: t(s.label) }))}
          />
        </div>

        {status === 'error' ? (
          <OfflineNotice onRetry={() => setReloadKey(k => k + 1)} />
        ) : status === 'loading' && items.length === 0 ? (
          <p className="flex items-center justify-center gap-2 rounded-lg border border-line px-3 py-6 text-ui text-fg-faint">
            <Spinner />
            {t('extstore.loading')}
          </p>
        ) : items.length === 0 ? (
          <p className="rounded-lg border border-line px-3 py-6 text-center text-ui text-fg-faint">
            {t('extstore.empty')}
          </p>
        ) : (
          <div className={cn('transition-opacity', status === 'loading' && 'opacity-60')}>
            {featured.length > 0 && (
              <ul className="mb-3 grid grid-cols-1 gap-3 @min-[30rem]:grid-cols-3">
                {featured.map(item => (
                  <StoreFeaturedCard key={item.id} item={item} state={stateOf(item)} handlers={handlers} />
                ))}
              </ul>
            )}
            {rest.length > 0 && (
              <ul className="divide-y divide-line-subtle rounded-lg border border-line">
                {rest.map(item => (
                  <StoreRow key={item.id} item={item} state={stateOf(item)} handlers={handlers} />
                ))}
              </ul>
            )}
            {nextBefore && (
              <div ref={sentinelRef} className="flex h-12 items-center justify-center">
                {more === 'loading' ? (
                  <Spinner />
                ) : (
                  <Button variant="ghost" onClick={loadMore}>
                    {more === 'error' ? t('extstore.loadMoreFailed') : t('extstore.loadMore')}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <CategoryRail value={filter.category} onPick={pick} />
    </div>
  )
}

export function OfflineNotice({ onRetry }: { onRetry(): void }) {
  const { t } = useI18n()
  return (
    <div role="alert" className="flex flex-col items-center gap-2 rounded-lg border border-line px-3 py-8 text-center">
      <p className="text-ui font-medium text-fg">{t('extstore.offline.title')}</p>
      <p className="text-meta text-fg-muted">{t('extstore.offline.hint')}</p>
      <Button onClick={onRetry}>{t('extstore.retry')}</Button>
    </div>
  )
}

/** 右边的分类栏：全部、代码模式（5 种 + 命令）、AI 引擎（技能 / 提示词 + MCP / 插件）；第二期、第三期的灰显不能点，不显示数量 */
export function CategoryRail({ value, onPick }: { value: string; onPick(category: string): void }) {
  const { t } = useI18n()
  const item = (id: string, label: string, phase?: StoreCategory['phase'], heading = false) => {
    const selected = value === id
    return (
      <button
        key={id}
        type="button"
        data-store-category={id}
        aria-pressed={selected}
        disabled={phase !== undefined}
        onClick={() => onPick(id)}
        className={cn(
          'press no-drag flex w-full items-center gap-1.5 rounded-md px-2.5 text-left whitespace-nowrap',
          heading ? 'h-7 text-label' : 'h-8 text-ui',
          selected
            ? 'bg-selected font-medium text-fg'
            : heading
              ? 'text-fg-faint hover:bg-hover hover:text-fg-muted'
              : 'text-fg-secondary hover:bg-hover',
          phase !== undefined && 'pointer-events-none text-fg-faint',
        )}
      >
        <span className="truncate">{label}</span>
        {phase !== undefined && <span className="text-label text-fg-faint">{t(`extstore.phase.${phase}`)}</span>}
      </button>
    )
  }
  return (
    <nav
      aria-label={t('extstore.categories.label')}
      className="flex flex-wrap gap-x-4 @min-[44rem]:w-40 @min-[44rem]:shrink-0 @min-[44rem]:flex-col @min-[44rem]:gap-x-0"
    >
      {item('all', t('extensions.group.all'))}
      {STORE_CATEGORY_GROUPS.map(group => (
        <div key={group.id} className="@min-[44rem]:mt-2">
          {item(group.id, t(group.label), undefined, true)}
          {STORE_CATEGORIES.filter(c => c.group === group.id).map(c => item(c.id, t(c.label), c.phase))}
        </div>
      ))}
    </nav>
  )
}
