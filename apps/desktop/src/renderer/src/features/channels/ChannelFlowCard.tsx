import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Plus, Settings2, Workflow, X } from 'lucide-react'
import type { Effort } from '@pixelsky/protocol'
import { Button, cn, IconButton, Popover, Segmented, Select, Spinner, useToast, type SelectOption } from '@/ui'
import { useEngineState } from '@/features/engine'
import { effortLabel } from '@/features/engine/labels'
import type { ChannelMember, ChannelTask, ChannelTextMessage } from '@/data/types'
import type {
  ChannelFlow,
  FlowAction,
  FlowBrief,
  FlowUsage,
  FlowStep,
  FlowStepInput,
  FlowStepKind,
  FlowStepSettings,
} from '../../../../shared/types/channels'
import { MemberAvatar } from './ChannelMessage'
import { PlannerSwitch, plannerSummary, QuestionsForm } from './PlanParts'
import { activityView, taskActivity, taskElapsed } from './taskActivity'
import { ActivityLines } from './ActivityLines'
import { durText } from './format'
import { agentActivity, RECENT_STEPS } from '@/features/session/live/agentActivity'
import { GateActions } from './GateActions'
import { StartDialog } from './StartDialog'
import { formatCardCost, formatTokens, costHint } from '@/features/usage/format'
import { scheduleToInput, type FlowPart } from './model'
import { channelActions, useChannels } from './store'

const NUMBERS = '①②③④⑤⑥⑦⑧⑨'
const num = (i: number): string => NUMBERS[i] ?? String(i + 1)
const AUTOSAVE_MS = 600

type Members = ReadonlyMap<string, ChannelMember>

/** 流程操作：失败（校验不过、状态不对）用 toast 说明 */
export function useFlowRun(channelId: string) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const run = (action: FlowAction): Promise<boolean> => {
    setBusy(true)
    return channelActions
      .flow(channelId, action)
      .then(() => true)
      .catch((e: unknown) => {
        toast(tr('channels.flow.failed', { error: translateMessage((e as Error)?.message ?? String(e)) }))
        return false
      })
      .finally(() => setBusy(false))
  }
  return { run, busy }
}

const toInput = (s: FlowStep | FlowStepInput): FlowStepInput => ({
  id: s.id,
  title: s.title,
  memberId: s.memberId,
  deps: s.deps,
  kind: s.kind,
  ...(s.target ? { target: s.target } : {}),
  ...(s.gate ? { gate: true } : {}),
  ...(s.settings && Object.keys(s.settings).length ? { settings: s.settings } : {}),
})

/** 一步的临时设置（第 20 项）：不写的跟随成员 */
function StepSettings({
  member,
  value,
  onChange,
  gate,
  onGate,
}: {
  member: ChannelMember | undefined
  value: FlowStepSettings
  onChange: (next: FlowStepSettings) => void
  gate: boolean
  onGate: (next: boolean) => void
}) {
  useI18n()
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const engine = member?.kind === 'agent' ? member.engine : null
  const caps = useEngineState(s => s.engines.find(e => e.id === engine)?.caps)
  const follow = tr('channels.flow.follow')
  const toggle = (v: boolean | undefined) => (v === undefined ? '' : v ? 'on' : 'off')
  const toggleOptions: SelectOption<'' | 'on' | 'off'>[] = [
    { value: '', label: follow },
    { value: 'on', label: tr('channels.agent.on') },
    { value: 'off', label: tr('channels.agent.off') },
  ]
  const set = (patch: FlowStepSettings) => {
    const next = { ...value, ...patch }
    for (const k of Object.keys(next) as (keyof FlowStepSettings)[]) if (next[k] === undefined) delete next[k]
    onChange(next)
  }
  const fromToggle = (v: '' | 'on' | 'off') => (v === '' ? undefined : v === 'on')
  const effortOptions: SelectOption<Effort | ''>[] = [
    { value: '', label: follow },
    ...(caps?.efforts ?? []).map(e => ({ value: e, label: effortLabel(e) })),
  ]
  const customized = Object.keys(value).length > 0 || gate
  return (
    <>
      <IconButton
        ref={anchor}
        icon={Settings2}
        iconSize={14}
        label={tr('channels.flow.settings')}
        size={26}
        active={customized}
        onClick={() => setOpen(o => !o)}
      />
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        align="end"
        role="dialog"
        className="w-64 p-3"
      >
        <div className="flex flex-col gap-2.5">
          <label className="flex items-center gap-2 text-ui text-fg">
            <input type="checkbox" checked={gate} onChange={e => onGate(e.target.checked)} />
            {tr('channels.flow.gateToggle')}
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-meta font-medium text-fg-muted">{tr('channels.flow.model')}</span>
            <input
              value={value.model ?? ''}
              onChange={e => set({ model: e.target.value.trim() ? e.target.value : undefined })}
              className="h-8 rounded-md border border-line bg-surface px-2 font-mono text-ui text-fg outline-none focus:border-accent"
            />
          </label>
          {effortOptions.length > 1 && (
            <div className="flex flex-col gap-1">
              <span className="text-meta font-medium text-fg-muted">{tr('channels.agent.effort')}</span>
              <Select
                label={tr('channels.agent.effort')}
                value={value.effort ?? ''}
                options={effortOptions}
                onChange={v => set({ effort: v || undefined })}
              />
            </div>
          )}
          {(caps?.fast ?? true) && (
            <div className="flex flex-col gap-1">
              <span className="text-meta font-medium text-fg-muted">{tr('channels.agent.fast')}</span>
              <Select
                label={tr('channels.agent.fast')}
                value={toggle(value.fast) as '' | 'on' | 'off'}
                options={toggleOptions}
                onChange={v => set({ fast: fromToggle(v) })}
              />
            </div>
          )}
          {(caps?.ultracode ?? true) && (
            <div className="flex flex-col gap-1">
              <span className="text-meta font-medium text-ultracode">{tr('channels.agent.ultracode')}</span>
              <Select
                label={tr('channels.agent.ultracode')}
                value={toggle(value.ultracode) as '' | 'on' | 'off'}
                options={toggleOptions}
                onChange={v => set({ ultracode: fromToggle(v) })}
              />
            </div>
          )}
        </div>
      </Popover>
    </>
  )
}

/** 时长的文字：1 分钟内秒、1 小时内分秒、再长小时 + 分 */
/** 一步的耗时行：「3 分 12 秒 · 2 轮 · 打回 1 次」（§8.2）；没有的部分不显示 */
function stepStats(step: FlowStep, task: ChannelTask | undefined, now: number): string {
  if (!task) return ''
  const start = task.startedAt ?? task.at
  const parts = [
    start ? durText((task.endedAt ?? now) - start) : '',
    task.round ? tr('channels.flow.dur.rounds', { n: task.round }) : '',
    step.rejects > 0 ? tr('channels.flow.dur.rejects', { n: step.rejects }) : '',
  ]
  return parts.filter(Boolean).join(' · ')
}

/** 整条流程的耗时：开始运行到最后一个任务结束（运行中到现在），不把并行的加起来 */
function flowTotal(flow: ChannelFlow, tasks: ChannelTask[], now: number): string {
  // 从最早那一步开始算（since 是护栏的计数起点，继续时会重置）
  const starts = tasks.map(t => t.startedAt ?? t.at)
  const start = starts.length ? Math.min(...starts) : flow.since?.at
  if (!start) return ''
  const ends = tasks.flatMap(t => (t.endedAt ? [t.endedAt] : []))
  const end = flow.status === 'running' ? now : Math.max(0, ...ends)
  if (end <= start) return ''
  const m = Math.round((end - start) / 60_000)
  const time = m < 1 ? durText(end - start) : m < 60 ? tr('channels.flow.dur.min', { m }) : durText(end - start)
  const rounds = tasks.reduce((n, t) => n + (t.round ?? 0), 0)
  return rounds > 0 ? tr('channels.flow.dur.total', { time, rounds }) : time
}

const WHY_KEY = {
  engine: 'engine',
  pending: 'pending',
  platform: 'platform',
  'no-price': 'noPrice',
} as const

/** 一步（或整条流程）的用量文字：token + 费用；没有费用时写最常见的原因 */
function usageText(u: FlowUsage | null | undefined): { text: string; title: string } | null {
  if (!u || u.records <= 0) return null
  const tokens = tr('channels.flow.usage.tokens', {
    n: formatTokens(u.input + u.cacheRead + u.cacheWrite + u.output),
  })
  let cost = formatCardCost(u)
  let title = ''
  if (u.costKnown === 0) {
    const top = (Object.entries(u.why) as [keyof typeof WHY_KEY, number][])
      .filter(([k]) => k in WHY_KEY)
      .sort((a, b) => b[1] - a[1])[0]?.[0]
    if (top) {
      cost += ' ' + tr(`channels.flow.usage.reason.${WHY_KEY[top]}`)
      title = costHint(top)
    }
  }
  return { text: `${u.unrecorded > 0 ? '≥ ' : ''}${tokens} · ${cost}`, title }
}

function sumUsage(list: readonly FlowUsage[]): FlowUsage {
  const t: FlowUsage = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    costUsd: 0,
    costKnown: 0,
    costActual: 0,
    records: 0,
    turns: 0,
    unrecorded: 0,
    why: {},
  }
  for (const u of list) {
    t.input += u.input
    t.cacheRead += u.cacheRead
    t.cacheWrite += u.cacheWrite
    t.output += u.output
    t.costUsd += u.costUsd
    t.costKnown += u.costKnown
    t.costActual = (t.costActual ?? 0) + (u.costActual ?? 0)
    t.records += u.records
    t.turns += u.turns
    t.unrecorded += u.unrecorded
    for (const [k, n] of Object.entries(u.why) as [keyof FlowUsage['why'], number][]) t.why[k] = (t.why[k] ?? 0) + n
  }
  return t
}

/** 花费上限输入框里的数：正数才算，其余 = 不限 */
const costNum = (v: string): number | null => (Number(v) > 0 && Number.isFinite(Number(v)) ? Number(v) : null)

const newStepId = (steps: readonly FlowStepInput[]): string => {
  let id: string
  do id = 's' + crypto.randomUUID().slice(0, 4)
  while (steps.some(s => s.id === id))
  return id
}

function LimitInput({
  label,
  value,
  disabled,
  decimal,
  onChange,
}: {
  label: string
  value: string
  disabled: boolean
  decimal?: boolean
  onChange: (v: string) => void
}) {
  return (
    <input
      inputMode={decimal ? 'decimal' : 'numeric'}
      aria-label={label}
      placeholder={tr('channels.flow.limitsNone')}
      value={value}
      disabled={disabled}
      // 小数只留第一个点：「1.2.3」不会悄悄变成不限
      onChange={e =>
        onChange(
          decimal
            ? e.target.value.replace(/[^\d.]/g, '').replace(/^(\d*\.\d*).*$/, '$1')
            : e.target.value.replace(/\D/g, ''),
        )
      }
      className={cn(
        'h-6 rounded-md border border-line bg-surface px-1.5 text-center text-meta text-fg outline-none focus:border-accent',
        decimal ? 'w-16' : 'w-14',
      )}
    />
  )
}

/** 草稿上的「每天定时运行…」（§10.3）：三项护栏都必须填；存成频道的定时，和这份草稿无关 */
function ScheduleButton({
  channelId,
  title,
  steps,
  isolate,
}: {
  channelId: string
  title: string
  steps: readonly FlowStepInput[]
  isolate: boolean
}) {
  useI18n()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hour, setHour] = useState('9')
  const [rounds, setRounds] = useState('')
  const [minutes, setMinutes] = useState('')
  const [cost, setCost] = useState('')
  const anchor = useRef<HTMLSpanElement>(null)
  const hours: SelectOption<string>[] = Array.from({ length: 24 }, (_, h) => ({
    value: String(h),
    label: tr('channels.flow.schedule.hourOpt', { h }),
  }))
  const existing = useChannels(s => s.channels.find(c => c.id === channelId)?.schedules)
  const r = Number(rounds)
  const m = Number(minutes)
  const c = costNum(cost)
  const ready = r > 0 && m > 0 && c !== null && steps.length > 0
  const toggle = () => {
    if (!open) {
      setRounds(String(Math.max(12, steps.length * 4)))
      setMinutes('120')
      setCost('')
    }
    setOpen(!open)
  }
  const save = () => {
    if (!ready || busy) return
    setBusy(true)
    channelActions
      .updateChannel(channelId, {
        schedules: [
          ...(existing ?? []).map(scheduleToInput),
          {
            title: title.trim() || steps[0].title,
            hour: Number(hour),
            steps: steps.map(toInput),
            limits: { rounds: r, minutes: m, costUsd: c },
            enabled: true,
            isolate,
          },
        ],
      })
      .then(() => {
        toast(tr('channels.flow.schedule.saved', { h: hour }))
        setOpen(false)
      })
      .catch((e: unknown) =>
        toast(tr('channels.flow.schedule.failed', { error: translateMessage((e as Error)?.message ?? String(e)) })),
      )
      .finally(() => setBusy(false))
  }
  const field = (label: string, value: string, set: (v: string) => void, decimal?: boolean) => (
    <label className="flex items-center justify-between gap-2 text-meta text-fg-muted">
      {label}
      <LimitInput label={label} value={value} disabled={false} decimal={decimal} onChange={set} />
    </label>
  )
  return (
    <>
      <span ref={anchor} className="inline-flex shrink-0">
        <Button className="h-7 px-2.5 text-meta" disabled={steps.length === 0} onClick={toggle}>
          {tr('channels.flow.schedule.add')}
        </Button>
      </span>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        align="end"
        role="dialog"
        className="w-64 p-3"
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 text-meta text-fg-muted">
            {tr('channels.flow.schedule.hour')}
            <div className="w-24">
              <Select label={tr('channels.flow.schedule.hour')} value={hour} options={hours} onChange={setHour} />
            </div>
          </div>
          {field(tr('channels.flow.schedule.rounds'), rounds, setRounds)}
          {field(tr('channels.flow.schedule.minutes'), minutes, setMinutes)}
          {field(tr('channels.flow.schedule.cost'), cost, setCost, true)}
          <Button variant="primary" className="self-end" disabled={!ready || busy} onClick={save}>
            {tr('channels.flow.schedule.save')}
          </Button>
        </div>
      </Popover>
    </>
  )
}

/** 设了花费上限时的提醒：哪些成员的费用算不进上限（引擎能力看 caps.costUsd，平台额度对账晚几分钟） */
function CostWarning({ steps, membersById }: { steps: readonly FlowStepInput[]; membersById: Members }) {
  useI18n()
  const engines = useEngineState(s => s.engines)
  const agents = [...new Set(steps.map(s => membersById.get(s.memberId)))].flatMap(m =>
    m?.kind === 'agent' ? [m] : [],
  )
  if (agents.length === 0) return null
  const canCost = (engine: string) => engines.find(e => e.id === engine)?.caps?.costUsd ?? true
  const noCost = agents.filter(m => !canCost(m.engine))
  const platform = agents.filter(m => canCost(m.engine) && m.config?.settings.platform)
  const names = (list: typeof agents) => list.map(m => m.name).join(', ')
  const text =
    noCost.length === agents.length
      ? tr('channels.flow.costWarn.none')
      : [
          noCost.length ? tr('channels.flow.costWarn.codex', { names: names(noCost) }) : '',
          platform.length ? tr('channels.flow.costWarn.platform', { names: names(platform) }) : '',
        ]
          .filter(Boolean)
          .join(' · ')
  return text ? <p className="mt-1 text-meta text-warn">{text}</p> : null
}

/** 草稿：一行一步，改完自动保存；开始运行前先存一次 */
function DraftEditor({
  message,
  flow,
  agents,
  membersById,
  readOnly,
}: {
  message: ChannelTextMessage
  flow: ChannelFlow
  agents: readonly ChannelMember[]
  membersById: Members
  readOnly: boolean
}) {
  useI18n()
  const { run, busy } = useFlowRun(message.channelId)
  const [title, setTitle] = useState(flow.title)
  const [steps, setSteps] = useState<FlowStepInput[]>(() => flow.steps.map(toInput))
  // 旧流程没有护栏 = 不限；草稿里预填默认值（和主进程开始运行时补的一致）
  const [rounds, setRounds] = useState(() =>
    String(flow.limits ? (flow.limits.rounds ?? '') : Math.max(12, flow.steps.length * 4)),
  )
  const [minutes, setMinutes] = useState(() => String(flow.limits ? (flow.limits.minutes ?? '') : 120))
  const [cost, setCost] = useState(() => String(flow.limits?.costUsd ?? ''))
  const [isolate, setIsolate] = useState(flow.isolate !== false)
  const local = useChannels(s => s.channels.find(c => c.id === message.channelId)?.scope === 'local')
  const dirty = useRef(false)
  const edit = (change: (list: FlowStepInput[]) => FlowStepInput[]) => {
    dirty.current = true
    setSteps(change)
  }
  const patchStep = (id: string, patch: Partial<FlowStepInput>) =>
    edit(list => list.map(s => (s.id === id ? { ...s, ...patch } : s)))
  // 标题清空时先不存标题（主进程会拒绝整次更新），步骤照存
  const action = (): Extract<FlowAction, { type: 'update' }> => ({
    type: 'update',
    messageId: message.id,
    ...(title.trim() ? { title } : {}),
    steps,
    limits: {
      rounds: rounds.trim() ? Number(rounds) : null,
      minutes: minutes.trim() ? Number(minutes) : null,
      costUsd: costNum(cost),
    },
    isolate,
  })

  const editLimit = (set: (v: string) => void, v: string) => {
    dirty.current = true
    set(v)
  }

  const pending = useRef(false)
  const save = useRef(() => {})
  save.current = () => {
    if (!pending.current) return
    pending.current = false
    void channelActions.flow(message.channelId, action()).catch(() => {})
  }
  useEffect(() => {
    if (!dirty.current) return
    pending.current = true
    const t = window.setTimeout(() => save.current(), AUTOSAVE_MS)
    return () => window.clearTimeout(t)
  }, [title, steps, rounds, minutes, cost, isolate, message.channelId])
  // 切走频道时还没存的改动也存上
  useEffect(() => () => save.current(), [])

  // 开始运行先弹「开工」选这次用哪些 AI；确认后按选好的分工和设置存一次再开始
  const [starting, setStarting] = useState(false)
  const start = async (final: FlowStepInput[]) => {
    pending.current = false
    if (!(await run({ ...action(), steps: final }))) return
    setStarting(false)
    await run({ type: 'start', messageId: message.id })
  }
  const agentOptions: SelectOption<string>[] = agents.map(a => ({ value: a.id, label: a.name }))
  const kinds: { value: FlowStepKind; label: string }[] = [
    { value: 'work', label: tr('channels.flow.kind.work') },
    { value: 'review', label: tr('channels.flow.kind.review') },
    { value: 'summary', label: tr('channels.flow.kind.summary') },
  ]
  const toggleDep = (s: FlowStepInput, dep: string) =>
    patchStep(s.id, { deps: s.deps.includes(dep) ? s.deps.filter(d => d !== dep) : [...s.deps, dep] })
  const setKind = (s: FlowStepInput, kind: FlowStepKind) => {
    const target = kind === 'review' ? (s.target ?? s.deps[0] ?? steps.find(x => x.id !== s.id)?.id) : undefined
    patchStep(s.id, {
      kind,
      target,
      deps: target && !s.deps.includes(target) ? [...s.deps, target] : s.deps,
    })
  }
  const remove = (id: string) =>
    edit(list =>
      list
        .filter(s => s.id !== id)
        .map(s => ({ ...s, deps: s.deps.filter(d => d !== id), target: s.target === id ? undefined : s.target })),
    )
  const add = () =>
    edit(list => [
      ...list,
      {
        id: newStepId(list),
        title: '',
        memberId: agents[0]?.id ?? '',
        deps: list.length ? [list[list.length - 1].id] : [],
        kind: 'work',
      },
    ])

  const left = (flow.brief?.open ?? []).filter(o => o.required).length
  return (
    <>
      <p className="mb-1 flex items-center gap-1.5 text-meta text-fg-muted">
        <Workflow size={13} strokeWidth={1.75} className="shrink-0" />
        <span className="min-w-0">{tr(flow.planner ? 'channels.flow.proposalHint' : 'channels.flow.draftHint')}</span>
      </p>
      <input
        aria-label={tr('channels.flow.titleLabel')}
        value={title}
        disabled={readOnly}
        onChange={e => {
          dirty.current = true
          setTitle(e.target.value)
        }}
        className="h-8 w-full rounded-md border border-transparent bg-transparent px-1 text-ui font-semibold text-fg outline-none hover:border-line focus:border-accent"
      />
      {flow.brief && (
        <BriefSection message={message} brief={flow.brief} membersById={membersById} editable={!readOnly} />
      )}
      <ol className="mt-2 flex flex-col gap-2">
        {steps.map((s, i) => (
          <li key={s.id} className="rounded-md border border-line-subtle bg-subtle/40 p-2" data-flow-draft-step={s.id}>
            <div className="flex items-center gap-2">
              <span className="w-5 shrink-0 text-center text-ui text-fg-muted">{num(i)}</span>
              <input
                aria-label={tr('channels.flow.stepTitle')}
                placeholder={tr('channels.flow.stepTitle')}
                value={s.title}
                disabled={readOnly}
                onChange={e => patchStep(s.id, { title: e.target.value })}
                className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-ui text-fg outline-none focus:border-accent"
              />
              <div className="w-32 shrink-0">
                <Select
                  label={tr('channels.flow.member')}
                  value={s.memberId}
                  placeholder={tr('channels.flow.pickMember')}
                  options={agentOptions}
                  disabled={readOnly}
                  onChange={v => patchStep(s.id, { memberId: v })}
                />
              </div>
              <StepSettings
                member={membersById.get(s.memberId)}
                value={s.settings ?? {}}
                onChange={settings => patchStep(s.id, { settings })}
                gate={!!s.gate}
                onGate={gate => patchStep(s.id, { gate })}
              />
              <IconButton
                icon={X}
                iconSize={14}
                label={tr('channels.flow.removeStep')}
                size={26}
                onClick={() => remove(s.id)}
                disabled={readOnly}
              />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-7">
              <Segmented
                label={tr('channels.flow.kind')}
                options={kinds}
                value={s.kind}
                disabled={readOnly}
                onChange={k => setKind(s, k)}
              />
              {s.kind === 'review' && (
                <div className="w-36">
                  <Select
                    label={tr('channels.flow.target')}
                    value={s.target ?? ''}
                    placeholder={tr('channels.flow.target')}
                    options={steps.flatMap((x, j) =>
                      x.id === s.id ? [] : [{ value: x.id, label: `${num(j)} ${x.title}` }],
                    )}
                    disabled={readOnly}
                    onChange={v => patchStep(s.id, { target: v, deps: s.deps.includes(v) ? s.deps : [...s.deps, v] })}
                  />
                </div>
              )}
              {steps.length > 1 && (
                <span className="flex items-center gap-1" role="group" aria-label={tr('channels.flow.deps')}>
                  <span className="text-meta text-fg-faint">{tr('channels.flow.deps')}</span>
                  {steps.map((x, j) =>
                    x.id === s.id ? null : (
                      <button
                        key={x.id}
                        type="button"
                        aria-pressed={s.deps.includes(x.id)}
                        disabled={readOnly}
                        onClick={() => toggleDep(s, x.id)}
                        className={cn(
                          'h-6 min-w-6 rounded-md px-1.5 text-meta',
                          s.deps.includes(x.id)
                            ? 'bg-accent-soft text-accent-fg'
                            : 'bg-subtle text-fg-muted hover:bg-hover',
                        )}
                      >
                        {num(j)}
                      </button>
                    ),
                  )}
                </span>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-meta text-fg-muted">
        {tr('channels.flow.limitsRow')}
        <LimitInput
          label={tr('channels.flow.limitsRoundsLabel')}
          value={rounds}
          disabled={readOnly}
          onChange={v => editLimit(setRounds, v)}
        />
        {tr('channels.flow.limitsRounds')} · {tr('channels.flow.limitsMid')}
        <LimitInput
          label={tr('channels.flow.limitsMinutesLabel')}
          value={minutes}
          disabled={readOnly}
          onChange={v => editLimit(setMinutes, v)}
        />
        {tr('channels.flow.limitsMinutes')} {tr('channels.flow.limitsCost')}
        <LimitInput
          label={tr('channels.flow.limitsCostLabel')}
          value={cost}
          disabled={readOnly}
          decimal
          onChange={v => editLimit(setCost, v)}
        />
        <label className="ml-auto flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={isolate}
            disabled={readOnly}
            onChange={e => {
              dirty.current = true
              setIsolate(e.target.checked)
            }}
          />
          {tr('channels.flow.isolate')}
        </label>
      </div>
      {costNum(cost) !== null && <CostWarning steps={steps} membersById={membersById} />}
      {!readOnly && (
        <div className="mt-2 flex items-center gap-2">
          <Button icon={Plus} className="h-7 px-2.5" onClick={add} disabled={agents.length === 0}>
            {tr('channels.flow.addStep')}
          </Button>
          <span className="flex-1" />
          {local && <ScheduleButton channelId={message.channelId} title={title} steps={steps} isolate={isolate} />}
          <Button disabled={busy} onClick={() => void run({ type: 'discard', messageId: message.id })}>
            {tr('channels.flow.discard')}
          </Button>
          <Button variant="primary" disabled={busy || steps.length === 0 || left > 0} onClick={() => setStarting(true)}>
            {left > 0 ? tr('channels.flow.startLeft', { n: left }) : tr('channels.flow.start')}
          </Button>
        </div>
      )}
      {starting && (
        <StartDialog
          steps={steps}
          agents={agents}
          membersById={membersById}
          busy={busy}
          onConfirm={final => void start(final)}
          onCancel={() => setStarting(false)}
        />
      )}
    </>
  )
}

/** 提案的要点：目标、定下来的（谁说的）、开工前还要定的（草稿时能直接回答，或交给 AI 定） */
function BriefSection({
  message,
  brief,
  membersById,
  editable,
}: {
  message: ChannelTextMessage
  brief: FlowBrief
  membersById: Members
  editable: boolean
}) {
  useI18n()
  const { run, busy } = useFlowRun(message.channelId)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const save = (next: FlowBrief) => {
    setAnswers({})
    void run({ type: 'update', messageId: message.id, brief: next })
  }
  // 回答的结论没写谁定的：主进程记成你
  const answer = (q: string) => {
    const v = (answers[q] ?? '').trim()
    if (v) save({ ...brief, facts: [...brief.facts, { k: q, v, by: '' }], open: brief.open.filter(o => o.q !== q) })
  }
  return (
    <section
      aria-label={tr('channels.flow.brief')}
      className="mt-2 flex flex-col gap-1.5 rounded-md border border-dashed border-line px-2.5 py-2"
      data-flow-brief
    >
      {brief.goal && <p className="text-ui text-fg">{brief.goal}</p>}
      {brief.facts.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-meta">
          {brief.facts.map((f, i) => {
            const by = membersById.get(f.by)?.name
            return (
              <Fragment key={`${i}:${f.k}`}>
                <dt className="text-fg-muted">{f.k}</dt>
                <dd className="min-w-0 text-fg">
                  {f.v}
                  {f.suggested && (
                    <span className="ml-1.5 rounded-sm bg-subtle px-1 text-fg-muted">
                      {tr('channels.plan.suggested')}
                    </span>
                  )}
                  {by && <span className="ml-1.5 text-fg-faint">· {by}</span>}
                </dd>
              </Fragment>
            )
          })}
        </dl>
      )}
      {brief.open.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-meta text-fg-muted">{tr('channels.flow.brief.open')}</span>
          {brief.open.map(o => (
            <div key={o.q} className="flex flex-wrap items-center gap-1.5">
              <span className={cn('min-w-0 flex-1 text-meta', o.required ? 'text-warn' : 'text-fg-muted')}>
                {o.q}
                {!o.required && ` ${tr('channels.flow.brief.aiDecides')}`}
              </span>
              {editable && (
                <>
                  <input
                    aria-label={tr('channels.flow.brief.answerLabel', { q: o.q })}
                    value={answers[o.q] ?? ''}
                    onChange={e => setAnswers(a => ({ ...a, [o.q]: e.target.value }))}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) answer(o.q)
                    }}
                    className="h-7 w-40 rounded-md border border-line bg-surface px-2 text-meta text-fg outline-none focus:border-accent"
                  />
                  <Button
                    className="h-7 px-2"
                    disabled={busy || !(answers[o.q] ?? '').trim()}
                    onClick={() => answer(o.q)}
                  >
                    {tr('channels.flow.brief.answer')}
                  </Button>
                </>
              )}
            </div>
          ))}
          {editable && brief.open.some(o => o.required) && (
            <Button
              className="h-7 self-end px-2.5"
              disabled={busy}
              onClick={() => save({ ...brief, open: brief.open.map(o => ({ ...o, required: false })) })}
            >
              {tr('channels.flow.brief.letAi')}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}

/** 一步用 user_ask 问你：问题和回答框，答了它接着做 */
function AnswerBox({
  question,
  asker,
  disabled,
  onAnswer,
}: {
  question: string
  asker: string
  disabled: boolean
  onAnswer: (text: string) => void
}) {
  useI18n()
  const [text, setText] = useState('')
  const send = () => {
    if (text.trim()) onAnswer(text.trim())
  }
  return (
    <div className="mr-1.5 mb-1.5 ml-8 flex flex-col gap-1.5 rounded-md bg-subtle px-2.5 py-2">
      <span className="text-meta text-fg-muted">{tr('channels.flow.ask.label', { name: asker })}</span>
      <p className="text-ui whitespace-pre-wrap text-fg">{question}</p>
      <div className="flex items-start gap-1.5">
        <textarea
          aria-label={tr('channels.flow.brief.answerLabel', { q: question })}
          placeholder={tr('channels.flow.ask.placeholder')}
          rows={2}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          className="min-w-0 flex-1 resize-y rounded-md border border-line bg-surface px-2 py-1 text-ui text-fg outline-none focus:border-accent"
        />
        <Button variant="primary" className="h-7 px-2.5" disabled={disabled || !text.trim()} onClick={send}>
          {tr('channels.flow.brief.answer')}
        </Button>
      </div>
    </div>
  )
}

const limitText = (kind: 'Rounds' | 'Minutes' | 'Cost', n: number | null): string =>
  n == null ? tr('channels.flow.limitsNone') : tr(`channels.flow.limitsShown${kind}`, { n })

/** 一步现在的状态文字 */
function stepStatus(flow: ChannelFlow, step: FlowStep, membersById: Members): { text: string; running: boolean } {
  const byId = new Map(flow.steps.map((s, i) => [s.id, { s, i }]))
  const target = step.target ? byId.get(step.target)?.s : undefined
  const rejected = step.kind === 'review' && target && target.rejects > 0
  const rejectText = () => tr('channels.flow.step.rejected', { count: target?.rejects ?? 0, max: flow.maxRejects })
  switch (step.status) {
    case 'pending': {
      const waiting = step.deps.flatMap(d => {
        const dep = byId.get(d)
        return dep && dep.s.status !== 'delivered' ? [num(dep.i)] : []
      })
      if (rejected) return { text: rejectText(), running: false }
      return {
        text: waiting.length
          ? tr('channels.flow.step.waitDeps', { steps: waiting.join('') })
          : tr('channels.flow.step.notStarted'),
        running: false,
      }
    }
    case 'running':
      return { text: tr('channels.flow.step.running'), running: true }
    case 'asking': {
      if (step.question) return { text: tr('channels.flow.step.askingYou'), running: false }
      const to = [...(flow.asks ?? [])].reverse().find(a => a.from === step.memberId)?.to
      if (to === SELF) return { text: tr('channels.flow.step.answered'), running: true }
      const name = to ? membersById.get(to)?.name : undefined
      return {
        text: name ? tr('channels.flow.step.asking', { name }) : tr('channels.flow.step.askingAny'),
        running: true,
      }
    }
    case 'gated':
      return { text: tr('channels.flow.step.gated'), running: false }
    case 'delivered':
      if (step.kind === 'review')
        return {
          text: step.result?.verdict === 'reject' ? rejectText() : tr('channels.flow.step.pass'),
          running: false,
        }
      return { text: tr('channels.flow.step.delivered'), running: false }
    case 'failed':
      return { text: tr('channels.flow.step.failed'), running: false }
    case 'stopped':
      return { text: tr('channels.flow.step.stopped'), running: false }
  }
}

/** 主进程里「你」的成员 id（SELF_ID） */
const SELF = 'you'

const STEP_TONE: Record<FlowStep['status'], string> = {
  pending: 'bg-subtle text-fg-muted',
  running: 'bg-accent-soft text-accent-fg',
  asking: 'bg-accent-soft text-accent-fg',
  gated: 'bg-subtle text-warn',
  delivered: 'bg-subtle text-success',
  failed: 'bg-subtle text-danger',
  stopped: 'bg-subtle text-fg-faint',
}

/** 卡头上的小标签 */
function Pill({ tone, spin, children }: { tone: string; spin?: boolean; children: ReactNode }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-px text-meta font-medium', tone)}>
      {spin && <Spinner size={10} />}
      {children}
    </span>
  )
}

const LINK = 'shrink-0 rounded px-1 text-meta text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-50'

/** 拟计划的成员在干什么：前面几步打勾，最新的一行在转圈（和任务卡「正在做什么」同一套说法） */
function plannerTrace(task: ChannelTask | undefined): { done: string[]; now: string | null } {
  const activity = task ? taskActivity(task) : null
  if (!activity) return { done: [], now: null }
  const current = activity.line.kind === 'step' ? activity.line.stepId : undefined
  const done = activity.steps
    .filter(s => s.id !== current)
    .slice(-RECENT_STEPS)
    .flatMap(s => {
      const text = agentActivity({ state: 'running' }, [s])?.text
      return text ? [text] : []
    })
  return { done, now: activity.line.text }
}

/** 流程标题就是你刚发的那句（还没由拟计划的成员起短标题）：卡头不抄这句，写谁在拟 */
const titleIsRequest = (flow: ChannelFlow): boolean =>
  !!flow.planner && flow.planner.request.replace(/\s+/g, ' ').includes(flow.title)

/**
 * 流程卡（docs/ui/channels-pipeline.md §4.5）：一个计划一张卡。卡头写谁在拟、模型、计划模式和现在的阶段，
 * 换人 / 停止 / 打开会话都在卡头；拟计划的进度、要你定的问题、草稿、开工后的步骤都在卡里换内容
 */
export function ChannelFlowCard({
  message,
  membersById,
  channelMembers,
  readOnly = false,
  highlight = false,
  attached = false,
  part = 'whole',
  onOpenSession,
}: {
  message: ChannelTextMessage
  membersById: Members
  channelMembers: readonly ChannelMember[]
  /** 归档的频道只读 */
  readOnly?: boolean
  highlight?: boolean
  /** 放在拟计划的成员那条消息里（头像、名字在外面），不再自己占一行 */
  attached?: boolean
  /** 你回答了问题时时间线拆成两行：questions 只显示问过的问题（只读、能收起），plan 是之后的计划 / 进度 */
  part?: FlowPart
  /** 打开拟计划那项活的会话 */
  onOpenSession?: (sessionId: string) => void
}) {
  useI18n()
  const flow = message.flow!
  const { run, busy } = useFlowRun(message.channelId)
  const gate = (stepId: string, decision: 'approve' | 'reject', note?: string) =>
    void run({ type: 'gate', messageId: message.id, stepId, decision, ...(note ? { note } : {}) })
  const act = (type: 'pause' | 'resume' | 'stop' | 'discard') => void run({ type, messageId: message.id })
  const agents = channelMembers.filter(m => m.kind === 'agent')
  const planner = flow.planner ? membersById.get(flow.planner.memberId) : undefined
  const channelMessages = useChannels(s => s.messages[message.channelId])
  const taskOf = new Map<string, ChannelTask>()
  for (const m of channelMessages ?? []) if (m.kind === 'task') taskOf.set(m.id, m)
  const tasks = flow.steps.flatMap(s => (s.taskId && taskOf.get(s.taskId) ? [taskOf.get(s.taskId)!] : []))
  const plannerTask = flow.planner?.taskId ? taskOf.get(flow.planner.taskId) : undefined
  const planning = flow.status === 'planning'
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (flow.status !== 'running') return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [flow.status])
  const total = flow.status === 'draft' || planning ? '' : flowTotal(flow, tasks, now)
  const flowUsage =
    flow.status === 'draft' || planning
      ? null
      : usageText(sumUsage(flow.steps.flatMap(s => (s.usage ? [s.usage] : []))))
  // 计划阶段（拟计划中 / 问你 / 草稿）：卡头写拟计划的成员；开工后写流程标题
  const planPhase = !!flow.planner && (planning || flow.status === 'draft')
  const unanswered = flow.status === 'draft' ? (flow.questions ?? []).filter(q => !q.answer).length : 0
  const delivered = flow.steps.filter(s => s.status === 'delivered').length
  const sessionId = plannerTask?.sessionId
  const openSession = sessionId && onOpenSession ? () => onOpenSession(sessionId) : null
  const trace = planning ? plannerTrace(plannerTask) : { done: [], now: null }
  const showTitle = !titleIsRequest(flow)
  const summary = plannerSummary(flow)
  const questionsPart = part === 'questions'
  // 回答过的问题默认展开，能收起
  const [collapsed, setCollapsed] = useState(false)
  const headTitle = (
    <span className="min-w-0 truncate text-ui font-semibold text-fg">
      {showTitle ? flow.title : tr('channels.plan.planner', { name: planner?.name ?? '?' })}
    </span>
  )

  const pill = planning ? (
    <Pill tone="bg-accent-soft text-accent-fg" spin={plannerTask?.status !== 'queued'}>
      {plannerTask?.status === 'queued' ? tr('channels.task.queued') : tr('channels.plan.phase.planning')}
    </Pill>
  ) : unanswered > 0 ? (
    <Pill tone="bg-warn/12 text-warn">{tr('channels.plan.phase.asking', { n: unanswered })}</Pill>
  ) : flow.status === 'draft' ? (
    <Pill tone="bg-accent-soft text-accent-fg">{tr('channels.plan.phase.draft', { n: flow.rev ?? 1 })}</Pill>
  ) : flow.status === 'running' ? (
    <Pill tone="bg-accent-soft text-accent-fg" spin>
      {tr('channels.plan.phase.running', { done: delivered, total: flow.steps.length })}
    </Pill>
  ) : (
    <Pill
      tone={
        flow.status === 'paused'
          ? 'bg-warn/12 text-warn'
          : flow.status === 'done'
            ? 'bg-success/12 text-success'
            : 'bg-subtle text-fg-muted'
      }
    >
      {tr(`channels.flow.status.${flow.status}`)}
    </Pill>
  )

  // 手写的草稿没有卡头：草稿编辑器自己写提示。谁在拟写在卡外面的作者行，卡头写计划的标题
  const header = questionsPart ? (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 bg-subtle/60 px-3 py-2 text-meta',
        !collapsed && 'border-b border-line-subtle',
      )}
    >
      {headTitle}
      <Pill tone="bg-subtle text-fg-muted">{tr('channels.plan.readOnly')}</Pill>
      <span className="flex-1" />
      <Pill tone="bg-accent-soft text-accent-fg">
        {tr('channels.plan.answered', { n: flow.questions?.length ?? 0 })}
      </Pill>
      <button
        type="button"
        className={cn(LINK, 'font-medium text-accent-fg')}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(c => !c)}
      >
        {tr(collapsed ? 'channels.plan.expand' : 'channels.plan.collapse')}
      </button>
    </div>
  ) : planPhase ? (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line-subtle bg-subtle/60 px-3 py-2 text-meta">
      {headTitle}
      {summary && <span className="min-w-0 truncate text-fg-faint">{summary}</span>}
      <Pill tone="bg-subtle text-fg-muted">{tr('channels.plan.readOnly')}</Pill>
      <span className="flex-1" />
      {pill}
      <span className="flex items-center gap-0.5">
        <PlannerSwitch message={message} flow={flow} agents={agents} readOnly={readOnly} />
        {planning && !readOnly && (
          <button type="button" className={LINK} disabled={busy} onClick={() => act('discard')}>
            {tr('channels.flow.stop')}
          </button>
        )}
        {openSession && (
          <button type="button" className={LINK} onClick={openSession}>
            {tr('channels.openSession')}
          </button>
        )}
      </span>
    </div>
  ) : flow.status !== 'draft' ? (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line-subtle bg-subtle/60 px-3 py-2 text-meta">
      <Workflow size={14} strokeWidth={1.75} className="shrink-0 text-fg-muted" />
      <span className="min-w-0 flex-1 truncate text-ui font-semibold text-fg">{flow.title}</span>
      {flow.planner?.auto && (
        <span className="max-w-40 shrink-0 truncate text-fg-faint">
          {tr('channels.flow.autoPlan', { name: planner?.name ?? '?' })}
        </span>
      )}
      {pill}
      {!readOnly && (flow.status === 'running' || flow.status === 'paused') && (
        <span className="flex items-center gap-0.5">
          {flow.status === 'running' ? (
            <button type="button" className={LINK} disabled={busy} onClick={() => act('pause')}>
              {tr('channels.flow.pause')}
            </button>
          ) : (
            <button
              type="button"
              className={cn(LINK, 'font-medium text-accent-fg')}
              disabled={busy}
              onClick={() => act('resume')}
            >
              {tr(flow.paused?.reason === 'limit' ? 'channels.flow.resumeLimit' : 'channels.flow.resume')}
            </button>
          )}
          <button type="button" className={LINK} disabled={busy} onClick={() => act('stop')}>
            {tr('channels.flow.stop')}
          </button>
        </span>
      )}
    </div>
  ) : null

  const body = questionsPart ? (
    collapsed ? null : (
      <QuestionsForm key={flow.questions?.length ?? 0} message={message} flow={flow} readOnly />
    )
  ) : planning ? (
    <div className="flex flex-col gap-2">
      {flow.brief && <BriefSection message={message} brief={flow.brief} membersById={membersById} editable={false} />}
      <div className="flex flex-col gap-0.5 text-meta text-fg-muted" data-flow-trace>
        {trace.done.map((t, i) => (
          <span key={i} className="flex min-w-0 items-center gap-2">
            <Check size={12} strokeWidth={2} className="shrink-0 text-success" />
            <span className="min-w-0 truncate">{t}</span>
          </span>
        ))}
        <span className="flex min-w-0 items-center gap-2 text-fg">
          <Spinner size={11} />
          <span className="min-w-0 truncate">
            {trace.now ??
              (plannerTask?.status === 'queued'
                ? tr('channels.task.queued')
                : tr(flow.steps.length ? 'channels.flow.refining' : 'channels.plan.reading', {
                    name: planner?.name ?? '?',
                  }))}
          </span>
          {plannerTask?.progress && (
            <span className="shrink-0 text-fg-faint tabular-nums">
              {tr('channels.task.progress', { done: plannerTask.progress.done, total: plannerTask.progress.total })}
            </span>
          )}
        </span>
      </div>
      <p className="text-meta text-fg-faint">{tr('channels.plan.note')}</p>
    </div>
  ) : unanswered > 0 ? (
    <QuestionsForm key={flow.questions!.length} message={message} flow={flow} readOnly={readOnly} />
  ) : flow.status === 'draft' ? (
    <DraftEditor
      key={flow.rev ?? 0}
      message={message}
      flow={flow}
      agents={agents}
      membersById={membersById}
      readOnly={readOnly}
    />
  ) : (
    <>
      {flow.status === 'paused' && flow.paused && (
        <p className="mb-1 text-meta text-warn">
          {tr(
            flow.paused.reason === 'limit' && flow.paused.limit
              ? `channels.flow.pause.limit.${flow.paused.limit}`
              : `channels.flow.pause.${flow.paused.reason}`,
          )}
        </p>
      )}
      {flow.brief && (
        <details className="mb-1 text-meta text-fg-muted">
          <summary className="cursor-pointer select-none">
            {tr('channels.flow.brief.show', { n: flow.brief.facts.length })}
          </summary>
          <BriefSection message={message} brief={flow.brief} membersById={membersById} editable={false} />
        </details>
      )}
      <ol className="flex flex-col">
        {flow.steps.map((s, i) => {
          const st = stepStatus(flow, s, membersById)
          const member = membersById.get(s.memberId)
          const task = s.taskId ? taskOf.get(s.taskId) : undefined
          // 模型在做什么（docs/ui/channels-live-activity.md）：有了这几行，耗时放进状态标签，耗时和用量改成悬停看
          const view = task && (s.status === 'running' || s.status === 'failed') ? activityView(task) : null
          const stats = stepStats(s, task, now)
          const usage = usageText(s.usage)
          const statsLine = [stats, usage?.text].filter(Boolean).join(' · ')
          // 第二轮起不写：startedAt 只记第一轮，打回重做会把等审查的时间算进去
          const elapsed = view && task && s.status === 'running' ? taskElapsed(task, now) : null
          return (
            <li key={s.id}>
              <button
                type="button"
                disabled={!s.taskId}
                aria-label={tr('channels.flow.step.open', { n: i + 1 })}
                title={view ? statsLine || undefined : undefined}
                onClick={() => s.taskId && void channelActions.focusMessage(message.channelId, s.taskId)}
                className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-1.5 py-1.5 text-left enabled:hover:bg-hover"
              >
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span className="w-5 shrink-0 text-center text-ui text-fg-muted">{num(i)}</span>
                  <span className="min-w-[4em] flex-1 truncate text-ui text-fg">{s.title}</span>
                  <MemberAvatar member={member} size={18} />
                  <span className="max-w-24 shrink-0 truncate text-meta text-fg-muted">{member?.name ?? '?'}</span>
                  <span
                    className={cn(
                      // 窄时标签让位，步骤名至少留几个字
                      'inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-meta',
                      STEP_TONE[s.status],
                    )}
                  >
                    {st.running && (
                      <span className="flex shrink-0">
                        <Spinner size={10} />
                      </span>
                    )}
                    <span className="min-w-0 truncate">
                      {st.text}
                      {elapsed !== null && <span className="tabular-nums"> · {durText(elapsed)}</span>}
                    </span>
                  </span>
                </span>
                {statsLine && !view && (
                  <span className="truncate pl-7 text-meta text-fg-faint" title={usage?.title || undefined}>
                    {statsLine}
                  </span>
                )}
                {s.copy && (
                  <span className="truncate pl-7 text-meta text-fg-faint">
                    {tr('channels.flow.copy', { branch: s.copy.branch })}
                  </span>
                )}
                {(s.status === 'delivered' || s.status === 'gated') && s.result?.summary && (
                  <span className="truncate pl-7 text-meta text-fg-faint">{s.result.summary}</span>
                )}
                {!!s.overlap?.length && (
                  <span className="truncate pl-7 text-meta text-warn" title={s.overlap.map(o => o.path).join('\n')}>
                    {tr('channels.flow.overlap', {
                      steps: [...new Set(s.overlap.flatMap(o => o.steps))]
                        .map(id => NUMBERS[flow.steps.findIndex(x => x.id === id)] ?? '?')
                        .join(tr('channels.composer.nameSep')),
                      files: s.overlap.map(o => o.path).join(tr('channels.composer.nameSep')),
                    })}
                  </span>
                )}
                {(s.status === 'delivered' || s.status === 'gated') && !!s.result?.open?.length && (
                  <span className="truncate pl-7 text-meta text-warn" title={s.result.open.join('\n')}>
                    {tr('channels.flow.open', { items: s.result.open.join(tr('channels.flow.openSep')) })}
                  </span>
                )}
              </button>
              {view && <ActivityLines view={view} className="pr-1.5 pb-1 pl-[34px]" />}
              {s.question && !readOnly && (flow.status === 'running' || flow.status === 'paused') && (
                <AnswerBox
                  question={s.question.text}
                  asker={member?.name ?? '?'}
                  disabled={busy}
                  onAnswer={text => void run({ type: 'answer', messageId: message.id, stepId: s.id, text })}
                />
              )}
              {s.status === 'gated' && !readOnly && (flow.status === 'running' || flow.status === 'paused') && (
                <div className="flex items-center justify-end gap-1.5 pt-0.5 pr-1.5 pb-1.5 pl-8" data-flow-gate={s.id}>
                  <GateActions
                    disabled={busy}
                    onApprove={() => gate(s.id, 'approve')}
                    onReject={note => gate(s.id, 'reject', note)}
                  />
                </div>
              )}
            </li>
          )
        })}
      </ol>
      {total && <p className="mt-1.5 px-1.5 text-meta text-fg-faint">{total}</p>}
      {flowUsage && (
        <p className="mt-1 px-1.5 text-meta text-fg-faint" title={flowUsage.title || undefined}>
          {flowUsage.text} · {tr('channels.flow.usage.noPlan')}
        </p>
      )}
      {flow.limits && (flow.status === 'running' || flow.status === 'paused') && (
        <p className="mt-1 px-1.5 text-meta text-fg-faint">
          {tr('channels.flow.limitsShown', {
            rounds: limitText('Rounds', flow.limits.rounds),
            minutes: limitText('Minutes', flow.limits.minutes),
          }) + (flow.limits.costUsd ? ` · ${limitText('Cost', flow.limits.costUsd)}` : '')}
        </p>
      )}
    </>
  )

  const card = (
    <article
      aria-label={tr('channels.flow.label', { title: flow.title })}
      data-flow-status={flow.status}
      data-channel-message={attached ? (questionsPart ? `${message.id}:questions` : message.id) : undefined}
      className={cn(
        'overflow-hidden rounded-xl border border-line-card bg-surface text-left shadow-sm',
        attached ? 'w-[620px] max-w-full rounded-tl-md' : 'max-w-[620px]',
        flow.status === 'paused' && 'border-warn/40',
        highlight && 'search-hit',
      )}
    >
      {header}
      {body && <div className="p-3">{body}</div>}
    </article>
  )
  return attached ? (
    card
  ) : (
    <div className="conversation-message mt-3 pl-10" data-channel-message={message.id}>
      {card}
    </div>
  )
}
