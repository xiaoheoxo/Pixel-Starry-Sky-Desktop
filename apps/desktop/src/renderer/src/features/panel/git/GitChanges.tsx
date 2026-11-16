// Git 面板「更改」页的列表：按目录 / 模块分组、筛选、多选、右键、键盘（docs/ui/git-panel.md §10、§10.1）。
// 写操作、确认框、提交框都在 GitPanel.tsx（GitBody），这里通过 GitTreeOps 调用；分组、筛选、排序的纯函数在 gitTree.ts。
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Contrast,
  Copy,
  Crosshair,
  Ellipsis,
  EyeOff,
  FileClock,
  FileCode2,
  Focus,
  Folder,
  FolderSearch,
  GitCommitHorizontal,
  ListTree,
  Minus,
  Package,
  Plus,
  Search,
  Sparkles,
  Undo2,
  X,
} from 'lucide-react'
import { cn, IconButton, useToast } from '@/ui'
import { ActionMenu, type MenuAction } from '@/ui/ActionMenu'
import { tr, translateMessage } from '@/i18n/core'
import { FileIcon } from '@/features/files/icons/FileIcon'
import { showFiles } from '@/features/files/store'
import { useActiveCodeFile } from '@/features/coding/editor/gitWorkOpen'
import { useCurrentGitDiff } from '@/features/coding/editor/gitDiffTabs'
import { demo as demoData } from '@/data/demo'
import { useRemember } from '../ToolsUi'
import {
  GIT_MODULE_MANIFESTS,
  type GitArea,
  type GitFileChange,
  type GitIgnoreEntry,
  type GitModule,
  type GitStatus,
} from '../../../../../shared/types/project-tools'
import type { WorkspaceRef } from '../../../../../shared/types/workspace'
import { SECTION_PAGE, splitPath, type GitSection } from './gitModel'
import type { GitFileMenuPosition } from './GitFileMenu'
import { ShowMore } from './HistoryParts'
import { useGitStats } from './summary'
import {
  AUTO_COLLAPSE,
  ancestorKeys,
  DEFAULT_GIT_VIEW,
  filterActive,
  filterFiles,
  folderLocal,
  gitRows,
  gitViewPrefs,
  highlight,
  NO_FILTER,
  rowKey,
  statusCounts,
  sumStats,
  withRootModule,
  type GitFilter,
  type GitGroupRow,
  type GitRow,
  type GitStats,
  type GitStatusFilter,
  type GitViewPrefs,
} from './gitTree'

/** 一行代表的文件（文件行是它自己，分组行是下面的全部） */
export interface GitItem {
  area: GitArea
  file: GitFileChange
}

/** 写操作和打开文件：GitBody 提供（忙碌状态、确认框、演示数据都在那里） */
export interface GitTreeOps {
  stage(paths: string[]): void
  unstage(paths: string[]): void
  /** 撤销（先确认）；暂存区里的会被忽略 */
  discard(items: GitItem[]): void
  discardSection(section: GitSection): void
  /** 只提交这些：别的取消暂存、暂存这些、光标放到提交框 */
  commitOnly(paths: string[]): void
  /** AI 只给这些写提交信息；没开 AI 写提交信息或正在写时是 null */
  ai: ((paths: string[]) => void) | null
  ignore(entries: GitIgnoreEntry[], label: string): void
  openDiff(area: GitArea, file: GitFileChange): void
  open(file: GitFileChange): void
  history(path: string): void
  fileMenu(position: GitFileMenuPosition & { area: GitArea; path: string }): void
}

const INDENT = 14
/** 展开状态最多记这么多个（按项目） */
const OPEN_KEYS_MAX = 2000
const VIEW_KEY = 'pixelsky.git.changesView'
const MANIFESTS: ReadonlySet<string> = new Set(GIT_MODULE_MANIFESTS)
/** 模块按仓库缓存：切走再回来不重找；清单文件有改动时重找 */
const moduleCache = new Map<string, { sig: string; list: GitModule[] }>()

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])
const unique = (items: readonly GitItem[]): string[] => [...new Set(items.map(i => i.file.path))]
const keyOf = (item: GitItem): string => rowKey.file(item.area, item.file.path)

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

export function useGitTree({
  target,
  workspaceKey,
  demo,
  active,
  status,
  sections,
}: {
  target: WorkspaceRef
  workspaceKey: string
  demo: boolean
  active: boolean
  status: GitStatus | null
  sections: GitSection[]
}) {
  const toast = useToast()
  const [rawView, setRawView] = useRemember<unknown>(VIEW_KEY, DEFAULT_GIT_VIEW)
  const view = useMemo(() => gitViewPrefs(rawView), [rawView])
  const setView = (patch: Partial<GitViewPrefs>) => setRawView({ ...view, ...patch })
  // 收起了哪些、点开过哪些自动收起的（按工作区记住，存在本机界面状态里）
  const [rawOpen, setRawOpen] = useRemember<unknown>(`pixelsky.git.tree:${workspaceKey}`, null)
  const collapsed = useMemo(() => new Set(strings((rawOpen as { c?: unknown } | null)?.c)), [rawOpen])
  const expanded = useMemo(() => new Set(strings((rawOpen as { e?: unknown } | null)?.e)), [rawOpen])
  const saveOpen = (c: Iterable<string>, e: Iterable<string>) =>
    setRawOpen({ c: [...c].slice(-OPEN_KEYS_MAX), e: [...e].slice(-OPEN_KEYS_MAX) })
  const [filter, setFilter] = useState<GitFilter>(NO_FILTER)
  const [selected, setSelected] = useState<{ keys: ReadonlySet<string>; anchor: string | null }>({
    keys: new Set(),
    anchor: null,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [shown, setShown] = useState<Partial<Record<GitArea, number>>>({})
  const filterInput = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 改动行数要多跑 git diff --numstat：只在 Git 页可见、开着「改动行数」时请求（顶栏、输入框不用）
  useGitStats(demo ? null : target, view.stats && active)

  // 模块：开了「按模块」才找；清单文件有改动（加了 / 删了包）时重找
  const manifestSig = useMemo(
    () =>
      sections
        .flatMap(s => s.files)
        .filter(f => MANIFESTS.has(splitPath(f.path).name))
        .map(f => f.code + f.path)
        .sort()
        .join('|'),
    [sections],
  )
  const [modules, setModules] = useState<GitModule[]>(() => moduleCache.get(workspaceKey)?.list ?? [])
  useEffect(() => {
    if (!view.mod || !status?.repo) return
    if (demo) {
      setModules(demoData().git.modules)
      return
    }
    const cached = moduleCache.get(workspaceKey)
    if (cached?.sig === manifestSig) {
      setModules(cached.list)
      return
    }
    let live = true
    void window.pixelsky?.projectTools.gitModules(target).then(
      list => {
        moduleCache.set(workspaceKey, { sig: manifestSig, list })
        if (live) setModules(list)
      },
      () => undefined,
    )
    return () => void (live = false)
  }, [view.mod, status?.repo, manifestSig, workspaceKey, demo])

  const rootName = splitPath((status?.root ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/')).name || '/'
  const allModules = useMemo(() => withRootModule(view.mod ? modules : [], rootName), [view.mod, modules, rootName])
  const staged = useMemo(() => new Set(status?.staged.map(f => f.path)), [status])
  const filtering = !!filter.text.trim()
  const lists = useMemo(
    () =>
      sections.map(section => {
        const files = filterFiles(section.files, filter, allModules)
        return {
          section,
          files,
          rows: gitRows(section.area, files, { view, modules: allModules, collapsed, expanded, filtering, staged }),
        }
      }),
    [sections, filter, allModules, view, collapsed, expanded, filtering, staged],
  )
  /** 现在画出来的行（每组按页截断），键盘上下移动用 */
  const visible = useMemo(
    () => lists.flatMap(l => l.rows.slice(0, shown[l.section.area] ?? SECTION_PAGE)),
    [lists, shown],
  )
  const counts = useMemo(() => statusCounts(sections.flatMap(s => s.files)), [sections])

  // 选中的文件只留还在列表里的（暂存、提交后会变）
  const items = useMemo(() => {
    const map = new Map<string, GitItem>()
    for (const l of lists)
      for (const file of l.files) map.set(rowKey.file(l.section.area, file.path), { area: l.section.area, file })
    return map
  }, [lists])
  const selection = useMemo(
    () => [...selected.keys].map(k => items.get(k)).filter((x): x is GitItem => !!x),
    [selected, items],
  )
  const clearSelection = () => setSelected({ keys: new Set(), anchor: null })

  const toggle = (row: GitGroupRow, open = row.collapsed) => {
    const c = new Set(collapsed),
      e = new Set(expanded)
    if (open) {
      c.delete(row.key)
      if (row.auto || row.files.length > AUTO_COLLAPSE) e.add(row.key)
    } else {
      c.add(row.key)
      e.delete(row.key)
    }
    saveOpen(c, e)
  }
  /** 所有分组行的键（不管现在收没收起） */
  const allGroupKeys = () =>
    lists.flatMap(l =>
      gitRows(l.section.area, l.files, {
        view,
        modules: allModules,
        collapsed: new Set(),
        expanded: new Set(),
        filtering: true,
        staged,
      })
        .filter(r => r.type === 'group')
        .map(r => r.key),
    )
  const expandAll = () => saveOpen([], allGroupKeys())
  const collapseAll = () => saveOpen(allGroupKeys(), [])

  const focusRow = (key: string) =>
    listRef.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: false })
  // 定位：展开所在的文件夹 / 模块、需要时清掉把它筛掉的条件、翻到那一页，滚过去闪一下
  const currentDiff = useCurrentGitDiff(workspaceKey)
  const currentFile = useActiveCodeFile(workspaceKey)
  const locate = () => {
    const match = (f: GitFileChange) =>
      (currentFile !== null && f.local === currentFile) || (!!currentDiff && currentDiff.path === f.path)
    const order: GitArea[] = ['conflicted', 'unstaged', 'untracked', 'staged']
    const hit = order
      .map(area => ({ area, file: sections.find(s => s.area === area)?.files.find(match) }))
      .find((x): x is GitItem => !!x.file)
    if (!hit) {
      toast(tr('git.tree.locateNone'))
      return
    }
    if (!filterFiles([hit.file], filter, allModules).length) setFilter(NO_FILTER)
    const keys = ancestorKeys(hit.area, hit.file.path, allModules)
    saveOpen(
      [...collapsed].filter(k => !keys.includes(k)),
      [...expanded, ...keys],
    )
    setShown(s => ({ ...s, [hit.area]: Number.MAX_SAFE_INTEGER }))
    const key = keyOf(hit)
    setCursor(key)
    setFlash(key)
  }
  useEffect(() => {
    if (!flash) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(flash)}"]`)
    el?.scrollIntoView({ block: 'nearest' })
    el?.focus({ preventScroll: true })
    const timer = window.setTimeout(() => setFlash(null), 1000)
    return () => window.clearTimeout(timer)
  }, [flash])

  return {
    view,
    setView,
    filter,
    setFilter,
    counts,
    lists,
    visible,
    modules: allModules,
    selection,
    selected: selected.keys,
    setSelected,
    anchor: selected.anchor,
    clearSelection,
    cursor,
    setCursor,
    flash,
    shown,
    setShown,
    toggle,
    expandAll,
    collapseAll,
    grouped: view.dir || view.mod,
    locate,
    canLocate: currentFile !== null || !!currentDiff,
    focusRow,
    filterInput,
    listRef,
    current: { file: currentFile, diff: currentDiff },
    /** 面板里任意处按 / 聚焦筛选框 */
    onPanelKey: (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || t.closest('input, textarea, [contenteditable]')) return
      e.preventDefault()
      filterInput.current?.focus()
    },
  }
}
export type GitTree = ReturnType<typeof useGitTree>

// ---------------------------------------------------------------------------
// 「更改 / 历史」那一行右边的按钮
// ---------------------------------------------------------------------------

export function GitTreeTools({ tree }: { tree: GitTree }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const { view, setView } = tree
  const sortItem = (sort: GitViewPrefs['sort'], label: string, hint?: string, section?: string): MenuAction => ({
    label,
    hint,
    section,
    checked: view.sort === sort,
    run: () => setView({ sort }),
  })
  const actions: MenuAction[] = [
    {
      section: tr('git.tree.groupBy'),
      label: tr('git.tree.byDir'),
      checked: view.dir,
      run: () => setView({ dir: !view.dir }),
    },
    { label: tr('git.tree.byModule'), checked: view.mod, run: () => setView({ mod: !view.mod }) },
    sortItem('name', tr('git.tree.sortName'), undefined, tr('git.tree.sort')),
    sortItem('status', tr('git.tree.sortStatus'), tr('git.tree.sortStatusHint')),
    sortItem('lines', tr('git.tree.sortLines'), tr('git.tree.sortLinesHint')),
    {
      section: tr('git.tree.show'),
      label: tr('git.tree.showStats'),
      checked: view.stats,
      run: () => setView({ stats: !view.stats }),
    },
    { label: tr('git.tree.showIcons'), checked: view.icons, run: () => setView({ icons: !view.icons }) },
    {
      label: tr('git.tree.compact'),
      checked: view.compact,
      disabled: !view.dir,
      run: () => setView({ compact: !view.compact }),
    },
  ]
  return (
    <div className="ml-auto flex shrink-0 items-center">
      <IconButton
        icon={Crosshair}
        label={tr('git.tree.locate')}
        size={26}
        iconSize={14}
        disabled={!tree.canLocate}
        onClick={tree.locate}
      />
      {tree.grouped && (
        <>
          <IconButton
            icon={ChevronsUpDown}
            label={tr('git.tree.expandAll')}
            size={26}
            iconSize={14}
            onClick={tree.expandAll}
          />
          <IconButton
            icon={ChevronsDownUp}
            label={tr('git.tree.collapseAll')}
            size={26}
            iconSize={14}
            onClick={tree.collapseAll}
          />
        </>
      )}
      <IconButton
        ref={trigger}
        icon={ListTree}
        label={tr('git.tree.view')}
        size={26}
        iconSize={14}
        active={!!menu}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={() => {
          const rect = trigger.current!.getBoundingClientRect()
          setMenu(m => (m ? null : { x: rect.right - 200, y: rect.bottom + 4 }))
        }}
      />
      {menu && (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          label={tr('git.tree.view')}
          actions={actions}
          onClose={() => {
            setMenu(null)
            trigger.current?.focus({ preventScroll: true })
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 筛选栏（不随列表滚动）
// ---------------------------------------------------------------------------

export function GitFilterBar({ tree, compact }: { tree: GitTree; compact: boolean }) {
  const { filter, setFilter, counts } = tree
  const chip = (value: GitStatusFilter, label: string) => (
    <button
      key={value}
      type="button"
      role="radio"
      aria-checked={filter.status === value}
      onClick={() => setFilter({ ...filter, status: value })}
      className={cn(
        'inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full border px-2 text-label whitespace-nowrap',
        filter.status === value
          ? 'border-transparent bg-accent-soft font-medium text-accent-fg'
          : 'border-line text-fg-muted hover:text-fg',
      )}
    >
      {label}
      {!compact && <span className="tabular-nums opacity-75">{counts[value]}</span>}
    </button>
  )
  return (
    <div data-git-filter className="flex shrink-0 flex-col gap-1.5">
      <label className="flex h-7 items-center gap-1.5 rounded-md border border-line bg-surface pr-1 pl-2 text-fg-faint focus-within:border-accent">
        <Search size={13} strokeWidth={1.5} className="shrink-0" />
        <input
          ref={tree.filterInput}
          value={filter.text}
          onChange={e => setFilter({ ...filter, text: e.target.value })}
          onKeyDown={e => {
            if (e.key === 'Escape' && filter.text) {
              e.preventDefault()
              e.stopPropagation()
              setFilter({ ...filter, text: '' })
            } else if (e.key === 'ArrowDown' && tree.visible.length) {
              e.preventDefault()
              const key = tree.cursor ?? tree.visible[0].key
              tree.setCursor(key)
              tree.focusRow(key)
            }
          }}
          placeholder={tr('git.filter.placeholder')}
          aria-label={tr('git.filter.placeholder')}
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-meta text-fg outline-none placeholder:text-fg-faint"
        />
        {filter.text ? (
          <IconButton
            icon={X}
            label={tr('git.filter.clear')}
            size={20}
            iconSize={11}
            onClick={() => setFilter({ ...filter, text: '' })}
          />
        ) : (
          <kbd className="mr-1 rounded border border-line px-1 font-mono text-[10.5px] leading-[15px] text-fg-faint">
            /
          </kbd>
        )}
      </label>
      <div role="radiogroup" aria-label={tr('git.filter.status')} className="flex flex-wrap gap-1">
        {chip('all', tr('git.filter.all'))}
        {chip('modified', tr('git.filter.modified'))}
        {chip('added', tr('git.filter.added'))}
        {chip('deleted', tr('git.filter.deleted'))}
      </div>
      {filter.focus && (
        <div className="flex h-[26px] items-center gap-1.5 rounded-md bg-accent-soft pr-0.5 pl-2 text-meta text-accent-fg">
          <Focus size={12} strokeWidth={1.75} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={filter.focus.path}>
            {tr('git.filter.focus', { path: filter.focus.label })}
          </span>
          <IconButton
            icon={X}
            label={tr('git.filter.unfocus')}
            size={20}
            iconSize={11}
            className="text-accent-fg"
            onClick={() => setFilter({ ...filter, focus: null })}
          />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

function Stats({ stats, className }: { stats: GitStats | null; className?: string }) {
  if (!stats) return null
  return (
    <span
      title={tr('git.tree.lines', { ins: stats.insertions, del: stats.deletions })}
      className={cn('flex shrink-0 gap-1 text-label whitespace-nowrap tabular-nums', className)}
    >
      {stats.insertions > 0 && <span className="text-success">+{stats.insertions}</span>}
      {stats.deletions > 0 && <span className="text-danger">−{stats.deletions}</span>}
    </span>
  )
}

function Marked({ text, query }: { text: string; query: string }) {
  return highlight(text, query).map((part, i) =>
    part.hit ? (
      <mark key={i} className="rounded-xs bg-warn/30 text-inherit">
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  )
}

const codeColor = (code: GitFileChange['code']) =>
  code === 'D' || code === 'U' ? 'text-danger' : code === 'A' || code === '?' ? 'text-success' : 'text-warn'

type GroupMenu = GitFileMenuPosition & { title: string; items: GitItem[]; group: GitGroupRow | null }

export function GitChangeList({
  tree,
  ops,
  target,
  busy,
  compact,
}: {
  tree: GitTree
  ops: GitTreeOps
  target: WorkspaceRef
  busy: boolean
  compact: boolean
}) {
  const toast = useToast()
  const [menu, setMenu] = useState<GroupMenu | null>(null)
  const { view, filter, selected, cursor, current } = tree
  const query = filter.text

  const filesOf = (row: GitRow): GitItem[] =>
    row.type === 'file' ? [{ area: row.area, file: row.file }] : row.files.map(file => ({ area: row.area, file }))
  /** 这一行在多选里（多选至少两个）：操作对象是整个多选 */
  const inSelection = (row: GitRow) => row.type === 'file' && selected.has(row.key) && tree.selection.length > 1
  const targetsOf = (row: GitRow): GitItem[] => (inSelection(row) ? tree.selection : filesOf(row))

  const stageItems = (items: GitItem[]) => {
    const add = unique(items.filter(i => i.area !== 'staged'))
    const remove = unique(items.filter(i => i.area === 'staged'))
    if (add.length) ops.stage(add)
    else if (remove.length) ops.unstage(remove)
  }
  const canDiscard = (items: GitItem[]) => items.some(i => i.area === 'unstaged' || i.area === 'untracked')

  const openMenu = (row: GitRow, x: number, y: number, trigger: HTMLElement) => {
    if (inSelection(row)) {
      const items = tree.selection
      setMenu({ x, y, trigger, title: tr('git.bulk.selected', { n: items.length }), items, group: null })
    } else if (row.type === 'file') ops.fileMenu({ x, y, trigger, area: row.area, path: row.file.path })
    else {
      const name = row.group === 'module' ? row.label : row.path
      const title = `${name} · ${tr('git.tree.files', { n: row.files.length })}`
      setMenu({ x, y, trigger, title, items: filesOf(row), group: row })
    }
  }

  const menuActions = (m: GroupMenu): MenuAction[] => {
    const { items, group } = m
    const add = items.filter(i => i.area !== 'staged')
    const remove = items.filter(i => i.area === 'staged')
    const paths = unique(items)
    const untracked = items.filter(i => i.area === 'untracked')
    const local = group?.group === 'folder' ? folderLocal(group.files[0], group.path) : null
    const copy = (value: string) =>
      void navigator.clipboard.writeText(value).catch(e => toast(translateMessage((e as Error).message)))
    const list: MenuAction[] = []
    if (add.length)
      list.push({
        label: tr('git.group.stage', { n: unique(add).length }),
        icon: Plus,
        hint: 'Space',
        disabled: busy,
        run: () => ops.stage(unique(add)),
      })
    if (remove.length)
      list.push({
        label: tr('git.group.unstage', { n: unique(remove).length }),
        icon: Minus,
        hint: add.length ? undefined : 'Space',
        disabled: busy,
        run: () => ops.unstage(unique(remove)),
      })
    if (canDiscard(items))
      list.push({
        label: tr('git.group.discard', {
          n: items.filter(i => i.area === 'unstaged' || i.area === 'untracked').length,
        }),
        icon: Undo2,
        danger: true,
        hint: 'Del',
        disabled: busy,
        run: () => ops.discard(items),
      })
    list.push(
      {
        label: tr('git.group.commitOnly'),
        icon: GitCommitHorizontal,
        separator: true,
        disabled: busy || items.some(i => i.area === 'conflicted'),
        run: () => ops.commitOnly(paths),
      },
      { label: tr('git.group.ai'), icon: Sparkles, disabled: busy || !ops.ai, run: () => ops.ai?.(paths) },
    )
    if (group)
      list.push({
        label: tr(group.group === 'module' ? 'git.group.focusModule' : 'git.group.focusFolder'),
        icon: Focus,
        separator: true,
        run: () =>
          tree.setFilter({
            ...filter,
            focus: { kind: group.group, path: group.path, label: group.group === 'module' ? group.label : group.path },
          }),
      })
    if (group?.group === 'folder')
      list.push({
        label: tr('git.file.revealTree'),
        icon: FolderSearch,
        disabled: !local,
        run: () => showFiles(target, local!),
      })
    if (group)
      list.push({
        label: tr('git.group.copyPath'),
        icon: Copy,
        disabled: !group.path,
        run: () => copy(group.path),
      })
    if (untracked.length === items.length && group?.group !== 'module')
      list.push({
        label: tr('git.group.ignore'),
        icon: EyeOff,
        separator: true,
        disabled: busy,
        run: () =>
          group
            ? ops.ignore([{ path: group.path, dir: true }], group.path + '/')
            : ops.ignore(
                untracked.slice(0, 200).map(i => ({ path: i.file.path, dir: false })),
                tr('git.tree.files', { n: Math.min(200, untracked.length) }),
              ),
      })
    return list
  }

  // ---- 点击、键盘 ----
  const click = (row: GitRow, e: MouseEvent) => {
    tree.setCursor(row.key)
    if (row.type === 'group') {
      if (e.ctrlKey || e.metaKey) {
        const keys = new Set(selected)
        const all = filesOf(row).map(keyOf)
        const on = all.every(k => keys.has(k))
        for (const k of all) on ? keys.delete(k) : keys.add(k)
        tree.setSelected({ keys, anchor: tree.anchor })
      } else tree.toggle(row)
      return
    }
    if (e.ctrlKey || e.metaKey) {
      const keys = new Set(selected)
      // 第一次 Ctrl 点：把当前打开的那个也算进来，免得要再点一次
      if (!keys.size && cursor && cursor !== row.key && cursor.startsWith('f|')) keys.add(cursor)
      keys.has(row.key) ? keys.delete(row.key) : keys.add(row.key)
      tree.setSelected({ keys, anchor: row.key })
      return
    }
    if (e.shiftKey) {
      const from = tree.anchor ?? cursor ?? row.key
      const files = tree.visible.filter(r => r.type === 'file')
      const a = files.findIndex(r => r.key === from),
        b = files.findIndex(r => r.key === row.key)
      if (a >= 0 && b >= 0) {
        const range = files.slice(Math.min(a, b), Math.max(a, b) + 1).filter(r => r.area === row.area)
        tree.setSelected({ keys: new Set(range.map(r => r.key)), anchor: from })
        return
      }
    }
    tree.clearSelection()
    ops.openDiff(row.area, row.file)
  }

  const move = (key: string | undefined) => {
    if (!key) return
    tree.setCursor(key)
    tree.focusRow(key)
  }
  // 用键盘暂存 / 撤销后这一行会移到别的组或消失：焦点留在原来的位置（下一行），不掉到页面上
  const keepAt = useRef<number | null>(null)
  useEffect(() => {
    const at = keepAt.current
    if (at === null) return
    if (tree.visible.some(r => r.key === cursor)) {
      keepAt.current = null
      return
    }
    const list = tree.listRef.current
    if (list && !list.contains(document.activeElement) && document.activeElement !== document.body) return
    keepAt.current = null
    move(tree.visible[Math.min(at, tree.visible.length - 1)]?.key)
  }, [tree.visible])
  const keyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = tree.visible.findIndex(r => r.key === cursor)
    const row = tree.visible[index]
    const mod = e.ctrlKey || e.metaKey
    const handled = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      handled()
      const next = tree.visible[index < 0 ? 0 : index + (e.key === 'ArrowDown' ? 1 : -1)]
      if (next) {
        if (e.shiftKey && row?.type === 'file' && next.type === 'file' && next.area === row.area) {
          const keys = new Set(selected)
          if (!keys.size) keys.add(row.key)
          keys.add(next.key)
          tree.setSelected({ keys, anchor: tree.anchor ?? row.key })
        }
        move(next.key)
      } else if (e.key === 'ArrowUp' && index === 0) tree.filterInput.current?.focus()
      return
    }
    if (e.key === 'Home' || e.key === 'End') {
      handled()
      move(tree.visible[e.key === 'Home' ? 0 : tree.visible.length - 1]?.key)
      return
    }
    if (e.key === 'Escape') {
      if (tree.selection.length) {
        handled()
        tree.clearSelection()
      } else if (filter.text) {
        handled()
        tree.setFilter({ ...filter, text: '' })
      }
      return
    }
    if (mod && e.key.toLowerCase() === 'a') {
      handled()
      const area = row?.area ?? tree.lists[0]?.section.area
      const list = tree.lists.find(l => l.section.area === area)
      if (list) tree.setSelected({ keys: new Set(list.files.map(f => rowKey.file(area, f.path))), anchor: null })
      return
    }
    if (!row) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      handled()
      if (row.type === 'group' && e.key === 'ArrowRight') {
        if (row.collapsed) tree.toggle(row, true)
        else move(tree.visible[index + 1]?.key)
      } else if (row.type === 'group' && !row.collapsed) tree.toggle(row, false)
      else {
        // 到上一层的文件夹 / 模块
        for (let i = index - 1; i >= 0; i--) {
          const r = tree.visible[i]
          if (r.area !== row.area) break
          if (r.type === 'group' && r.depth < row.depth) return move(r.key)
        }
      }
      return
    }
    if (e.key === ' ' || e.key === 'Spacebar') {
      handled()
      if (busy) return
      keepAt.current = index
      stageItems(targetsOf(row))
      return
    }
    if (e.key === 'Enter') {
      handled()
      if (row.type === 'group') tree.toggle(row)
      else ops.openDiff(row.area, row.file)
      return
    }
    if (e.key === 'Delete') {
      handled()
      const items = targetsOf(row)
      if (busy || !canDiscard(items)) return
      keepAt.current = index
      ops.discard(items)
      return
    }
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      handled()
      const el = e.target as HTMLElement
      const rect = el.getBoundingClientRect()
      openMenu(row, rect.left + 24, rect.bottom, el)
    }
  }

  // ---- 行 ----
  const guides = (depth: number) =>
    Array.from({ length: depth }, (_, i) => (
      <span
        key={i}
        aria-hidden
        className="pointer-events-none absolute inset-y-0 w-px bg-line"
        style={{ left: 4 + i * INDENT + 7 }}
      />
    ))
  const hoverButton = (icon: typeof Plus, label: string, run: () => void, danger = false) => (
    <IconButton
      icon={icon}
      label={label}
      size={22}
      iconSize={12}
      disabled={busy}
      className={cn(danger && 'hover:text-danger')}
      onClick={e => {
        e.stopPropagation()
        run()
      }}
    />
  )
  const rowClass = (row: GitRow, extra?: string) =>
    cn(
      'group/row relative flex h-[26px] min-w-0 cursor-pointer items-center gap-1.5 rounded-md pr-0.5 outline-none select-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-inset',
      selected.has(row.key) && tree.selection.length > 0 ? 'bg-accent-soft hover:bg-accent-soft' : extra,
      tree.flash === row.key && 'value-flash',
    )
  // 键盘焦点只停在一行上（Tab 进来落在上次的行）；那一行没了就落在第一行
  const tabKey = tree.visible.some(r => r.key === cursor) ? cursor : tree.visible[0]?.key
  const common = (row: GitRow) => ({
    role: 'treeitem' as const,
    'data-row-key': row.key,
    tabIndex: tabKey === row.key ? 0 : -1,
    'aria-level': row.depth + 1,
    'aria-selected': selected.has(row.key),
    onFocus: () => tree.setCursor(row.key),
    onClick: (e: MouseEvent) => click(row, e),
    onContextMenu: (e: MouseEvent<HTMLDivElement>) => {
      e.preventDefault()
      tree.setCursor(row.key)
      openMenu(row, e.clientX, e.clientY, e.currentTarget)
    },
  })

  const fileRow = (row: Extract<GitRow, { type: 'file' }>) => {
    const { file, area } = row
    const { name } = splitPath(file.path)
    const isCurrent =
      (current.diff?.area === area && current.diff.path === file.path) ||
      (area !== 'staged' && current.file !== null && file.local === current.file)
    return (
      <div
        key={row.key}
        {...common(row)}
        data-git-file={file.path}
        title={`${file.origPath ? file.origPath + ' → ' : ''}${file.path}`}
        className={rowClass(row, isCurrent ? 'bg-selected' : undefined)}
        style={{ paddingLeft: 4 + row.depth * INDENT + (row.dir === null && row.depth ? 20 : 4) }}
      >
        {guides(row.depth)}
        <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          <span className={cn('w-3 shrink-0 text-center font-mono text-[11px] font-semibold', codeColor(file.code))}>
            {file.code}
          </span>
          {view.icons && <FileIcon name={name} kind="file" size={14} />}
          <span
            className={cn(
              'max-w-[75%] shrink-0 truncate text-list',
              file.code === 'D' ? 'text-fg-muted line-through' : 'text-fg',
            )}
          >
            <Marked text={name} query={query} />
          </span>
          {row.dir && !compact && (
            <span className="min-w-0 shrink truncate text-meta text-fg-faint">
              <Marked text={row.dir} query={query} />
            </span>
          )}
          {row.partial && (
            <span title={tr('git.tree.partial')} className="inline-flex shrink-0 text-accent-fg">
              <Contrast size={12} strokeWidth={1.75} />
            </span>
          )}
        </span>
        {view.stats && !compact && (
          <Stats stats={sumStats([file])} className="group-hover/row:hidden group-focus-visible/row:hidden" />
        )}
        <span className="hidden shrink-0 items-center group-hover/row:flex group-focus-visible/row:flex">
          {file.local && file.code !== 'D' && (
            <IconButton
              icon={FileCode2}
              label={tr('git.open')}
              size={22}
              iconSize={12}
              onClick={e => {
                e.stopPropagation()
                ops.open(file)
              }}
            />
          )}
          {area !== 'untracked' && file.code !== 'A' && (
            <IconButton
              icon={FileClock}
              label={tr('git.history.file.show')}
              size={22}
              iconSize={12}
              onClick={e => {
                e.stopPropagation()
                ops.history(file.path)
              }}
            />
          )}
          {(area === 'unstaged' || area === 'untracked') &&
            hoverButton(Undo2, tr('git.discard'), () => ops.discard([{ area, file }]), true)}
          {area === 'staged'
            ? hoverButton(Minus, tr('git.unstage'), () => ops.unstage([file.path]))
            : hoverButton(Plus, tr('git.stage'), () => ops.stage([file.path]))}
        </span>
      </div>
    )
  }

  const groupRow = (row: GitGroupRow) => {
    const module = row.group === 'module'
    const items = filesOf(row)
    return (
      <div
        key={row.key}
        {...common(row)}
        aria-expanded={!row.collapsed}
        data-git-group={row.path}
        title={module ? `${row.label} · ${row.path || tr('git.tree.root')}` : row.path}
        className={rowClass(row)}
        style={{ paddingLeft: 4 + row.depth * INDENT }}
      >
        {guides(row.depth)}
        <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          <ChevronRight
            size={12}
            strokeWidth={1.75}
            className={cn('w-3.5 shrink-0 text-fg-faint transition-transform', !row.collapsed && 'rotate-90')}
          />
          {module ? (
            <Package size={14} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
          ) : view.icons ? (
            <FileIcon name={splitPath(row.label).name} kind="directory" expanded={!row.collapsed} size={14} />
          ) : (
            <Folder size={14} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
          )}
          <span
            className={cn(
              'truncate text-list',
              module
                ? 'max-w-[60%] shrink-0 font-medium text-fg @max-[280px]:max-w-none @max-[280px]:shrink'
                : 'min-w-0 text-fg-secondary',
            )}
          >
            <Marked text={row.label} query={module ? '' : query} />
          </span>
          {module && row.module?.kind && (
            <span className="shrink-0 rounded bg-subtle px-1.5 text-[10px] leading-4 text-fg-muted @max-[280px]:hidden">
              {row.module.kind}
            </span>
          )}
          {module && (
            <span className="min-w-0 shrink truncate text-meta text-fg-faint @max-[280px]:hidden">
              {row.path || tr('git.tree.root')}
            </span>
          )}
          <span className="shrink-0 text-meta text-fg-faint tabular-nums">{row.files.length}</span>
          {row.ignore && (
            <button
              type="button"
              title={tr('git.tree.ignoreHint', { path: row.ignore })}
              disabled={busy}
              onClick={e => {
                e.stopPropagation()
                ops.ignore([{ path: row.ignore!, dir: true }], row.ignore + '/')
              }}
              className="inline-flex h-[18px] shrink-0 items-center gap-0.5 rounded-full border border-dashed border-line px-1.5 text-[10.5px] text-fg-muted hover:border-solid hover:border-accent hover:text-accent-fg disabled:opacity-40"
            >
              <EyeOff size={10} strokeWidth={1.75} />
              {tr('git.tree.ignore')}
            </button>
          )}
        </span>
        {view.stats && (
          <Stats stats={sumStats(row.files)} className="group-hover/row:hidden group-focus-visible/row:hidden" />
        )}
        <span className="hidden shrink-0 items-center group-hover/row:flex group-focus-visible/row:flex">
          {(row.area === 'unstaged' || row.area === 'untracked') &&
            hoverButton(Undo2, tr('git.group.discard', { n: items.length }), () => ops.discard(items), true)}
          {row.area === 'staged'
            ? hoverButton(Minus, tr('git.group.unstage', { n: items.length }), () => ops.unstage(unique(items)))
            : hoverButton(Plus, tr('git.group.stage', { n: items.length }), () => ops.stage(unique(items)))}
          <IconButton
            icon={Ellipsis}
            label={tr('git.tree.more')}
            size={22}
            iconSize={12}
            onClick={e => {
              e.stopPropagation()
              const rect = e.currentTarget.getBoundingClientRect()
              openMenu(row, rect.left, rect.bottom + 2, e.currentTarget)
            }}
          />
        </span>
      </div>
    )
  }

  const shownCount = tree.lists.reduce((n, l) => n + l.files.length, 0)
  const filtered = filterActive(filter)
  return (
    <div ref={tree.listRef} role="tree" aria-label={tr('git.tree.label')} aria-multiselectable onKeyDown={keyDown}>
      {tree.lists.map(({ section, files, rows }) => {
        if (filtered && !files.length) return null
        const limit = tree.shown[section.area] ?? SECTION_PAGE
        const total = section.files.length
        const header: ReactNode = (
          <div className="group/section flex h-7 items-center gap-1.5 pr-0.5">
            <h3
              className={cn(
                'min-w-0 flex-1 truncate text-label font-medium',
                section.area === 'conflicted' ? 'text-danger' : 'text-fg-muted',
              )}
            >
              {tr(section.title)}{' '}
              <span className="text-fg-faint tabular-nums">
                {files.length !== total ? `${files.length} / ${total}` : total}
              </span>
            </h3>
            {view.stats && (
              <Stats stats={sumStats(files)} className="group-hover/section:hidden group-focus-within/section:hidden" />
            )}
            <span className="hidden items-center group-hover/section:flex group-focus-within/section:flex">
              {section.area === 'staged' ? (
                <IconButton
                  icon={Minus}
                  label={tr('git.unstageAll')}
                  size={24}
                  iconSize={13}
                  disabled={busy}
                  onClick={() => ops.unstage(unique(files.map(file => ({ area: section.area, file }))))}
                />
              ) : (
                <>
                  {section.area !== 'conflicted' && (
                    <IconButton
                      icon={Undo2}
                      label={tr('git.discardAll')}
                      size={24}
                      iconSize={13}
                      disabled={busy}
                      onClick={() =>
                        filtered
                          ? ops.discard(files.map(file => ({ area: section.area, file })))
                          : ops.discardSection(section)
                      }
                    />
                  )}
                  <IconButton
                    icon={Plus}
                    label={tr('git.stageAll')}
                    size={24}
                    iconSize={13}
                    disabled={busy}
                    onClick={() => ops.stage(files.map(f => f.path))}
                  />
                </>
              )}
            </span>
          </div>
        )
        return (
          <section key={section.area} data-git-section={section.area} role="group" className="shrink-0">
            {header}
            {rows.slice(0, limit).map(row =>
              row.type === 'file' ? (
                fileRow(row)
              ) : row.auto ? (
                <Fragment key={row.key}>
                  {groupRow(row)}
                  <div
                    className="pb-1 text-label text-fg-faint"
                    style={{ paddingLeft: 4 + (row.depth + 1) * INDENT + 20 }}
                  >
                    {tr('git.tree.autoCollapsed')}
                  </div>
                </Fragment>
              ) : (
                groupRow(row)
              ),
            )}
            <ShowMore
              rest={Math.max(0, rows.length - limit)}
              onMore={() => tree.setShown({ ...tree.shown, [section.area]: limit + SECTION_PAGE })}
            />
          </section>
        )
      })}
      {filtered && !shownCount && (
        <div className="py-5 text-center text-meta text-fg-faint">
          {tr('git.filter.none')}
          <div className="mt-2">
            <button
              type="button"
              onClick={() => tree.setFilter(NO_FILTER)}
              className="h-6 rounded-md border border-line bg-surface px-2 text-label text-fg hover:bg-hover"
            >
              {tr('git.filter.reset')}
            </button>
          </div>
        </div>
      )}
      {menu && (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          label={menu.title}
          actions={menuActions(menu).map((a, i) => (i ? a : { ...a, section: menu.title }))}
          onClose={() => {
            setMenu(null)
            menu.trigger.focus({ preventScroll: true })
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 底部批量栏（多选时）
// ---------------------------------------------------------------------------

export function GitBulkBar({ tree, ops, busy }: { tree: GitTree; ops: GitTreeOps; busy: boolean }) {
  const items = tree.selection
  if (items.length < 2) return null
  const add = unique(items.filter(i => i.area !== 'staged'))
  const remove = unique(items.filter(i => i.area === 'staged'))
  const btn =
    'inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-line bg-surface px-2 text-label text-fg hover:bg-hover disabled:opacity-40'
  return (
    <div
      role="toolbar"
      aria-label={tr('git.bulk.selected', { n: items.length })}
      className="mx-3 mb-2 flex shrink-0 items-center gap-1 rounded-lg border border-line-card bg-popover py-1.5 pr-1.5 pl-2.5 text-meta shadow-menu"
    >
      <span className="min-w-0 flex-1 truncate text-fg-secondary">{tr('git.bulk.selected', { n: items.length })}</span>
      {add.length > 0 && (
        <button type="button" className={btn} disabled={busy} onClick={() => ops.stage(add)}>
          <Plus size={12} strokeWidth={1.75} />
          {tr('git.stage')}
        </button>
      )}
      {remove.length > 0 && (
        <button type="button" className={btn} disabled={busy} onClick={() => ops.unstage(remove)}>
          <Minus size={12} strokeWidth={1.75} />
          {tr('git.unstage')}
        </button>
      )}
      {items.some(i => i.area === 'unstaged' || i.area === 'untracked') && (
        <IconButton
          icon={Undo2}
          label={tr('git.discard')}
          size={22}
          iconSize={12}
          disabled={busy}
          className="hover:text-danger"
          onClick={() => ops.discard(items)}
        />
      )}
      {ops.ai && (
        <IconButton
          icon={Sparkles}
          label={tr('git.group.ai')}
          size={22}
          iconSize={13}
          disabled={busy}
          className="text-accent-fg"
          onClick={() => ops.ai?.(unique(items))}
        />
      )}
      <IconButton icon={X} label={tr('git.bulk.clear')} size={22} iconSize={12} onClick={tree.clearSelection} />
    </div>
  )
}
