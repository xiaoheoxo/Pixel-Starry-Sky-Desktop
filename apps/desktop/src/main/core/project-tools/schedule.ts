// 定时任务的校验（docs/ui/board-schedule.md §3）。运行记录、lastSlot、lastSessionId 只由主进程改，界面传来的忽略
import {
  SCHEDULE_FREQS,
  SCHEDULE_RUNS_MAX,
  type ScheduleRun,
  type TaskSchedule,
} from '../../../shared/types/project-tools'
import { latestSlot } from '../../../shared/schedule'
import { value } from './common'

const ENGINES = ['claude', 'codex', 'pixel'] as const
/** 无人值守不给 full */
const PERMISSIONS = ['plan', 'ask', 'edits'] as const

const int = (v: unknown, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error('参数不正确')
  return v
}

/** 界面传来的定时设置 → 存起来的形态；改了频率 / 时间或重新启用时，从「现在之前最近的时间点」重新算起，免得立刻补跑 */
export function cleanSchedule(raw: unknown, prior: TaskSchedule | null | undefined, now: number): TaskSchedule | null {
  if (raw === null) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('参数不正确')
  const r = raw as Record<string, unknown>
  const freq = r.freq as TaskSchedule['freq'],
    engine = r.engine as TaskSchedule['engine'],
    permission = r.permission as TaskSchedule['permission']
  if (
    !SCHEDULE_FREQS.includes(freq) ||
    !(ENGINES as readonly string[]).includes(engine) ||
    !(PERMISSIONS as readonly string[]).includes(permission)
  )
    throw new Error('参数不正确')
  if (r.session !== 'new' && r.session !== 'resume') throw new Error('参数不正确')
  const next: TaskSchedule = {
    enabled: r.enabled === true,
    freq,
    hour: int(r.hour, 0, 23),
    minute: int(r.minute, 0, 59),
    weekday: int(r.weekday, 0, 6),
    engine,
    model: r.model == null ? null : value(r.model, 200, true),
    permission,
    session: r.session,
    lastSlot: prior?.lastSlot ?? 0,
    lastSessionId: null,
    runs: prior?.runs ?? [],
  }
  // 续用的会话按它建时的引擎、模型、权限跑：这几项改了下次就新开一个，新设置才生效
  if (prior && prior.engine === next.engine && prior.model === next.model && prior.permission === next.permission)
    next.lastSessionId = prior.lastSessionId ?? null
  const same =
    prior &&
    prior.enabled &&
    prior.freq === next.freq &&
    prior.hour === next.hour &&
    prior.minute === next.minute &&
    prior.weekday === next.weekday
  if (next.enabled && !same) next.lastSlot = latestSlot(next, now)
  return next
}

/** 新的在前，只留最近 SCHEDULE_RUNS_MAX 条 */
export const pushRun = (runs: readonly ScheduleRun[], run: ScheduleRun): ScheduleRun[] =>
  [run, ...runs].slice(0, SCHEDULE_RUNS_MAX)
