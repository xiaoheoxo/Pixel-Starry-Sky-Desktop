import { scrollInPane } from '@/ui/scrollInPane'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Check, Circle, Copy, ListChecks, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { Button, IconButton, Select } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { useEngineState } from '@/features/engine'
import { useSessionDigests } from '@/features/engine/sessionDigest'
import { OPEN_SESSION_EVENT } from '@/features/engine/openRequests'
import { useProjectContext } from './projectContext'
import { useTaskLocation } from './taskNavigation'
import { CARD, FIELD, Field, NoProject, ToolError, ToolsHeader, useOperation, useRemember } from './ToolsUi'
import { TaskInbox } from './inbox/TaskInbox'
import type { ManualTask, TaskState } from '../../../../shared/types/project-tools'
import { demo as demoData } from '@/data/demo'
import { TASK_DRAG_TYPE, pinTask, startTaskDrag, usePinnedTasks } from './pinnedTasks'
import { changedTaskFields, type TaskForm } from '@/features/board/taskPatch'
import { ListInput } from './ListInput'
const EMPTY: TaskState = { tasks: [], plans: [] }
const blank = {
  title: '',
  note: '',
  priority: 'normal' as ManualTask['priority'],
  status: 'pending' as ManualTask['status'],
  due: '',
  tags: [] as string[],
}
/** 没保存的任务表单按项目暂存（切换项目会整块重建任务面板），只在内存里，重启不留 */
const drafts = new Map<string, { editing: string | null; form: typeof blank; origin: TaskForm }>()
const statusKey = {
  pending: 'projectTools.pending',
  in_progress: 'projectTools.inProgress',
  completed: 'projectTools.completed',
} as const

export function TasksPanel() {
  useI18n()
  const context = useProjectContext()
  // 待处理不依赖当前项目，放在最上面（docs/ui/tasks-inbox.md §2）；下面是这个项目的 AI 计划和我的待办
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="shrink-0 px-3 pt-3">
        <TaskInbox />
      </div>
      {context.projectId ? (
        <TasksBody key={context.projectId} projectId={context.projectId} name={context.name} demo={context.demo} />
      ) : (
        <NoProject />
      )}
    </div>
  )
}
function TasksBody({ projectId, name, demo }: { projectId: string; name: string; demo: boolean }) {
  useI18n()
  // 演示的任务算在当前显示的项目下（固定到侧栏后点开能回到这个项目）
  const [data, setData] = useState<TaskState>(() => {
    if (!demo) return EMPTY
    const tasks = structuredClone(demoData().projectTools.tasks)
    return { ...tasks, tasks: tasks.tasks.map(task => ({ ...task, projectId })) }
  })
  const [loaded, setLoaded] = useState(demo)
  const [filter, setFilter] = useRemember('pixelsky.tasks.filter:' + projectId, 'all')
  const [source, setSource] = useRemember('pixelsky.tasks.source:' + projectId, 'all')
  const [query, setQuery] = useState('')
  const location = useTaskLocation()
  useEffect(() => {
    if (location?.projectId !== projectId) return
    setFilter('all')
    setSource('mine')
    setQuery('')
  }, [location?.seq])
  useEffect(() => {
    if (location?.projectId !== projectId || !data.tasks.some(task => task.id === location.taskId)) return
    const frame = requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>('[data-tool-task="' + location.taskId + '"]')
      scrollInPane(row, 'nearest')
      row?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [location?.seq, data.tasks])
  // 切走项目、关掉右栏时暂存的表单：回来接着填
  const kept = drafts.get(projectId)
  const [editing, setEditing] = useState<string | null>(kept?.editing ?? null),
    [form, setForm] = useState(kept?.form ?? blank),
    // 打开编辑时的样子：保存时只发改过的字段（changedTaskFields）
    origin = useRef<TaskForm>(kept?.origin ?? blank),
    [showForm, setShowForm] = useState(!!kept),
    // 表单有没保存的改动时，换去编辑别的（添加、另一个任务的铅笔、转成待办）先问一句
    [pendingOpen, setPendingOpen] = useState<(() => void) | null>(null)
  const openForm = (id: string | null, next: TaskForm): void => {
    const open = (): void => {
      setEditing(id)
      setForm({ ...blank, ...next })
      origin.current = next
      setShowForm(true)
    }
    if (showForm && Object.keys(changedTaskFields(origin.current, form)).length > 0) setPendingOpen(() => open)
    else open()
  }
  const latest = useRef({ editing, form, showForm })
  latest.current = { editing, form, showForm }
  useEffect(() => {
    drafts.delete(projectId)
    return () => {
      const l = latest.current
      if (l.showForm && Object.keys(changedTaskFields(origin.current, l.form)).length > 0)
        drafts.set(projectId, { editing: l.editing, form: l.form, origin: origin.current })
    }
  }, [])
  const { busy, error, setError, run } = useOperation()
  // 固定到左侧栏（docs/ui/files-search-terminal-pins.md §5）
  const pins = usePinnedTasks()
  const pinnedNow = (task: ManualTask): boolean => pins.some(p => p.id === task.id) || (!demo && !!task.pinnedAt)
  // 只看各会话最新的待办：别的会话在输出时不跟着重算（docs/perf-audit-2026-10-18.md B3）
  const digests = useSessionDigests(),
    sessions = useEngineState(s => s.sessions)
  useEffect(() => {
    if (demo || !window.pixelsky) return
    let stopped = false,
      version = 0
    const load = async () => {
      const n = ++version
      try {
        const next = await window.pixelsky!.projectTools.tasks(projectId)
        if (!stopped && n === version) {
          setData(next)
          setLoaded(true)
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message)
      }
    }
    void load()
    // 只是服务多了几行输出时不重取（docs/perf-audit-2026-10-18.md B2）
    const off = window.pixelsky.projectTools.onChange(kind => kind === 'state' && void load())
    return () => {
      stopped = true
      off()
    }
  }, [projectId, demo])
  const plans = useMemo(() => {
    const result = data.plans.filter(
      plan => demo || sessions.some(session => session.record.id === plan.sessionId && !session.record.archivedAt),
    )
    for (const session of sessions.filter(s => s.record.projectId === projectId && !s.record.archivedAt)) {
      const item = digests[session.record.id]?.todo
      if (!item) continue
      const next = { sessionId: session.record.id, title: session.record.title, item },
        idx = result.findIndex(p => p.sessionId === next.sessionId)
      if (idx >= 0) result[idx] = next
      else result.push(next)
    }
    return result
  }, [data.plans, digests, sessions, projectId])
  const matches = (title: string, status: string) =>
    (filter === 'all' || filter === status) && title.toLowerCase().includes(query.toLowerCase())
  const tasks = data.tasks.filter(t => matches([t.title, t.note, ...t.tags].join(' '), t.status))
  const visiblePlans =
    source === 'mine'
      ? []
      : plans
          .map(p => ({ ...p, steps: p.item.steps.filter(s => matches(s.text, s.status)) }))
          .filter(p => p.steps.length)
  const total = data.tasks.length + plans.reduce((sum, p) => sum + p.item.steps.length, 0)
  const done =
    data.tasks.filter(t => t.status === 'completed').length +
    plans.reduce((sum, p) => sum + p.item.steps.filter(s => s.status === 'completed').length, 0)
  const reload = async () => {
    if (!demo) {
      setData(await window.pixelsky!.projectTools.tasks(projectId))
      setLoaded(true)
    }
  }
  const save = () =>
    run(async () => {
      if (demo)
        setData(d => ({
          ...d,
          tasks: editing
            ? d.tasks.map(t => (t.id === editing ? { ...t, ...changedTaskFields(origin.current, form) } : t))
            : [
                ...d.tasks,
                {
                  ...form,
                  id: crypto.randomUUID(),
                  projectId,
                  order: d.tasks.length,
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                },
              ],
        }))
      else {
        if (editing) await window.pixelsky!.projectTools.updateTask(editing, changedTaskFields(origin.current, form))
        else await window.pixelsky!.projectTools.createTask(projectId, { ...form, tags: form.tags.filter(Boolean) })
        await reload()
      }
      setShowForm(false)
      setEditing(null)
      setForm(blank)
    })
  const update = (task: ManualTask, remove = false) =>
    run(async () => {
      const status = task.status === 'completed' ? 'pending' : 'completed'
      if (demo)
        setData(d => ({
          ...d,
          tasks: remove
            ? d.tasks.filter(t => t.id !== task.id)
            : d.tasks.map(t => (t.id === task.id ? { ...t, status } : t)),
        }))
      else {
        if (remove) await window.pixelsky!.projectTools.deleteTask(task.id)
        else await window.pixelsky!.projectTools.updateTask(task.id, { status })
        await reload()
      }
    })
  const move = (id: string, target: string) =>
    run(async () => {
      const ordered = [...data.tasks],
        from = ordered.findIndex(t => t.id === id),
        to = ordered.findIndex(t => t.id === target)
      if (from < 0 || to < 0 || from === to) return
      ordered.splice(to, 0, ordered.splice(from, 1)[0])
      if (demo) setData(d => ({ ...d, tasks: ordered }))
      else {
        await window.pixelsky!.projectTools.reorderTasks(
          projectId,
          ordered.map(t => t.id),
        )
        await reload()
      }
    })
  return (
    <div data-tools-tasks className="flex shrink-0 flex-col gap-3 p-3">
      <ToolsHeader
        title={tr('projectTools.tasksTitle')}
        subtitle={name + ' · ' + tr('projectTools.taskCount', { p0: done, p1: total })}
        busy={busy}
        refresh={() => void run(reload)}
      />
      <ToolError error={error} />
      <div className="flex flex-wrap gap-2">
        <Select
          label={tr('projectTools.tasksTitle')}
          value={filter}
          options={['all', 'pending', 'in_progress', 'completed'].map(id => ({
            value: id,
            label: id === 'all' ? tr('projectTools.all') : tr(statusKey[id as keyof typeof statusKey]),
          }))}
          onChange={setFilter}
        />
        <Select
          label={tr('projectTools.aiPlan')}
          value={source}
          options={[
            { value: 'all', label: tr('projectTools.all') },
            { value: 'ai', label: tr('projectTools.aiPlan') },
            { value: 'mine', label: tr('projectTools.myTasks') },
          ]}
          onChange={setSource}
        />
        <Button onClick={() => openForm(null, blank)}>{tr('projectTools.addTask')}</Button>
      </div>
      <input
        aria-label={tr('projectTools.searchTasks')}
        placeholder={tr('projectTools.searchTasks')}
        value={query}
        onChange={e => setQuery(e.target.value)}
        className={FIELD + ' shrink-0'}
      />
      {showForm && (
        <form
          className={CARD + ' flex flex-col gap-2'}
          onSubmit={e => {
            e.preventDefault()
            void save()
          }}
        >
          <Field label={tr('projectTools.taskTitle')}>
            <input
              autoFocus
              maxLength={200}
              required
              value={form.title}
              onChange={e => setForm({ ...form, title: e.target.value })}
              className={FIELD}
            />
          </Field>
          <Field label={tr('projectTools.note')}>
            <textarea
              maxLength={4000}
              value={form.note}
              onChange={e => setForm({ ...form, note: e.target.value })}
              className={FIELD + ' h-20 py-2'}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Select
              label={tr('projectTools.pending')}
              value={form.status}
              options={Object.entries(statusKey).map(([value, key]) => ({ value, label: tr(key) }))}
              onChange={status => setForm({ ...form, status: status as ManualTask['status'] })}
            />
            <Select
              label={tr('projectTools.priority.normal')}
              value={form.priority}
              options={(['low', 'normal', 'high'] as const).map(value => ({
                value,
                label: tr(('projectTools.priority.' + value) as 'projectTools.priority.low'),
              }))}
              onChange={priority => setForm({ ...form, priority: priority as ManualTask['priority'] })}
            />
          </div>
          <Field label={tr('projectTools.due')}>
            <input
              type="date"
              value={form.due}
              onChange={e => setForm({ ...form, due: e.target.value })}
              className={FIELD}
            />
          </Field>
          <Field label={tr('projectTools.tags')}>
            <ListInput value={form.tags} onChange={tags => setForm({ ...form, tags })} className={FIELD} />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={busy || !form.title.trim()}>
              {tr('projectTools.save')}
            </Button>
            <Button onClick={() => setShowForm(false)} disabled={busy}>
              {tr('projectTools.cancel')}
            </Button>
          </div>
        </form>
      )}
      {visiblePlans.map(plan => (
        <section key={plan.sessionId} className={CARD}>
          <button
            onClick={() => {
              if (!demo)
                window.dispatchEvent(
                  new CustomEvent(OPEN_SESSION_EVENT, { detail: { sessionId: plan.sessionId, itemId: plan.item.id } }),
                )
            }}
            className="flex w-full items-center gap-2 text-left text-list text-fg"
          >
            <ListChecks size={16} />
            <span className="min-w-0 flex-1 truncate">{plan.title}</span>
            <span className="text-meta text-fg-muted">{tr('projectTools.aiReadOnly')}</span>
          </button>
          {['failed', 'declined', 'interrupted'].includes(plan.item.status) && (
            <p className="mt-1 text-meta text-warn">{tr('projectTools.taskFailed')}</p>
          )}
          <ul className="mt-2 flex flex-col gap-1">
            {plan.steps.map((step, i) => (
              <li key={i} className="flex items-start gap-2 text-list">
                <span className={step.status === 'completed' ? 'text-success' : 'text-fg-muted'}>
                  {step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '●' : '○'}
                </span>
                <span className="min-w-0 flex-1 break-words text-fg-secondary">{step.text}</span>
                <IconButton
                  icon={Copy}
                  label={tr('projectTools.copyToTask')}
                  onClick={() => openForm(null, { ...blank, title: step.text })}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
      {source !== 'ai' &&
        tasks.map(task => (
          <article
            tabIndex={-1}
            data-tool-task={task.id}
            draggable={!busy}
            onDragStart={e => {
              // 拖到清单里另一张卡片上是排序，拖到左侧栏是固定
              e.dataTransfer.setData(TASK_DRAG_TYPE, task.id)
              e.dataTransfer.effectAllowed = 'copyMove'
              startTaskDrag(task)
            }}
            onDragEnd={() => startTaskDrag(null)}
            onDragOver={e => {
              if (filter === 'all' && !query && e.dataTransfer.types.includes(TASK_DRAG_TYPE)) e.preventDefault()
            }}
            onDrop={e => {
              e.preventDefault()
              if (filter === 'all' && !query) void move(e.dataTransfer.getData(TASK_DRAG_TYPE), task.id)
            }}
            key={task.id}
            className={CARD + ' flex items-start gap-2 outline-none focus:ring-1 focus:ring-accent'}
          >
            <IconButton
              disabled={busy}
              icon={task.status === 'completed' ? Check : Circle}
              label={tr(statusKey[task.status])}
              onClick={() => void update(task)}
            />
            <div className="min-w-0 flex-1">
              <p
                className={
                  'break-words text-list ' + (task.status === 'completed' ? 'text-fg-muted line-through' : 'text-fg')
                }
              >
                {task.title}
              </p>
              {task.note && <p className="mt-1 whitespace-pre-wrap break-words text-meta text-fg-muted">{task.note}</p>}
              <p className="mt-1 text-meta text-fg-faint">
                {tr(statusKey[task.status])} ·{' '}
                {tr(('projectTools.priority.' + task.priority) as 'projectTools.priority.low')}
                {task.due && ' · ' + task.due}
                {task.tags.length > 0 && ' · ' + task.tags.join(', ')}
              </p>
            </div>
            <div className="flex max-w-32 flex-wrap justify-end">
              <IconButton
                icon={pinnedNow(task) ? PinOff : Pin}
                label={tr(pinnedNow(task) ? 'projectTools.unpinFromSidebar' : 'projectTools.pinToSidebar')}
                active={pinnedNow(task)}
                disabled={busy}
                onClick={() => void run(() => pinTask(task, !pinnedNow(task)))}
              />
              <IconButton
                icon={ArrowUp}
                label={tr('projectTools.moveUp')}
                disabled={busy || data.tasks[0]?.id === task.id}
                onClick={() => void move(task.id, data.tasks[data.tasks.indexOf(task) - 1]?.id)}
              />
              <IconButton
                icon={ArrowDown}
                label={tr('projectTools.moveDown')}
                disabled={busy || data.tasks.at(-1)?.id === task.id}
                onClick={() => void move(task.id, data.tasks[data.tasks.indexOf(task) + 1]?.id)}
              />
              <IconButton
                icon={Pencil}
                label={tr('projectTools.edit')}
                disabled={busy}
                onClick={() => openForm(task.id, task)}
              />
              <IconButton
                icon={Trash2}
                label={tr('projectTools.deleteTask')}
                disabled={busy}
                onClick={() => void update(task, true)}
              />
            </div>
          </article>
        ))}
      {!visiblePlans.length && (source === 'ai' || !tasks.length) && (
        <p className="py-8 text-center text-list text-fg-muted">
          {loaded ? tr('projectTools.noTasks') : tr('projectTools.loading')}
        </p>
      )}
      {pendingOpen && (
        <ConfirmDialog
          title={tr('customApi.discardTitle')}
          description={tr('ui.ConfirmDialog.unsaved')}
          confirmLabel={tr('ui.ConfirmDialog.discard')}
          cancelLabel={tr('ui.ConfirmDialog.keepEditing')}
          busy={false}
          danger
          onConfirm={() => {
            pendingOpen()
            setPendingOpen(null)
          }}
          onCancel={() => setPendingOpen(null)}
        />
      )}
    </div>
  )
}
