import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  Blocks,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  CircleX,
  Copy,
  Crosshair,
  Folder,
  Hammer,
  Info,
  ListChecks,
  Package,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { extText, packName } from '@pixelsky/protocol'
import { getMachines, machineOf } from '@/features/machines/store'
import { allMessages, getLocale, tr, type TranslationKey } from '@/i18n/core'
import { Button, IconButton, Spinner, cn, useToast } from '@/ui'
import { ActionMenu, type MenuAction } from '@/ui/ActionMenu'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { isDemo } from '@/data'
import { appendComposerDraft } from '@/features/engine/drafts'
import { composerTarget, focusComposer } from '@/features/session/composerTarget'
import { openFile } from '@/features/files/store'
import { packAssetUrl, packByKey } from '@/features/extpacks/store'
import type { GradleProperty, RunTask, RunTaskGroup, RunTaskKind } from '../../../../../../shared/types/project-tools'
import type { WorkspaceRef } from '../../../../../../shared/types/workspace'
import { activeTaskTemplates } from '../../tasks/extTemplates'
import { PanelHeader } from '../../shell/PanelHeader'
import { codingLayout } from '../../layoutStore'
import { useCodingWorkspace } from '../../workspace'
import {
  categoryKey,
  filterGroups,
  groupKey,
  isCategoryCollapsed,
  isCollapsed,
  PROPERTIES,
  rowKey,
  taskCommand,
  visibleRows,
  type TaskRow,
  type TaskStatus,
} from '../../tasks/model'
import {
  cancelGradleFull,
  isAlive,
  loadGradleFull,
  loadTasks,
  TASKS_STALE_MS,
  useGradleFull,
  useRunTasks,
  useTaskRunner,
  useTaskStatuses,
} from '../../tasks/store'

const GROUP_ICON: Partial<Record<RunTaskKind, LucideIcon>> = {
  npm: Package,
  make: Hammer,
  cargo: Box,
  gradle: Blocks,
  ext: ListChecks,
}
const COLLAPSED_KEY = 'pixelsky.coding.tasks.collapsed'
const ARGS_KEY = 'pixelsky.coding.tasks.gradleArgs'
/** 「带参数运行」里一点就加的参数（§9.3） */
const COMMON_ARGS = [
  '--stacktrace',
  '--info',
  '--debug',
  '--offline',
  '--refresh-dependencies',
  '--rerun-tasks',
  '--continue',
]

type Overrides = Record<string, boolean>
/** 展开 / 收起状态：按项目记在 localStorage，值是 { 文件路径（Gradle 分组是 文件路径 + 分组）: 是否收起 } */
function readCollapsed(project: string): Overrides {
  try {
    const all = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '{}') as Record<string, Overrides>
    const mine = all[project]
    return mine && typeof mine === 'object' ? mine : {}
  } catch {
    return {}
  }
}
function writeCollapsed(project: string, value: Overrides): void {
  try {
    const all = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '{}') as Record<string, Overrides>
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify({ ...all, [project]: value }))
  } catch {
    // 存不了就只在这次有效
  }
}

const clipboardWrite = (text: string): Promise<unknown> =>
  isDemo ? navigator.clipboard.writeText(text) : window.pixelsky!.terminal.clipboardWrite(text)

const baseName = (path: string): string => path.split('/').pop() ?? path

/** 组头的名字：Gradle 根项目写项目名、子项目写项目路径；其余子文件夹写文件夹，根目录写文件名 */
function groupTitle(group: RunTaskGroup): string {
  const g = group.gradle
  if (g) return g.project === ':' ? g.name : g.project
  if (group.ext) return extText(group.ext.label, getLocale())
  return group.dir || group.file
}

/** 组头的灰字：包管理器、「根目录」或文件名；Gradle 根项目是版本，子项目是主插件 */
function groupHint(group: RunTaskGroup): string {
  const parts: string[] = []
  const g = group.gradle
  if (g) {
    if (g.project !== ':') return g.plugin ?? ''
    if (g.gradleVersion) parts.push(`Gradle ${g.gradleVersion}`)
    if (g.javaVersion) parts.push(`Java ${g.javaVersion}`)
    parts.push(g.buildDir || tr('coding.tasks.rootDir'))
    return parts.join(' · ')
  }
  if (group.ext) {
    const pack = packByKey(group.ext.packKey)
    parts.push(tr('tasks.ext.hint', { name: pack?.manifest ? packName(pack.manifest, getLocale()) : group.ext.packId }))
  }
  if (group.dir) parts.push(baseName(group.file))
  if (group.manager) parts.push(group.manager)
  if (!group.dir) parts.push(tr('coding.tasks.rootDir'))
  return parts.join(' · ')
}

/** 任务行的灰字：npm 是脚本内容；Gradle 依次用构建文件里写的说明、内置说明、完整列表里 Gradle 给的说明 */
function taskDetail(group: RunTaskGroup, task: RunTask): string {
  if (group.kind === 'ext') return extText(task.extDetail, getLocale())
  if (task.detail || group.kind !== 'gradle') return task.detail
  const key = `coding.tasks.gradle.desc.${task.name}`
  return key in allMessages ? tr(key as TranslationKey) : (task.description ?? '')
}

/** gradle.properties 相对工作区根的路径 */
const propertiesFile = (group: RunTaskGroup): string =>
  group.gradle?.buildDir ? `${group.gradle.buildDir}/gradle.properties` : 'gradle.properties'

function readArgs(): string {
  try {
    return localStorage.getItem(ARGS_KEY) ?? ''
  } catch {
    return ''
  }
}

function StatusIcon({ status }: { status: TaskStatus }) {
  const cls = 'shrink-0'
  switch (status.kind) {
    case 'running':
      return <Spinner size={14} className={cn(cls, 'text-accent')} />
    case 'stopping':
      return (
        <span className={cn(cls, 'flex')} title={tr('coding.tasks.status.stopping')}>
          <Spinner size={14} className="text-warning" />
        </span>
      )
    case 'ok':
      return (
        <Check
          size={14}
          strokeWidth={2}
          className={cn(cls, 'text-success')}
          aria-label={tr('coding.tasks.status.ok')}
        />
      )
    case 'failed':
      return (
        <CircleX
          size={14}
          strokeWidth={1.75}
          className={cn(cls, 'text-danger')}
          aria-label={tr('coding.tasks.status.failed')}
        />
      )
    case 'stopped':
      return (
        <Square
          size={12}
          strokeWidth={1.75}
          className={cn(cls, 'text-fg-faint')}
          aria-label={tr('coding.tasks.status.stopped')}
        />
      )
    default:
      return <Play size={12} strokeWidth={1.5} className={cn(cls, 'text-fg-faint')} aria-hidden />
  }
}

/** Gradle 根项目最后的提示条：按插件推断 / 正在加载完整列表 / 已加载 / 可能过期 / 失败（§9.3） */
function GradleFullBar({ wsRef, root, group }: { wsRef: WorkspaceRef | null; root: string; group: RunTaskGroup }) {
  const g = group.gradle!
  const { full, job } = useGradleFull(root, g.buildDir)
  const load = (): void => {
    if (wsRef) void loadGradleFull(wsRef, root, g.buildDir, g.stamp)
  }
  let icon = <Info size={12} strokeWidth={1.75} className="shrink-0" />
  let text = tr('coding.tasks.gradle.full.hint')
  let action = {
    label: tr('coding.tasks.gradle.full.load'),
    title: tr('coding.tasks.gradle.full.loadTitle'),
    run: load,
  }
  let tone = 'text-fg-faint'
  if (job?.loading) {
    icon = <Spinner size={12} className="shrink-0 text-accent" />
    text = tr('coding.tasks.gradle.full.loading')
    action = {
      label: tr('coding.tasks.gradle.full.cancel'),
      title: '',
      run: () => wsRef && cancelGradleFull(wsRef, root, g.buildDir),
    }
  } else if (job?.error) {
    icon = <CircleX size={12} strokeWidth={1.75} className="shrink-0 text-danger" />
    text = tr('coding.tasks.gradle.full.failed', { error: job.error })
    action = { label: tr('coding.tasks.gradle.full.retry'), title: tr('coding.tasks.gradle.full.loadTitle'), run: load }
    tone = 'text-danger'
  } else if (full) {
    const stale = full.stamp !== g.stamp
    icon = stale ? (
      <Info size={12} strokeWidth={1.75} className="shrink-0 text-warning" />
    ) : (
      <Check size={12} strokeWidth={2} className="shrink-0 text-success" />
    )
    text = stale
      ? tr('coding.tasks.gradle.full.stale')
      : tr('coding.tasks.gradle.full.done', {
          time: new Date(full.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        })
    action = {
      label: tr('coding.tasks.gradle.full.reload'),
      title: tr('coding.tasks.gradle.full.loadTitle'),
      run: load,
    }
  }
  return (
    <div
      data-gradle-full={job?.loading ? 'loading' : job?.error ? 'error' : full ? 'done' : 'none'}
      className={cn('mt-1 mb-1 ml-5 flex min-h-7 items-center gap-1.5 rounded-md bg-subtle px-2 py-1 text-meta', tone)}
    >
      {icon}
      <span className="min-w-0 flex-1 break-words" title={job?.error ?? undefined}>
        {text}
      </span>
      <button
        type="button"
        title={action.title || undefined}
        disabled={!wsRef}
        onClick={action.run}
        className="press shrink-0 rounded px-1 text-accent-fg hover:underline disabled:opacity-50"
      >
        {action.label}
      </button>
    </div>
  )
}

type MenuState =
  | { kind: 'task'; x: number; y: number; group: RunTaskGroup; task: RunTask }
  | { kind: 'prop'; x: number; y: number; group: RunTaskGroup; prop: GradleProperty }

interface ArgsState {
  group: RunTaskGroup
  task: RunTask
  value: string
}

/** 「设为服务」的命令在项目所在机器上跑：Windows 机器是 pwsh / PowerShell，其余是 /bin/sh（远程 / WSL 项目看那台机器的系统），引号按它写 */
const serviceShell = (projectId: unknown): string => {
  const machine = getMachines().machines.find(m => m.id === machineOf(projectId))
  return (machine?.platform ?? window.pixelsky?.platform) === 'win32' ? 'pwsh' : 'sh'
}

/** 左栏「任务」：按文件分组列出 package.json / Makefile / Cargo.toml / Gradle 里能跑的命令（docs/ui/coding-tasks.md §4、§9） */
export function TasksView({ visible }: { visible: boolean }) {
  useI18n()
  const toast = useToast()
  const { ref, key: workspaceKey } = useCodingWorkspace()
  const entry = useRunTasks(ref)
  const { state } = entry
  const statuses = useTaskStatuses(state)
  const runner = useTaskRunner(state)
  const [query, setQuery] = useState('')
  const [overrides, setOverrides] = useState<Overrides>({})
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [args, setArgs] = useState<ArgsState | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const refKey = ref ? JSON.stringify(ref) : ''
  const project = state?.root ?? workspaceKey

  // 第一次打开、视图重新显示（离上次超过 10 秒）时读
  useEffect(() => {
    if (visible && ref) void loadTasks(ref, TASKS_STALE_MS)
    // ref 只在 refKey 变化时才会变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, refKey])
  useEffect(() => setOverrides(readCollapsed(project)), [project])

  const filtering = query.trim() !== ''
  const groups = useMemo(() => filterGroups(state?.groups ?? [], query), [state, query])
  const rows = useMemo(() => visibleRows(groups, overrides, filtering), [groups, overrides, filtering])

  const setCollapsed = (next: Overrides): void => {
    setOverrides(next)
    writeCollapsed(project, next)
  }
  const toggle = (group: RunTaskGroup, collapsed = !isCollapsed(group, overrides)): void =>
    setCollapsed({ ...overrides, [groupKey(group)]: collapsed })
  const toggleCategory = (
    group: RunTaskGroup,
    category: string,
    collapsed = !isCategoryCollapsed(group, category, overrides),
  ): void => setCollapsed({ ...overrides, [categoryKey(group, category)]: collapsed })
  const collapseAll = (): void =>
    setCollapsed(Object.fromEntries((state?.groups ?? []).map(g => [groupKey(g), true] as const)))

  const refresh = (): void => {
    if (ref) void loadTasks(ref)
  }

  const askAi = (group: RunTaskGroup, task: RunTask): void => {
    const target = composerTarget()
    if (!target) {
      toast(tr('coding.tasks.noChat'))
      return
    }
    appendComposerDraft(target.key, tr('coding.tasks.askAiPrompt', { command: taskCommand(group, task) }))
    codingLayout.showRight('chat')
    focusComposer(target.key)
  }
  const saveService = (group: RunTaskGroup, task: RunTask): void => {
    const name = group.dir ? `${task.name} (${group.dir})` : task.name
    if (isDemo || !ref || !state) {
      toast(tr('coding.tasks.serviceSaved', { name }))
      return
    }
    window
      .pixelsky!.projectTools.saveService(ref, {
        name,
        command: taskCommand(group, task, serviceShell(ref.projectId)),
        cwd: state.root,
      })
      .then(() => toast(tr('coding.tasks.serviceSaved', { name })))
      .catch((e: Error) => toast(e.message))
  }
  const locate = (group: RunTaskGroup, task: RunTask): void => {
    if (ref) void openFile(ref, group.file, task.line ?? 1, 1, undefined, { target: 'code' })
  }
  const locateProp = (group: RunTaskGroup, prop: GradleProperty): void => {
    if (ref) void openFile(ref, propertiesFile(group), prop.line, 1, undefined, { target: 'code' })
  }
  const copy = (text: string, done: TranslationKey): void => void clipboardWrite(text).then(() => toast(tr(done)))
  const runWithArgs = (a: ArgsState): void => {
    try {
      localStorage.setItem(ARGS_KEY, a.value.trim())
    } catch {
      // 记不住就算了
    }
    setArgs(null)
    void runner.run(a.group, a.task, false, a.value)
  }

  const taskActions = (group: RunTaskGroup, task: RunTask): MenuAction[] => [
    { label: tr('coding.tasks.menu.run'), icon: Play, run: () => void runner.run(group, task) },
    { label: tr('coding.tasks.menu.runNew'), icon: SquareTerminal, run: () => void runner.run(group, task, true) },
    ...(group.kind === 'gradle'
      ? [
          {
            label: tr('coding.tasks.menu.runArgs'),
            icon: Settings2,
            run: () => setArgs({ group, task, value: readArgs() }),
          },
          {
            label: tr('coding.tasks.menu.refreshDeps'),
            icon: RefreshCw,
            run: () => void runner.run(group, task, false, '--refresh-dependencies'),
          },
        ]
      : []),
    { label: tr('coding.tasks.menu.askAi'), icon: Sparkles, run: () => askAi(group, task) },
    {
      label: tr('coding.tasks.menu.service'),
      icon: Server,
      separator: true,
      run: () => saveService(group, task),
    },
    {
      label: tr('coding.tasks.menu.copy'),
      icon: Copy,
      run: () => copy(taskCommand(group, task), 'coding.tasks.copied'),
    },
    {
      label: tr('coding.tasks.menu.locate', { file: baseName(group.file) }),
      icon: Crosshair,
      run: () => locate(group, task),
    },
  ]
  const propActions = (group: RunTaskGroup, prop: GradleProperty): MenuAction[] => [
    ...(prop.secret
      ? []
      : [
          {
            label: tr('coding.tasks.menu.copyValue'),
            icon: Copy,
            run: () => copy(prop.value, 'coding.tasks.copiedValue'),
          },
        ]),
    ...(prop.secret
      ? []
      : [
          {
            label: tr('coding.tasks.menu.copyLine'),
            icon: Copy,
            run: () => copy(`${prop.key}=${prop.value}`, 'coding.tasks.copiedValue'),
          },
        ]),
    {
      label: tr('coding.tasks.menu.locate', { file: 'gradle.properties' }),
      icon: Crosshair,
      run: () => locateProp(group, prop),
    },
  ]

  const focusRow = useCallback((key: string): void => {
    setCursor(key)
    list.current?.querySelector<HTMLElement>(`[data-task-row="${CSS.escape(key)}"]`)?.focus()
  }, [])
  const onKeyDown = (e: KeyboardEvent): void => {
    const index = rows.findIndex(r => rowKey(r) === cursor)
    const row = rows[index]
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next =
        rows[Math.max(0, Math.min(rows.length - 1, (index < 0 ? -1 : index) + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) focusRow(rowKey(next))
    } else if (e.key === 'Enter' && row && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (row.type === 'task') void runner.run(row.group, row.task)
      else if (row.type === 'prop') locateProp(row.group, row.prop)
      else if (row.type === 'category') {
        if (!filtering) toggleCategory(row.group, row.category)
      } else toggle(row.group)
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !filtering) {
      if (row?.type === 'group') {
        e.preventDefault()
        toggle(row.group, e.key === 'ArrowLeft')
      } else if (row?.type === 'category') {
        e.preventDefault()
        toggleCategory(row.group, row.category, e.key === 'ArrowLeft')
      }
    }
  }

  const renderRow = (row: TaskRow, index: number) => {
    const key = rowKey(row)
    const { group } = row
    const deep = group.kind === 'gradle'
    const rowClass =
      'press flex h-7 cursor-default items-center rounded-md text-ui outline-none hover:bg-hover focus-visible:bg-hover'
    const tabIndex = cursor === key || (cursor === null && index === 0) ? 0 : -1
    if (row.type === 'group') {
      const collapsed = !filtering && isCollapsed(group, overrides)
      const Icon = group.gradle && group.gradle.project !== ':' ? Folder : (GROUP_ICON[group.kind] ?? ListChecks)
      return (
        <div
          key={key}
          role="treeitem"
          aria-level={1}
          aria-expanded={!collapsed}
          tabIndex={tabIndex}
          data-task-row={key}
          onFocus={() => setCursor(key)}
          onClick={() => {
            setCursor(key)
            if (!filtering) toggle(group)
          }}
          className={cn(rowClass, 'gap-1.5 px-1')}
        >
          {collapsed ? (
            <ChevronRight size={14} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
          ) : (
            <ChevronDown size={14} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
          )}
          {group.ext?.icon ? (
            <img src={packAssetUrl(group.ext.packKey, group.ext.icon)} alt="" className="size-4 shrink-0" />
          ) : (
            <Icon size={14} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
          )}
          <span className="max-w-[70%] min-w-0 shrink-0 truncate font-medium text-fg" title={group.file}>
            {groupTitle(group)}
          </span>
          <span className="min-w-0 shrink-[4] truncate text-meta text-fg-faint">{groupHint(group)}</span>
        </div>
      )
    }
    if (row.type === 'category') {
      const collapsed = !filtering && isCategoryCollapsed(group, row.category, overrides)
      const props = row.category === PROPERTIES
      return (
        <div
          key={key}
          role="treeitem"
          aria-level={2}
          aria-expanded={!collapsed}
          tabIndex={tabIndex}
          data-task-row={key}
          onFocus={() => setCursor(key)}
          onClick={() => {
            setCursor(key)
            if (!filtering) toggleCategory(group, row.category)
          }}
          className={cn(rowClass, 'gap-1.5 pr-2 pl-5')}
        >
          {collapsed ? (
            <ChevronRight size={14} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
          ) : (
            <ChevronDown size={14} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
          )}
          {props && <SlidersHorizontal size={13} strokeWidth={1.5} className="shrink-0 text-fg-muted" />}
          <span className="min-w-0 truncate text-fg-secondary">
            {props ? tr('coding.tasks.gradle.properties') : row.category}
          </span>
          {props && <span className="min-w-0 truncate text-meta text-fg-faint">gradle.properties</span>}
          <span className="ml-auto shrink-0 rounded-full bg-subtle px-1.5 text-label text-fg-faint">{row.count}</span>
        </div>
      )
    }
    if (row.type === 'prop') {
      const { prop } = row
      return (
        <div
          key={key}
          role="treeitem"
          aria-level={3}
          tabIndex={tabIndex}
          data-task-row={key}
          title={prop.secret ? prop.key : `${prop.key}=${prop.value}`}
          onFocus={() => setCursor(key)}
          onClick={() => {
            setCursor(key)
            locateProp(group, prop)
          }}
          onContextMenu={e => {
            e.preventDefault()
            setCursor(key)
            setMenu({ kind: 'prop', x: e.clientX, y: e.clientY, group, prop })
          }}
          className={cn(
            rowClass,
            'gap-3 pr-2 pl-11 font-mono text-label',
            cursor === key && 'bg-selected hover:bg-selected',
          )}
        >
          <span className="min-w-0 shrink-0 max-w-[70%] truncate text-fg-secondary">{prop.key}</span>
          <span
            className="ml-auto min-w-0 truncate text-fg-faint"
            aria-label={prop.secret ? tr('coding.tasks.gradle.secret') : undefined}
          >
            {prop.secret ? '••••' : prop.value}
          </span>
        </div>
      )
    }
    const { task } = row
    const status = statuses.of(group, task)
    // 正在停止时 ■ 还在：程序没停下来（比如在问 Y/N）时可以再发一次 Ctrl+C
    const running = isAlive(status)
    return (
      <div
        key={key}
        role="treeitem"
        aria-level={deep ? 3 : 2}
        aria-selected={cursor === key}
        tabIndex={tabIndex}
        data-task-row={key}
        data-task-status={status.kind}
        title={taskCommand(group, task)}
        onFocus={() => setCursor(key)}
        onClick={() => {
          setCursor(key)
          runner.focus(group, task)
        }}
        onDoubleClick={() => void runner.run(group, task)}
        onContextMenu={e => {
          e.preventDefault()
          setCursor(key)
          setMenu({ kind: 'task', x: e.clientX, y: e.clientY, group, task })
        }}
        className={cn(
          'group/task gap-2 pr-1',
          rowClass,
          deep ? 'pl-10' : 'pl-6',
          cursor === key && 'bg-selected hover:bg-selected',
        )}
      >
        <StatusIcon status={status} />
        <span className="shrink-0 text-fg">{task.name}</span>
        <span className={cn('min-w-0 flex-1 truncate text-meta text-fg-faint', group.kind !== 'gradle' && 'font-mono')}>
          {taskDetail(group, task)}
        </span>
        {status.kind === 'failed' && status.code !== null && (
          <span className="shrink-0 text-meta text-fg-faint group-hover/task:hidden">
            {tr('coding.tasks.exitCode', { code: status.code })}
          </span>
        )}
        <button
          type="button"
          tabIndex={-1}
          aria-label={tr(running ? 'coding.tasks.stop' : 'coding.tasks.run', { name: task.name })}
          title={tr(running ? 'coding.tasks.stop' : 'coding.tasks.run', { name: task.name })}
          onClick={e => {
            e.stopPropagation()
            setCursor(key)
            if (running) runner.stop(group, task)
            else void runner.run(group, task)
          }}
          onDoubleClick={e => e.stopPropagation()}
          className={cn(
            'press flex size-5 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-hover hover:text-fg',
            running ? 'text-danger' : 'invisible group-hover/task:visible group-focus-visible/task:visible',
          )}
        >
          {running ? <Square size={11} strokeWidth={2} fill="currentColor" /> : <Play size={12} strokeWidth={1.75} />}
        </button>
      </div>
    )
  }

  const hasGroups = (state?.groups.length ?? 0) > 0
  return (
    <div data-coding-tasks className="flex h-full min-h-0 min-w-0 flex-col">
      <PanelHeader
        title={tr('coding.tasks.title')}
        actions={
          <>
            <IconButton
              icon={ChevronsDownUp}
              label={tr('coding.tasks.collapseAll')}
              size={24}
              iconSize={14}
              disabled={!hasGroups}
              onClick={collapseAll}
            />
            <IconButton
              icon={RefreshCw}
              label={tr('coding.tasks.refresh')}
              size={24}
              iconSize={14}
              disabled={!ref}
              className={entry.loading ? '[&_svg]:animate-spin' : undefined}
              onClick={refresh}
            />
          </>
        }
      />
      <label className="mx-2 mb-2 flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line bg-subtle px-2">
        <Search size={14} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
        <input
          value={query}
          aria-label={tr('coding.tasks.filter')}
          placeholder={tr('coding.tasks.filter')}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape' && query) {
              e.preventDefault()
              setQuery('')
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-meta text-fg outline-none"
        />
      </label>
      {!state && entry.error ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-ui font-medium text-fg-secondary">{tr('coding.tasks.error.title')}</p>
          <p className="max-w-full text-meta break-words text-fg-faint">{entry.error}</p>
          <Button onClick={refresh}>{tr('coding.tasks.error.retry')}</Button>
        </div>
      ) : !state ? (
        <div className="flex items-center gap-2 px-4 py-2 text-meta text-fg-faint">
          {ref && <Spinner size={12} />}
          <span>{tr('coding.tasks.loading')}</span>
        </div>
      ) : !hasGroups ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <ListChecks size={20} strokeWidth={1.5} className="text-fg-muted" />
          <p className="text-ui font-medium text-fg-secondary">{tr('coding.tasks.empty.title')}</p>
          <p className="text-meta text-fg-faint">{tr('coding.tasks.empty.hint')}</p>
          <Button icon={Plus} onClick={() => codingLayout.showRight('sandbox')}>
            {tr('coding.tasks.empty.add')}
          </Button>
        </div>
      ) : (
        <div
          ref={list}
          role="tree"
          aria-label={tr('coding.tasks.list')}
          onKeyDown={onKeyDown}
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        >
          {entry.error && <p className="px-2 pb-1 text-meta text-danger">{entry.error}</p>}
          {state.truncated && (
            <p className="px-2 pb-1 text-meta text-fg-faint">
              {tr(activeTaskTemplates().length ? 'tasks.ext.truncated' : 'coding.tasks.truncated')}
            </p>
          )}
          {filtering && groups.length === 0 && (
            <p className="px-2 py-1 text-meta text-fg-faint">{tr('coding.tasks.noMatch')}</p>
          )}
          {rows.map((row, index) => {
            const g = row.group.gradle
            // Gradle 根项目展开时，最后一行后面放完整列表的提示条
            const bar = g?.project === ':' && rows[index + 1]?.group !== row.group && !isCollapsed(row.group, overrides)
            return bar ? (
              <div key={rowKey(row)} role="none">
                {renderRow(row, index)}
                <GradleFullBar wsRef={ref} root={state.root} group={row.group} />
              </div>
            ) : (
              renderRow(row, index)
            )
          })}
        </div>
      )}
      {menu && (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          label={tr('coding.tasks.menu')}
          actions={menu.kind === 'task' ? taskActions(menu.group, menu.task) : propActions(menu.group, menu.prop)}
          onClose={() => setMenu(null)}
        />
      )}
      {args && (
        <ConfirmDialog
          title={tr('coding.tasks.args.title', { name: args.task.name })}
          focusInput
          busy={false}
          confirmLabel={tr('coding.tasks.args.run')}
          cancelLabel={tr('coding.tasks.args.cancel')}
          description={
            <div className="flex flex-col gap-2">
              <p className="font-mono text-meta break-all text-fg-faint">
                {taskCommand(args.group, args.task)} {args.value.trim()}
              </p>
              <input
                aria-label={tr('coding.tasks.args.label')}
                value={args.value}
                placeholder="--stacktrace"
                onChange={e => setArgs({ ...args, value: e.target.value })}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    runWithArgs(args)
                  }
                }}
                className="w-full rounded-md border border-line bg-surface px-3 py-2 font-mono text-ui text-fg outline-none focus:border-accent"
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-meta text-fg-faint">{tr('coding.tasks.args.common')}</span>
                {COMMON_ARGS.map(flag => {
                  const parts = args.value.split(/\s+/).filter(Boolean)
                  const on = parts.includes(flag)
                  return (
                    <button
                      key={flag}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setArgs({
                          ...args,
                          value: (on ? parts.filter(p => p !== flag) : [...parts, flag]).join(' '),
                        })
                      }
                      className={cn(
                        'press rounded-md border px-1.5 py-0.5 font-mono text-meta',
                        on ? 'border-accent bg-accent-soft text-accent-fg' : 'border-line text-fg-muted hover:bg-hover',
                      )}
                    >
                      {flag}
                    </button>
                  )
                })}
              </div>
            </div>
          }
          onConfirm={() => runWithArgs(args)}
          onCancel={() => setArgs(null)}
        />
      )}
    </div>
  )
}

/** 工具条「任务」图标上的角标：在跑的任务个数 */
export function useRunningTaskCount(): number {
  const { ref } = useCodingWorkspace()
  return useTaskStatuses(useRunTasks(ref).state).running
}
