// 定时任务（docs/ui/board-schedule.md）：看板「定时」列的卡片和空状态、运行历史弹窗、编辑框里的「定时运行」设置
import type { ReactNode } from 'react'
import { Check, CircleDashed, Clock, CornerUpRight, Pause, Play, Pencil, TriangleAlert, X } from 'lucide-react'
import { Button, Segmented, Select, Spinner, Switch, cn } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { tr, translateMessage } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { useEngineState } from '@/features/engine'
import { useEngineCatalog } from '@/features/engine/catalog'
import { FIELD } from '@/features/panel/ToolsUi'
import { nextSlot } from '../../../../shared/schedule'
import type {
  IssueAssignee,
  ManualTask,
  ScheduleFreq,
  ScheduleRun,
  TaskSchedule,
} from '../../../../shared/types/project-tools'
import type { Channel, FlowSchedule } from '../../../../shared/types/channels'
import { moveFocus } from './BoardCards'
import { assigneeKey, type AssigneeChoice } from './issues'
import { defaultSchedule, parseTime, scheduleDefaultEngine, scheduleEngines, timeText } from './scheduleModel'

const CARD =
  'group relative flex w-full flex-col gap-1 rounded-lg border border-line-card bg-surface px-3 py-2.5 text-left shadow-sm outline-none transition-colors hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent'

const FREQS: ScheduleFreq[] = ['hourly', 'daily', 'weekdays', 'weekly']
const DAYS = [0, 1, 2, 3, 4, 5, 6] as const
const DAY_KEYS = [
  'board.schedule.day.0',
  'board.schedule.day.1',
  'board.schedule.day.2',
  'board.schedule.day.3',
  'board.schedule.day.4',
  'board.schedule.day.5',
  'board.schedule.day.6',
] as const
const dayName = (d: number) => tr(DAY_KEYS[d] ?? DAY_KEYS[0])

/** 「每天 09:00」「每周一 10:00」 */
export function freqText(s: TaskSchedule): string {
  if (s.freq === 'hourly') return tr('board.schedule.at.hourly', { minute: String(s.minute).padStart(2, '0') })
  const time = timeText(s)
  return s.freq === 'weekly'
    ? tr('board.schedule.at.weekly', { day: dayName(s.weekday), time })
    : tr(s.freq === 'daily' ? 'board.schedule.at.daily' : 'board.schedule.at.weekdays', { time })
}

/** 今天 09:00 / 昨天 09:00 / 明天 09:00 / 10-23 09:00 */
export function dayTime(ts: number, now: number): string {
  const d = new Date(ts),
    today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const days = Math.round((new Date(ts).setHours(0, 0, 0, 0) - today.getTime()) / 86_400_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const day =
    days === 0
      ? tr('board.schedule.today')
      : days === -1
        ? tr('board.schedule.yesterday')
        : days === 1
          ? tr('board.schedule.tomorrow')
          : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return `${day} ${time}`
}

export function durationText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return tr('board.schedule.duration.lt1')
  if (minutes < 60) return tr('board.schedule.duration.m', { n: minutes })
  return tr('board.schedule.duration.h', { h: Math.floor(minutes / 60), m: minutes % 60 })
}

function RunIcon({ status }: { status: ScheduleRun['status'] }) {
  if (status === 'running') return <Spinner size={12} />
  const Icon = { done: Check, failed: X, missed: CircleDashed, skipped: CornerUpRight }[status]
  const tone = { done: 'text-success', failed: 'text-danger', missed: 'text-fg-faint', skipped: 'text-fg-faint' }[
    status
  ]
  return <Icon size={13} strokeWidth={1.75} className={cn('shrink-0', tone)} aria-hidden />
}

/** 引擎、模型、交给谁、每次怎么跑的一句话 */
function summaryText(task: ManualTask, engineName: string): string {
  const s = task.schedule!
  const to = task.assignee
    ? tr('board.schedule.summary.member', { name: task.assignee.name })
    : tr('board.schedule.summary.engine', { engine: s.model ? `${engineName} · ${s.model}` : engineName })
  return [to, tr(s.session === 'resume' ? 'board.schedule.summary.resume' : 'board.schedule.summary.new')].join(' · ')
}

/** 「定时」列里的卡片：开关 + 频率 + 最近一次的结果；不能拖、不能勾完成 */
export function ScheduleCard({
  task,
  project,
  now,
  busy,
  onOpen,
  onToggle,
}: {
  task: ManualTask
  project: string
  now: number
  busy: boolean
  onOpen: () => void
  onToggle: (enabled: boolean) => void
}) {
  const s = task.schedule!
  const last = s.runs[0]
  const note = last?.status === 'failed' && last.note ? ` ${translateMessage(last.note)}` : ''
  return (
    <div
      role="button"
      tabIndex={0}
      data-board-card
      data-board-schedule={task.id}
      data-column="schedule"
      aria-label={task.title}
      onClick={onOpen}
      onKeyDown={e => {
        if (moveFocus(e)) return
        if (e.key === 'Enter') {
          e.preventDefault()
          onOpen()
        }
      }}
      className={cn(CARD, 'cursor-pointer', !s.enabled && 'opacity-70')}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} className="mt-0.5 shrink-0">
          <Switch
            size="sm"
            checked={s.enabled}
            disabled={busy}
            label={tr('board.schedule.toggle', { title: task.title })}
            onChange={onToggle}
          />
        </span>
        <span className="line-clamp-2 min-w-0 flex-1 break-words text-list text-fg">{task.title}</span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-meta text-fg-faint">
        <span className="shrink-0 font-medium text-fg-secondary">{freqText(s)}</span>
        {project && <span className="min-w-0 truncate">· {project}</span>}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-meta text-fg-muted">
        {last ? <RunIcon status={last.status} /> : null}
        <span className="min-w-0 truncate">
          {last?.status === 'running'
            ? tr('board.schedule.runningFor', { duration: durationText(now - last.at) })
            : [
                last ? `${dayTime(last.at, now)}${note}` : tr('board.schedule.neverRun'),
                s.enabled
                  ? tr('board.schedule.next', { time: dayTime(nextSlot(s, now), now) })
                  : tr('board.schedule.paused'),
              ].join(' · ')}
        </span>
      </div>
    </div>
  )
}

/** 频道里每天定时运行的流程（只读，点开跳到频道） */
export function FlowScheduleCard({
  channel,
  flow,
  onOpen,
}: {
  channel: Pick<Channel, 'id' | 'name'>
  flow: FlowSchedule
  onOpen: () => void
}) {
  const time = `${String(flow.hour).padStart(2, '0')}:00`
  return (
    <button
      type="button"
      data-board-card
      data-column="schedule"
      onClick={onOpen}
      className={cn(CARD, 'cursor-pointer')}
    >
      <span className="flex min-w-0 items-center gap-2 text-list text-fg">
        <Clock size={13} className="shrink-0 text-fg-muted" aria-hidden />
        <span className="line-clamp-2 min-w-0 flex-1 break-words">{flow.title}</span>
      </span>
      <span className="truncate text-meta text-fg-faint">
        {tr('board.schedule.flowTitle', { channel: channel.name })} ·{' '}
        {flow.enabled ? tr('board.schedule.flowDaily', { time }) : tr('board.schedule.flowOff')}
      </span>
      {flow.lastError && <span className="truncate text-meta text-danger">{flow.lastError}</span>}
    </button>
  )
}

/** 还没有定时任务：三个模板 + 自己写一个 */
export function ScheduleEmpty({ onTemplate }: { onTemplate: (id: string) => void }) {
  useI18n()
  const templates = ['deps', 'tests', 'git'] as const
  return (
    <div className="flex flex-col gap-2">
      <p className="px-1 text-meta text-fg-muted">
        {tr('board.schedule.emptyTitle')}
        <br />
        {tr('board.schedule.emptyFrom')}
      </p>
      {templates.map(id => (
        <button
          key={id}
          type="button"
          onClick={() => onTemplate(id)}
          className="press flex flex-col gap-0.5 rounded-lg border border-dashed border-line-strong bg-surface/60 px-3 py-2.5 text-left hover:border-accent-line hover:bg-surface"
        >
          <span className="text-list text-fg">{tr(`board.schedule.tpl.${id}.title`)}</span>
          <span className="text-meta text-fg-faint">{tr(`board.schedule.tpl.${id}.sub`)}</span>
          <span className="text-meta text-accent-fg">{tr('board.schedule.useTemplate')}</span>
        </button>
      ))}
    </div>
  )
}

/** 点定时卡：运行历史 + 立即运行 / 暂停 / 编辑；每次运行一行，点「打开」回到那次的会话 */
export function ScheduleHistoryDialog({
  task,
  project,
  engineName,
  now,
  busy,
  error,
  onRun,
  onToggle,
  onEdit,
  onOpenRun,
  onClose,
}: {
  task: ManualTask
  project: string
  engineName: string
  now: number
  busy: boolean
  error: string | null
  onRun: () => void
  onToggle: () => void
  onEdit: () => void
  onOpenRun: (run: ScheduleRun) => void
  onClose: () => void
}) {
  const s = task.schedule!
  const running = s.runs.some(r => r.status === 'running')
  return (
    <ConfirmDialog
      title={task.title}
      busy={busy}
      error={error}
      confirmLabel={tr('board.schedule.runNow')}
      cancelLabel={tr('board.schedule.close')}
      confirmDisabled={running}
      onConfirm={onRun}
      onCancel={onClose}
      description={
        <div className="mt-2 flex flex-col gap-3 text-left">
          <p className="text-meta text-fg-muted">
            {[freqText(s), project, summaryText(task, engineName)].filter(Boolean).join(' · ')}
          </p>
          <div className="flex gap-2">
            <Button className="h-8" disabled={busy} icon={s.enabled ? Pause : Play} onClick={onToggle}>
              {tr(s.enabled ? 'board.schedule.pause' : 'board.schedule.resume')}
            </Button>
            <Button variant="ghost" className="h-8" icon={Pencil} onClick={onEdit}>
              {tr('board.schedule.edit')}
            </Button>
          </div>
          <div className="text-meta font-medium text-fg-muted">
            {s.runs.length ? tr('board.schedule.recent', { n: s.runs.length }) : tr('board.schedule.noRuns')}
          </div>
          <ul className="flex max-h-72 flex-col overflow-y-auto [scrollbar-width:thin]">
            {s.runs.map(run => (
              <RunRow key={`${run.at}-${run.trigger}`} run={run} now={now} onOpen={() => onOpenRun(run)} />
            ))}
          </ul>
        </div>
      }
    />
  )
}

function RunRow({ run, now, onOpen }: { run: ScheduleRun; now: number; onOpen: () => void }) {
  const openable = !!run.sessionId || !!run.card
  const detail =
    run.status === 'done' || run.status === 'failed'
      ? [
          run.endedAt ? durationText(run.endedAt - run.at) : '',
          run.note ? (run.status === 'failed' ? translateMessage(run.note) : run.note) : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : tr(`board.schedule.status.${run.status}`)
  return (
    <li className="flex items-start gap-2 border-t border-line py-2 first:border-t-0">
      <span className="mt-0.5 flex size-4 items-center justify-center">
        <RunIcon status={run.status} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-list text-fg">
          {dayTime(run.at, now)}
          {run.trigger === 'manual' && <span className="text-fg-faint"> · {tr('board.schedule.manual')}</span>}
        </span>
        <span className="line-clamp-2 break-words text-meta text-fg-muted">{detail}</span>
      </span>
      {openable ? (
        <button
          type="button"
          onClick={onOpen}
          className="press rounded-md px-1.5 py-0.5 text-meta text-accent-fg hover:bg-hover"
        >
          {tr('board.schedule.open')}
        </button>
      ) : (
        <span className="px-1.5 py-0.5 text-meta text-fg-faint">—</span>
      )}
    </li>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_1fr] items-start gap-2 text-meta">
      <span className="pt-2 text-fg-muted">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

/** 编辑框里的「定时运行」：打开后这条任务变成定时卡，关掉变回普通待办；备注就是发给 AI 的话 */
export function ScheduleFields({
  schedule,
  assignee,
  choices,
  onChange,
  onAssignee,
}: {
  schedule: TaskSchedule | null
  assignee: IssueAssignee | null
  choices: readonly AssigneeChoice[]
  onChange: (next: TaskSchedule | null) => void
  onAssignee: (a: IssueAssignee | null) => void
}) {
  useI18n()
  const all = useEngineState(s => s.engines)
  const engines = scheduleEngines(all)
  const engine = schedule?.engine ?? 'claude'
  const catalog = useEngineCatalog(engine)
  const patch = (p: Partial<TaskSchedule>) => schedule && onChange({ ...schedule, ...p })
  const current = assignee ? assigneeKey(assignee) : ''
  const targets = [
    { value: '', label: tr('board.schedule.toEngine') },
    ...choices.map(c => ({
      value: c.key,
      label: tr('board.issue.memberIn', { member: c.assignee.name, channel: c.channel }),
    })),
    ...(assignee && !choices.some(c => c.key === current) ? [{ value: current, label: assignee.name }] : []),
  ]
  const engineOptions = (engines.length ? engines : [{ id: 'claude' as const, name: 'Claude Code' }]).map(e => ({
    value: e.id,
    label: e.name,
  }))
  const models = [
    { value: '', label: tr('board.schedule.modelDefault') },
    ...(catalog?.models ?? []).map(m => ({ value: m.id, label: m.label })),
    ...(schedule?.model && !catalog?.models?.some(m => m.id === schedule.model)
      ? [{ value: schedule.model, label: schedule.model }]
      : []),
  ]
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-subtle/40 p-3">
      <div className="flex items-center gap-2 text-ui font-medium text-fg">
        <Clock size={14} className="text-accent-fg" aria-hidden />
        <span className="flex-1">{tr('board.schedule.section')}</span>
        <Switch
          size="sm"
          checked={!!schedule}
          label={tr('board.schedule.section')}
          onChange={on => onChange(on ? defaultSchedule(scheduleDefaultEngine(all)) : null)}
        />
      </div>
      {schedule && (
        <>
          <Row label={tr('board.schedule.freq')}>
            <Segmented<ScheduleFreq>
              label={tr('board.schedule.freq')}
              value={schedule.freq}
              onChange={freq => patch({ freq })}
              options={FREQS.map(f => ({ value: f, label: tr(`board.schedule.freq.${f}`) }))}
            />
            {schedule.freq === 'weekly' && (
              <Select<string>
                className="w-24!"
                label={tr('board.schedule.weekday')}
                value={String(schedule.weekday)}
                options={DAYS.map(d => ({ value: String(d), label: dayName(d) }))}
                onChange={d => patch({ weekday: Number(d) })}
              />
            )}
            {schedule.freq === 'hourly' ? (
              <>
                <input
                  type="number"
                  min={0}
                  max={59}
                  aria-label={tr('board.schedule.minute')}
                  title={tr('board.schedule.minute')}
                  value={schedule.minute}
                  onChange={e => patch({ minute: Math.min(59, Math.max(0, Math.trunc(Number(e.target.value) || 0))) })}
                  className={cn(FIELD, 'w-20!')}
                />
                <span className="text-meta text-fg-faint">{tr('board.schedule.minute')}</span>
              </>
            ) : (
              <input
                type="time"
                aria-label={tr('board.schedule.time')}
                value={timeText(schedule)}
                onChange={e => {
                  const t = parseTime(e.target.value)
                  if (t) patch(t)
                }}
                className={cn(FIELD, 'w-28!')}
              />
            )}
          </Row>
          <Row label={tr('board.schedule.to')}>
            <Select<string>
              label={tr('board.schedule.to')}
              className={assignee ? undefined : 'w-32!'}
              value={current}
              options={targets}
              onChange={key => onAssignee(key ? (choices.find(c => c.key === key)?.assignee ?? assignee) : null)}
            />
            {!assignee && (
              <>
                <Select
                  label={tr('board.schedule.engine')}
                  className="w-36!"
                  value={engine}
                  options={engineOptions}
                  onChange={e => patch({ engine: e, model: null })}
                />
                <Select<string>
                  label={tr('board.schedule.model')}
                  className="w-28!"
                  value={schedule.model ?? ''}
                  options={models}
                  onChange={model => patch({ model: model || null })}
                />
              </>
            )}
          </Row>
          {assignee ? (
            <p className="pl-[5rem] text-meta text-fg-faint">{tr('board.schedule.memberOnly')}</p>
          ) : (
            <>
              <Row label={tr('board.schedule.each')}>
                <Segmented<TaskSchedule['session']>
                  label={tr('board.schedule.each')}
                  value={schedule.session}
                  onChange={session => patch({ session })}
                  options={[
                    { value: 'new', label: tr('board.schedule.each.new') },
                    { value: 'resume', label: tr('board.schedule.each.resume') },
                  ]}
                />
              </Row>
              <Row label={tr('board.schedule.permission')}>
                <Select<TaskSchedule['permission']>
                  label={tr('board.schedule.permission')}
                  value={schedule.permission}
                  options={(['plan', 'ask', 'edits'] as const).map(p => ({
                    value: p,
                    label: tr(`board.schedule.permission.${p}`),
                  }))}
                  onChange={permission => patch({ permission })}
                />
                {schedule.permission === 'edits' && (
                  <span className="flex items-center gap-1 text-meta text-warn">
                    <TriangleAlert size={13} aria-hidden />
                    {tr('board.schedule.permissionWarn')}
                  </span>
                )}
              </Row>
            </>
          )}
          <p className="flex items-start gap-1.5 text-meta text-fg-faint">{tr('board.schedule.hint')}</p>
        </>
      )}
    </div>
  )
}
