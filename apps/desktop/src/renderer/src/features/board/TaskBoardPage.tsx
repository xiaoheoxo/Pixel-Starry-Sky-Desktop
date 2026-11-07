// 任务看板页（docs/ui/task-board.md）：跨项目的四列——待办、进行中、等你、已完成。
// 手动任务能拖着换列；AI 卡片（会话）的位置由会话自己的状态决定，只能在卡片上直接处理。
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  Workflow,
} from 'lucide-react'
import { Button, Segmented, Select, cn, useRestoreFocus } from '@/ui'
import { ActionMenu } from '@/ui/ActionMenu'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { isDemo, projects as demoProjects } from '@/data'
import { bridge, isLive, useEngineState } from '@/features/engine'
import { machineOf, useMachines } from '@/features/machines/store'
import { setPage, showWorkbench } from '@/features/layout/page'
import { channelActions, useChannels } from '@/features/channels/store'
import { paneActions } from '@/features/panes/store'
import { openTask } from '@/features/panel/openTask'
import { pinTask } from '@/features/panel/pinnedTasks'
import { resolveDemoInbox } from '@/features/panel/inbox/useInbox'
import { FIELD, Field, useOperation, useRemember } from '@/features/panel/ToolsUi'
import type { ManualTask } from '../../../../shared/types/project-tools'
import { changedTaskFields } from './taskPatch'
import { ListInput } from '@/features/panel/ListInput'
import { AiCard, TaskCard } from './BoardCards'
import { STATUS_OF, buildColumns, scheduleTasks, type BoardKind, type ColumnId } from './boardModel'
import {
  createBoardTask,
  deleteBoardTask,
  markDemoPinned,
  runBoardSchedule,
  updateBoardTask,
  useBoardTasks,
} from './boardTasks'
import { FlowScheduleCard, ScheduleCard, ScheduleEmpty, ScheduleFields, ScheduleHistoryDialog } from './ScheduleParts'
import { SCHEDULE_TEMPLATES, defaultSchedule, sameSchedule } from './scheduleModel'
import { useSessionCards } from './useSessionCards'
import {
  IssueFields,
  ReviewDialog,
  RulesDialog,
  dispatchIssue,
  openIssueCard,
  useAssignRules,
  useAssigneeChoices,
} from './IssueParts'
import { acceptanceText, assigneeKey, matchRule, parseAcceptance, sameAcceptance } from './issues'
import type { IssueAssignee, ScheduleRun, TaskSchedule } from '../../../../shared/types/project-tools'

const COLUMN_NAME = {
  todo: 'board.column.todo',
  doing: 'board.column.doing',
  review: 'board.column.review',
  waiting: 'board.column.waiting',
  done: 'board.column.done',
} as const
const COLUMN_EMPTY = {
  todo: 'board.empty.todo',
  doing: 'board.empty.doing',
  review: 'board.empty.review',
  waiting: 'board.empty.waiting',
  done: 'board.empty.done',
} as const
const STATUS_KEY = {
  pending: 'projectTools.pending',
  in_progress: 'projectTools.inProgress',
  review: 'projectTools.review',
  completed: 'projectTools.completed',
} as const
const DRAG_TYPE = 'application/x-pixelsky-board-task'

// 事项的负责人、验收标准（一行一条）也在编辑里（docs/ui/channels-collab-v2.md §9）
type Form = Pick<ManualTask, 'title' | 'note' | 'status' | 'priority' | 'due' | 'tags'> & {
  assignee: IssueAssignee | null
  acceptance: string
  /** 定时运行（docs/ui/board-schedule.md）；null = 普通任务 */
  schedule: TaskSchedule | null
}
const formOf = (t: ManualTask): Form => ({
  title: t.title,
  note: t.note,
  status: t.status,
  priority: t.priority,
  due: t.due,
  tags: t.tags,
  assignee: t.assignee ?? null,
  acceptance: acceptanceText(t.acceptance),
  schedule: t.schedule ?? null,
})

/** 保存编辑时发的改动：基本字段只发改过的，负责人和验收标准变了才发 */
function editPatch(task: ManualTask, form: Form): Partial<ManualTask> {
  const patch: Partial<ManualTask> = changedTaskFields(formOf(task), form)
  const before = task.assignee ? assigneeKey(task.assignee) : ''
  if ((form.assignee ? assigneeKey(form.assignee) : '') !== before) patch.assignee = form.assignee
  const acceptance = parseAcceptance(form.acceptance, task.acceptance)
  if (!sameAcceptance(acceptance, task.acceptance)) patch.acceptance = acceptance
  if (!sameSchedule(form.schedule, task.schedule)) patch.schedule = form.schedule
  return patch
}

export function TaskBoardPage() {
  useI18n()
  const { tasks, error: loadError } = useBoardTasks()
  const sessions = useSessionCards()
  const engineProjects = useEngineState(s => s.projects)
  const machine = useMachines().currentId
  const projects = useMemo(
    () =>
      isLive
        ? engineProjects.filter(p => machineOf(p.id) === machine).map(p => ({ id: p.id, name: p.name }))
        : demoProjects.map(p => ({ id: p.id, name: p.name })),
    [engineProjects, machine],
  )
  const names = useMemo(() => new Map(projects.map(p => [p.id, p.name])), [projects])
  const [projectFilter, setProjectFilter] = useRemember<string[]>('pixelsky.board.projects', [])
  const [storedKind, setKind] = useRemember<BoardKind>('pixelsky.board.kind', 'all')
  // 默认收起，把位置让给「等你」；手动展开过的按记住的（docs/ui/board-schedule.md §4）
  const [scheduleCollapsed, setScheduleCollapsed] = useRemember<boolean>('pixelsky.board.scheduleCollapsed', true)
  // 定时任务只在本机的项目上跑（docs/ui/board-schedule.md）
  const canSchedule = machine === 'local'
  const kind: BoardKind = storedKind === 'schedule' && !canSchedule ? 'all' : storedKind
  const engines = useEngineState(s => s.engines)
  const channels = useChannels(s => s.channels)
  const [historyId, setHistoryId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [showOlder, setShowOlder] = useState(false)
  const [now, setNow] = useState(Date.now)
  const [creating, setCreating] = useState<{ title: string; projectId: string } | null>(null)
  // 新建任务的输入框关掉后焦点回到点开它的「+」
  useRestoreFocus(!!creating)
  const [editing, setEditing] = useState<{ task: ManualTask; form: Form; isNew?: boolean } | null>(null)
  const [deleting, setDeleting] = useState<ManualTask | null>(null)
  const [reviewing, setReviewing] = useState<ManualTask | null>(null)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [rules, setRules] = useAssignRules()
  const choices = useAssigneeChoices(editing?.task.projectId ?? null)
  const allChoices = useAssigneeChoices(null)
  const [menu, setMenu] = useState<{ task: ManualTask; x: number; y: number; trigger: HTMLElement } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<ColumnId | null>(null)
  const { busy, error, setError, run } = useOperation()
  const search = useRef<HTMLInputElement>(null)
  const lastProject = useRef<string | null>(null)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  // 选中的项目被移除后不再算进筛选
  const filterProjects = useMemo(() => projectFilter.filter(id => names.has(id)), [projectFilter, names])
  const columns = useMemo(
    () =>
      buildColumns({
        tasks,
        sessions,
        filter: { projects: filterProjects, kind, query },
        knownProjects: new Set(names.keys()),
        showOlder,
        now,
      }),
    [tasks, sessions, filterProjects, kind, query, names, showOlder, now],
  )

  const scheduled = useMemo(
    () =>
      canSchedule
        ? scheduleTasks({
            tasks,
            filter: { projects: filterProjects, kind, query },
            knownProjects: new Set(names.keys()),
          })
        : [],
    [canSchedule, tasks, filterProjects, kind, query, names],
  )
  // 频道里每天定时运行的流程：只读列出，点开跳到频道
  const flows = useMemo(() => {
    if (!canSchedule || kind === 'mine' || kind === 'ai') return []
    const q = query.trim().toLocaleLowerCase()
    return channels
      .filter(c => !c.archivedAt && (!filterProjects.length || (!!c.projectId && filterProjects.includes(c.projectId))))
      .flatMap(channel => (channel.schedules ?? []).map(flow => ({ channel, flow })))
      .filter(({ flow }) => !q || flow.title.toLocaleLowerCase().includes(q))
  }, [canSchedule, kind, query, channels, filterProjects])
  const historyTask = historyId ? tasks.find(t => t.id === historyId) : undefined
  const showSchedule = canSchedule && (kind === 'schedule' || scheduled.length > 0 || flows.length > 0)

  // Ctrl+N 新任务，/ 聚焦搜索（输入框里不抢）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      const typing = e.target instanceof HTMLElement && e.target.closest('input,textarea,select,[contenteditable]')
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        startCreate()
      } else if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        search.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const defaultProject = (): string | null => {
    if (filterProjects.length) return filterProjects[0]
    if (lastProject.current && names.has(lastProject.current)) return lastProject.current
    return projects[0]?.id ?? null
  }
  const startCreate = () => {
    const projectId = defaultProject()
    if (!projectId) {
      setError(tr('board.noProject'))
      return
    }
    setCreating({ title: '', projectId })
  }
  const startCreateSchedule = (template?: (typeof SCHEDULE_TEMPLATES)[number]) => {
    const projectId = defaultProject()
    if (!projectId) {
      setError(tr('board.noProject'))
      return
    }
    const engine = engines.find(e => e.status === 'ready')?.id ?? engines[0]?.id
    setEditing({
      isNew: true,
      task: {
        id: '',
        projectId,
        title: '',
        note: '',
        status: 'pending',
        priority: 'normal',
        due: '',
        tags: [],
        order: 0,
        createdAt: 0,
        updatedAt: 0,
      },
      form: {
        title: template ? tr(`board.schedule.tpl.${template.id}.title`) : '',
        note: template ? tr(`board.schedule.tpl.${template.id}.note`) : '',
        status: 'pending',
        priority: 'normal',
        due: '',
        tags: [],
        assignee: null,
        acceptance: '',
        schedule: {
          ...defaultSchedule(engine),
          ...(template
            ? { freq: template.freq, hour: template.hour, minute: template.minute, weekday: template.weekday }
            : {}),
        },
      },
    })
  }
  const toggleSchedule = (task: ManualTask, enabled: boolean) =>
    void run(() => updateBoardTask(task.id, { schedule: { ...task.schedule!, enabled } }))
  const openRun = (run: ScheduleRun) => {
    setHistoryId(null)
    if (run.sessionId) openCard(run.sessionId)
    else if (run.card) openIssueCard(run.card)
  }
  const saveCreate = () => {
    if (!creating || !creating.title.trim()) return
    const draft = creating
    void run(async () => {
      // 分配规则命中时直接填上负责人
      const assignee = matchRule(rules, { title: draft.title, tags: [], projectId: draft.projectId }, allChoices)
      await createBoardTask(draft.projectId, {
        title: draft.title.trim(),
        status: 'pending',
        ...(assignee ? { assignee } : {}),
      })
      lastProject.current = draft.projectId
      setCreating(null)
    })
  }

  const setStatus = (task: ManualTask, status: ManualTask['status']) => {
    if (task.status === status) return
    void run(() => updateBoardTask(task.id, { status }))
  }
  const toggle = (task: ManualTask) => setStatus(task, task.status === 'completed' ? 'pending' : 'completed')
  const togglePin = (task: ManualTask) =>
    void run(async () => {
      const on = !task.pinnedAt
      await pinTask(task, on)
      markDemoPinned(task.id, on)
    })
  const saveEdit = () => {
    if (!editing || !editing.form.title.trim()) return
    const { task, form, isNew } = editing
    void run(async () => {
      if (isNew) {
        await createBoardTask(task.projectId, {
          title: form.title.trim(),
          note: form.note,
          priority: form.priority,
          tags: form.tags.filter(Boolean),
          ...(form.schedule ? {} : { status: form.status, due: form.due }),
          ...(form.assignee ? { assignee: form.assignee } : {}),
          ...(form.schedule ? { schedule: form.schedule } : {}),
        })
        lastProject.current = task.projectId
      } else {
        // 只发改过的字段：弹窗开着时状态可能已在别处（右栏、侧栏固定项、手机）改过
        await updateBoardTask(task.id, editPatch(task, form))
      }
      setEditing(null)
    })
  }

  const dispatch = (task: ManualTask) => void run(() => dispatchIssue(task))
  const openCard = (id: string) => {
    showWorkbench()
    paneActions.open(id)
  }
  const sessionAction = (id: string, fn: () => Promise<unknown>) =>
    void run(async () => {
      if (isDemo) resolveDemoInbox(id)
      else await fn()
    })

  const drop = (column: ColumnId, e: React.DragEvent) => {
    e.preventDefault()
    setOver(null)
    const id = e.dataTransfer.getData(DRAG_TYPE) || dragging
    const status = STATUS_OF[column]
    const task = tasks.find(t => t.id === id)
    setDragging(null)
    if (task && status) setStatus(task, status)
  }

  const projectLabel = filterProjects.length
    ? filterProjects.length === 1
      ? (names.get(filterProjects[0]) ?? '')
      : tr('board.filter.someProjects', { n: filterProjects.length })
    : tr('board.filter.allProjects')
  const [projectMenu, setProjectMenu] = useState<{ x: number; y: number } | null>(null)

  return (
    <div className="absolute inset-0 flex min-w-0 flex-col bg-app" data-task-board>
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pt-3 pb-2">
        <Button variant="ghost" icon={ArrowLeft} className="h-8 px-2 text-meta" onClick={showWorkbench}>
          {tr('board.back')}
        </Button>
        <span className="flex-1" />
        <button
          type="button"
          aria-haspopup="menu"
          aria-label={tr('board.filter.projects')}
          onClick={e => {
            const r = e.currentTarget.getBoundingClientRect()
            setProjectMenu({ x: r.left, y: r.bottom + 4 })
          }}
          className="press inline-flex h-8 max-w-48 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-ui text-fg-secondary hover:bg-hover"
        >
          <span className="truncate">{projectLabel}</span>
          <ChevronDown size={14} className="shrink-0 text-fg-muted" />
        </button>
        <Segmented<BoardKind>
          label={tr('board.filter.all')}
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: tr('board.filter.all') },
            { value: 'mine', label: tr('board.filter.mine') },
            { value: 'ai', label: tr('board.filter.ai') },
            ...(canSchedule ? [{ value: 'schedule' as const, label: tr('board.filter.schedule') }] : []),
          ]}
        />
        <label className="relative flex h-8 w-56 items-center">
          <Search size={14} className="pointer-events-none absolute left-2.5 text-fg-muted" />
          <input
            ref={search}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape' && query && !e.nativeEvent.isComposing) {
                e.preventDefault()
                setQuery('')
              }
            }}
            aria-label={tr('board.search')}
            placeholder={tr('board.search')}
            className={cn(FIELD, 'pl-8')}
          />
        </label>
        <Button variant="ghost" icon={Workflow} className="h-8 text-meta" onClick={() => setRulesOpen(true)}>
          {tr('board.rules.open')}
        </Button>
        <Button variant="primary" icon={Plus} className="h-8" onClick={startCreate}>
          {tr('board.newTask')}
        </Button>
      </div>
      {(error || loadError) && (
        <p role="alert" className="mx-4 mb-2 shrink-0 rounded-md bg-subtle p-2 text-meta text-danger">
          {translateMessage(error || loadError)}
        </p>
      )}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-4">
        {showSchedule &&
          // 筛选「定时」时这一列是主角（没有定时任务时还要显示模板），不收起
          (scheduleCollapsed && kind !== 'schedule' ? (
            <section
              data-board-column="schedule"
              aria-label={tr('board.columnLabel', {
                name: tr('board.column.schedule'),
                n: scheduled.length + flows.length,
              })}
              className="flex w-9 shrink-0 flex-col items-center gap-2 rounded-xl border border-accent-line/40 bg-accent-soft/30 py-3"
            >
              <button
                type="button"
                aria-label={tr('board.schedule.expand')}
                title={tr('board.schedule.expand')}
                onClick={() => setScheduleCollapsed(false)}
                className="flex size-6 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
              >
                <ChevronRight size={14} />
              </button>
              <Clock size={14} className="text-accent-fg" aria-hidden />
              <span className="text-meta text-fg-muted [writing-mode:vertical-rl]">{tr('board.column.schedule')}</span>
              <span className="text-meta text-fg-faint tabular-nums">{scheduled.length + flows.length}</span>
            </section>
          ) : (
            <section
              data-board-column="schedule"
              aria-label={tr('board.columnLabel', {
                name: tr('board.column.schedule'),
                n: scheduled.length + flows.length,
              })}
              className="flex min-h-0 w-[236px] shrink-0 flex-col rounded-xl border border-accent-line/40 bg-accent-soft/30"
            >
              <header className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
                <Clock size={14} className="text-accent-fg" aria-hidden />
                <h2 className="text-ui font-medium text-fg">{tr('board.column.schedule')}</h2>
                <span className="text-meta text-fg-faint tabular-nums">{scheduled.length + flows.length}</span>
                <span className="flex-1" />
                {kind !== 'schedule' && (
                  <button
                    type="button"
                    aria-label={tr('board.schedule.collapse')}
                    title={tr('board.schedule.collapse')}
                    onClick={() => setScheduleCollapsed(true)}
                    className="flex size-6 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
                  >
                    <ChevronLeft size={14} />
                  </button>
                )}
              </header>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 [scrollbar-width:thin]">
                {scheduled.map(task => (
                  <ScheduleCard
                    key={task.id}
                    task={task}
                    project={names.get(task.projectId) ?? ''}
                    now={now}
                    busy={busy}
                    onOpen={() => setHistoryId(task.id)}
                    onToggle={enabled => toggleSchedule(task, enabled)}
                  />
                ))}
                {flows.map(({ channel, flow }) => (
                  <FlowScheduleCard
                    key={`${channel.id}-${flow.id}`}
                    channel={channel}
                    flow={flow}
                    onOpen={() => {
                      setPage('channels')
                      channelActions.select(channel.id)
                    }}
                  />
                ))}
                {!scheduled.length && !flows.length && (
                  <ScheduleEmpty onTemplate={id => startCreateSchedule(SCHEDULE_TEMPLATES.find(t => t.id === id))} />
                )}
              </div>
              <button
                type="button"
                onClick={() => startCreateSchedule()}
                className="press m-2 mt-0 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-meta text-fg-muted hover:bg-hover hover:text-fg"
              >
                <Plus size={13} />
                {tr(scheduled.length || flows.length ? 'board.schedule.add' : 'board.schedule.own')}
              </button>
            </section>
          ))}
        {columns
          .filter(c => c.id !== 'review' || c.tasks.length > 0)
          .filter(c => kind !== 'schedule' || c.sessions.length > 0)
          .map(column => {
            const count = column.tasks.length + column.sessions.length
            const accepts = !!STATUS_OF[column.id]
            const refused = dragging !== null && !accepts
            return (
              <section
                key={column.id}
                data-board-column={column.id}
                aria-label={tr('board.columnLabel', { name: tr(COLUMN_NAME[column.id]), n: count })}
                onDragOver={e => {
                  if (!dragging) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = accepts ? 'move' : 'none'
                  if (over !== column.id) setOver(column.id)
                }}
                onDragLeave={e => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(o => (o === column.id ? null : o))
                }}
                onDrop={e => (accepts ? drop(column.id, e) : (e.preventDefault(), setOver(null)))}
                title={refused ? tr('board.dropNotAllowed') : undefined}
                className={cn(
                  'flex min-h-0 min-w-[260px] flex-1 flex-col rounded-xl border border-transparent bg-subtle/60 transition-colors',
                  column.id === 'waiting' && count > 0 && 'border-warn/35 bg-warn/10',
                  over === column.id && accepts && 'border-accent-line bg-accent-soft/40',
                  over === column.id && refused && 'border-danger/40',
                  refused && 'opacity-60',
                )}
              >
                <header className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
                  <h2 className="text-ui font-medium text-fg">{tr(COLUMN_NAME[column.id])}</h2>
                  <span className="text-meta text-fg-faint tabular-nums">{count}</span>
                  <span className="flex-1" />
                  {column.id === 'todo' && (
                    <button
                      type="button"
                      aria-label={tr('board.newTask')}
                      title={tr('board.newTask')}
                      onClick={startCreate}
                      className="flex size-6 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
                    >
                      <Plus size={14} />
                    </button>
                  )}
                </header>
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 [scrollbar-width:thin]">
                  {column.id === 'todo' && creating && (
                    <div className="flex flex-col gap-2 rounded-lg border border-accent-line bg-surface p-2.5 shadow-sm">
                      <input
                        autoFocus
                        maxLength={200}
                        value={creating.title}
                        placeholder={tr('board.newTaskPlaceholder')}
                        aria-label={tr('projectTools.taskTitle')}
                        onChange={e => setCreating({ ...creating, title: e.target.value })}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                            e.preventDefault()
                            saveCreate()
                          } else if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                            e.preventDefault()
                            setCreating(null)
                          }
                        }}
                        className={FIELD}
                      />
                      <div className="flex items-center gap-2">
                        <Select
                          label={tr('board.project')}
                          value={creating.projectId}
                          options={projects.map(p => ({ value: p.id, label: p.name }))}
                          onChange={projectId => setCreating({ ...creating, projectId })}
                          className="min-w-0 flex-1"
                        />
                        <Button
                          variant="primary"
                          className="h-8"
                          disabled={busy || !creating.title.trim()}
                          onClick={saveCreate}
                        >
                          {tr('board.save')}
                        </Button>
                        <Button variant="ghost" className="h-8" onClick={() => setCreating(null)}>
                          {tr('board.cancel')}
                        </Button>
                      </div>
                    </div>
                  )}
                  {column.sessions.map(card => (
                    <AiCard
                      key={card.id}
                      card={card}
                      column={column.id}
                      now={now}
                      busy={busy}
                      onOpen={() => openCard(card.id)}
                      onAllow={() =>
                        sessionAction(card.id, () =>
                          bridge!.answer(card.id, card.request!.requestId, { type: 'allow' }),
                        )
                      }
                      onDeny={() =>
                        sessionAction(card.id, () => bridge!.answer(card.id, card.request!.requestId, { type: 'deny' }))
                      }
                      onRetry={() =>
                        sessionAction(card.id, () =>
                          bridge!.send(card.id, tr('session.live.NoticeActions.retryMessage')),
                        )
                      }
                      onResume={() => sessionAction(card.id, () => bridge!.resumeQueue(card.id))}
                    />
                  ))}
                  {column.tasks.map(task => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      column={column.id}
                      project={names.get(task.projectId) ?? ''}
                      now={now}
                      busy={busy}
                      onToggle={() => toggle(task)}
                      onOpen={() => setEditing({ task, form: formOf(task) })}
                      onMenu={(x, y, trigger) => setMenu({ task, x, y, trigger })}
                      onDispatch={() => dispatch(task)}
                      onReview={() => setReviewing(task)}
                      onDragStart={() => setDragging(task.id)}
                      onDragEnd={() => {
                        setDragging(null)
                        setOver(null)
                      }}
                    />
                  ))}
                  {!count && !(column.id === 'todo' && creating) && (
                    <p className="px-2 py-6 text-center text-meta text-fg-faint">{tr(COLUMN_EMPTY[column.id])}</p>
                  )}
                  {column.id === 'done' && (column.older > 0 || showOlder) && (
                    <button
                      type="button"
                      onClick={() => setShowOlder(v => !v)}
                      className="mx-auto rounded-md px-2 py-1 text-meta text-fg-muted hover:bg-hover hover:text-fg"
                    >
                      {showOlder ? tr('board.hideOlder') : tr('board.showOlder', { n: column.older })}
                    </button>
                  )}
                </div>
              </section>
            )
          })}
      </div>

      {projectMenu && (
        <ActionMenu
          x={projectMenu.x}
          y={projectMenu.y}
          label={tr('board.filter.projects')}
          onClose={() => setProjectMenu(null)}
          actions={[
            {
              label: tr('board.filter.allProjects'),
              checked: !filterProjects.length,
              run: () => setProjectFilter([]),
            },
            ...projects.map((p, i) => ({
              label: p.name,
              separator: i === 0,
              checked: filterProjects.includes(p.id),
              run: () =>
                setProjectFilter(
                  filterProjects.includes(p.id) ? filterProjects.filter(id => id !== p.id) : [...filterProjects, p.id],
                ),
            })),
          ]}
        />
      )}

      {menu && (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          label={menu.task.title}
          onClose={() => {
            setMenu(null)
            if (menu.trigger.isConnected) menu.trigger.focus({ preventScroll: true })
          }}
          actions={[
            {
              label: tr('board.edit'),
              icon: Pencil,
              run: () => setEditing({ task: menu.task, form: formOf(menu.task) }),
            },
            {
              label: tr(menu.task.status === 'completed' ? 'board.markNotDone' : 'board.markDone'),
              icon: Check,
              run: () => toggle(menu.task),
            },
            {
              label: tr(menu.task.pinnedAt ? 'board.unpin' : 'board.pin'),
              icon: menu.task.pinnedAt ? PinOff : Pin,
              run: () => togglePin(menu.task),
            },
            {
              label: tr('board.viewInProject'),
              icon: ExternalLink,
              run: () => openTask(menu.task.projectId, menu.task.id),
            },
            {
              label: tr('board.delete'),
              icon: Trash2,
              danger: true,
              separator: true,
              run: () => setDeleting(menu.task),
            },
          ]}
        />
      )}

      {editing && (
        <ConfirmDialog
          title={tr(editing.isNew ? 'board.newTask' : 'board.edit')}
          focusInput
          wide={!!editing.form.schedule}
          extra={
            editing.task.schedule && !editing.isNew
              ? {
                  label: tr('board.delete'),
                  onClick: () => {
                    setDeleting(editing.task)
                    setEditing(null)
                  },
                }
              : undefined
          }
          busy={busy}
          error={error ? translateMessage(error) : null}
          confirmLabel={tr('board.save')}
          cancelLabel={tr('board.cancel')}
          confirmDisabled={!editing.form.title.trim()}
          onConfirm={saveEdit}
          onCancel={() => setEditing(null)}
          description={
            <div className="mt-3 flex flex-col gap-3 text-left">
              <Field label={tr('projectTools.taskTitle')}>
                <input
                  maxLength={200}
                  value={editing.form.title}
                  onChange={e => setEditing({ ...editing, form: { ...editing.form, title: e.target.value } })}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      saveEdit()
                    }
                  }}
                  className={FIELD}
                />
              </Field>
              <Field label={tr(editing.form.schedule ? 'board.schedule.note' : 'projectTools.note')}>
                <textarea
                  maxLength={4000}
                  value={editing.form.note}
                  onChange={e => setEditing({ ...editing, form: { ...editing.form, note: e.target.value } })}
                  className={cn(FIELD, 'h-20 py-2')}
                />
              </Field>
              {canSchedule && (
                <ScheduleFields
                  schedule={editing.form.schedule}
                  assignee={editing.form.assignee}
                  choices={choices}
                  onChange={schedule => setEditing({ ...editing, form: { ...editing.form, schedule } })}
                  onAssignee={assignee => setEditing({ ...editing, form: { ...editing.form, assignee } })}
                />
              )}
              <div className="flex flex-wrap gap-2">
                {editing.isNew && (
                  <Select
                    label={tr('board.project')}
                    value={editing.task.projectId}
                    options={projects.map(p => ({ value: p.id, label: p.name }))}
                    onChange={projectId => setEditing({ ...editing, task: { ...editing.task, projectId } })}
                  />
                )}
                {!editing.form.schedule && (
                  <Select
                    label={tr('projectTools.pending')}
                    value={editing.form.status}
                    options={Object.entries(STATUS_KEY).map(([value, key]) => ({
                      value: value as ManualTask['status'],
                      label: tr(key),
                    }))}
                    onChange={status => setEditing({ ...editing, form: { ...editing.form, status } })}
                  />
                )}
                <Select
                  label={tr('projectTools.priority.normal')}
                  value={editing.form.priority}
                  options={(['low', 'normal', 'high'] as const).map(value => ({
                    value,
                    label: tr(`projectTools.priority.${value}`),
                  }))}
                  onChange={priority => setEditing({ ...editing, form: { ...editing.form, priority } })}
                />
                {!editing.isNew && (
                  <span className="self-center text-meta text-fg-faint">{names.get(editing.task.projectId) ?? ''}</span>
                )}
              </div>
              {!editing.form.schedule && (
                <IssueFields
                  choices={choices}
                  assignee={editing.form.assignee}
                  acceptance={editing.form.acceptance}
                  suggestion={matchRule(rules, { ...editing.form, projectId: editing.task.projectId }, choices)}
                  onAssignee={assignee => setEditing({ ...editing, form: { ...editing.form, assignee } })}
                  onAcceptance={acceptance => setEditing({ ...editing, form: { ...editing.form, acceptance } })}
                />
              )}
              {!editing.form.schedule && (
                <Field label={tr('projectTools.due')}>
                  <input
                    type="date"
                    value={editing.form.due}
                    onChange={e => setEditing({ ...editing, form: { ...editing.form, due: e.target.value } })}
                    className={FIELD}
                  />
                </Field>
              )}
              <Field label={tr('projectTools.tags')}>
                <ListInput
                  value={editing.form.tags}
                  onChange={tags => setEditing({ ...editing, form: { ...editing.form, tags } })}
                  className={FIELD}
                />
              </Field>
              {!editing.isNew && (
                <button
                  type="button"
                  onClick={() => {
                    const task = editing.task
                    setEditing(null)
                    openTask(task.projectId, task.id)
                  }}
                  className="inline-flex items-center gap-1.5 self-start text-meta text-fg-muted hover:text-fg"
                >
                  <ExternalLink size={13} />
                  {tr('board.viewInProject')}
                </button>
              )}
            </div>
          }
        />
      )}

      {historyTask?.schedule && (
        <ScheduleHistoryDialog
          task={historyTask}
          project={names.get(historyTask.projectId) ?? ''}
          engineName={engines.find(e => e.id === historyTask.schedule!.engine)?.name ?? historyTask.schedule.engine}
          now={now}
          busy={busy}
          error={error ? translateMessage(error) : null}
          onRun={() => void run(() => runBoardSchedule(historyTask.id))}
          onToggle={() => toggleSchedule(historyTask, !historyTask.schedule!.enabled)}
          onEdit={() => {
            setHistoryId(null)
            setEditing({ task: historyTask, form: formOf(historyTask) })
          }}
          onOpenRun={openRun}
          onClose={() => setHistoryId(null)}
        />
      )}
      {reviewing && (
        <ReviewDialog task={tasks.find(t => t.id === reviewing.id) ?? reviewing} onClose={() => setReviewing(null)} />
      )}
      {rulesOpen && (
        <RulesDialog projects={projects} saved={rules} onSave={setRules} onClose={() => setRulesOpen(false)} />
      )}

      {deleting && (
        <ConfirmDialog
          title={tr('board.deleteTitle', { title: deleting.title })}
          description={<p>{tr('board.deleteDescription')}</p>}
          busy={busy}
          danger
          confirmLabel={tr('board.delete')}
          cancelLabel={tr('board.cancel')}
          onConfirm={() =>
            void run(async () => {
              await deleteBoardTask(deleting.id)
              setDeleting(null)
            })
          }
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  )
}
