import { describe, expect, it } from 'vitest'
import type { ManualTask } from '../../../../shared/types/project-tools'
import { defaultSchedule } from './scheduleModel'
import { buildColumns, overdue, scheduleTasks, taskOrder, type BoardFilter } from './boardModel'
import { laneCounts, sessionCards, type SessionCard } from './sessionLanes'
import type { SessionSummary } from '@pixelsky/protocol'
import type { InboxItem } from '@/features/panel/inbox/inboxModel'

const DAY = 86_400_000
const NOW = new Date(2026, 9, 12, 12).getTime()
let order = 0
const task = (id: string, patch: Partial<ManualTask> = {}): ManualTask => ({
  id,
  projectId: 'p',
  title: id,
  note: '',
  status: 'pending',
  priority: 'normal',
  due: '',
  tags: [],
  order: order++,
  createdAt: 0,
  updatedAt: NOW,
  completedAt: null,
  ...patch,
})
const card = (id: string, lane: SessionCard['lane'], projectId = 'p'): SessionCard => ({
  id,
  title: id,
  projectId,
  project: projectId,
  at: NOW,
  lane,
  request: null,
  error: null,
  queue: null,
  progress: null,
})
const all: BoardFilter = { projects: [], kind: 'all', query: '' }
const ids = (cols: ReturnType<typeof buildColumns>) =>
  Object.fromEntries(cols.map(c => [c.id, [...c.sessions.map(s => s.id), ...c.tasks.map(t => t.id)]]))

describe('任务看板分列', () => {
  it('手动任务按状态分列，会话按类别分到进行中 / 等你；已完成只看最近 7 天', () => {
    const tasks = [
      task('a'),
      task('b', { status: 'in_progress' }),
      task('c', { status: 'completed', completedAt: NOW - DAY }),
      task('d', { status: 'completed', completedAt: NOW - 10 * DAY }),
      // 旧数据没有完成时间：用最后修改时间
      task('e', { status: 'completed', completedAt: undefined, updatedAt: NOW - 2 * DAY }),
      task('x', { projectId: 'gone' }),
    ]
    const sessions = [card('run', 'running'), card('w', 'waiting'), card('u', 'unread')]
    const input = { tasks, sessions, filter: all, knownProjects: new Set(['p']), showOlder: false, now: NOW }
    const cols = buildColumns(input)
    expect(ids(cols)).toEqual({ todo: ['a'], doing: ['run', 'b'], review: [], waiting: ['w', 'u'], done: ['c', 'e'] })
    expect(cols.map(c => c.id)).toEqual(['waiting', 'todo', 'doing', 'review', 'done'])
    expect(cols[4].older).toBe(1)
    expect(ids(buildColumns({ ...input, showOlder: true })).done).toEqual(['c', 'e', 'd'])
  })

  it('筛选：项目、只看我的待办 / AI、搜索标题备注标签', () => {
    const tasks = [task('fix', { note: '登录页', tags: ['紧急'] }), task('other', { projectId: 'q' })]
    const sessions = [card('s1', 'running'), card('s2', 'waiting', 'q')]
    const base = { tasks, sessions, knownProjects: new Set(['p', 'q']), showOlder: false, now: NOW }
    expect(ids(buildColumns({ ...base, filter: { ...all, projects: ['q'] } }))).toEqual({
      todo: ['other'],
      doing: [],
      review: [],
      waiting: ['s2'],
      done: [],
    })
    expect(ids(buildColumns({ ...base, filter: { ...all, kind: 'mine' } })).doing).toEqual([])
    expect(ids(buildColumns({ ...base, filter: { ...all, kind: 'ai' } })).todo).toEqual([])
    expect(ids(buildColumns({ ...base, filter: { ...all, query: '紧急 登录' } })).todo).toEqual(['fix'])
  })

  it('排序：优先级高 → 截止早 → 原来顺序；过期按本地日期，今天截止不算', () => {
    const list = [
      task('n1'),
      task('due-late', { due: '2026-11-01' }),
      task('high', { priority: 'high' }),
      task('due-soon', { due: '2026-10-13' }),
      task('low', { priority: 'low' }),
    ].sort(taskOrder)
    expect(list.map(t => t.id)).toEqual(['high', 'due-soon', 'due-late', 'n1', 'low'])
    expect(overdue(task('t', { due: '2026-10-11' }), NOW)).toBe(true)
    expect(overdue(task('t', { due: '2026-10-12' }), NOW)).toBe(false)
    expect(overdue(task('t', { due: '2026-10-11', status: 'completed' }), NOW)).toBe(false)
  })
})

describe('定时任务（docs/ui/board-schedule.md）', () => {
  const sched = defaultSchedule()
  const tasks = [
    task('plain'),
    task('every-day', { schedule: sched }),
    task('gone', { projectId: 'x', schedule: sched }),
  ]
  const base = { tasks, knownProjects: new Set(['p']) }
  it('定时任务只在「定时」列，不进待办等列', () => {
    const input = { ...base, sessions: [], filter: all, showOlder: false, now: NOW }
    expect(ids(buildColumns(input)).todo).toEqual(['plain'])
    expect(scheduleTasks({ ...base, filter: all }).map(t => t.id)).toEqual(['every-day'])
  })
  it('「我的待办」「AI」不显示定时列；筛选「定时」只剩定时任务和定时开出来的会话', () => {
    expect(scheduleTasks({ ...base, filter: { ...all, kind: 'mine' } })).toEqual([])
    expect(scheduleTasks({ ...base, filter: { ...all, kind: 'ai' } })).toEqual([])
    const sessions = [card('s1', 'running'), { ...card('s2', 'waiting'), scheduled: true }]
    const cols = buildColumns({ ...base, sessions, filter: { ...all, kind: 'schedule' }, showOlder: false, now: NOW })
    expect(ids(cols)).toEqual({ todo: [], doing: [], review: [], waiting: ['s2'], done: [] })
    expect(scheduleTasks({ ...base, filter: { ...all, kind: 'schedule', query: 'nothing' } })).toEqual([])
  })
})

describe('会话分类（胶囊和看板共用）', () => {
  it('等你直接用待处理的结果；其余在跑的算运行中，有新回复的算等你；等你批准的不算运行中', () => {
    const summary = (id: string, state: SessionSummary['state'], extra: object = {}) =>
      ({ record: { id, projectId: 'p', title: id, updatedAt: 1, ...extra }, state }) as SessionSummary
    const sessions = [
      summary('waiting', 'waiting'),
      summary('running', 'running'),
      summary('bg', 'idle', {}),
      summary('read', 'idle'),
      summary('new', 'idle'),
      summary('old', 'idle', { archivedAt: 5 }),
    ]
    sessions[2] = { ...sessions[2], background: 1 }
    const inbox = [
      { sessionId: 'waiting', lane: 'waiting', at: 9, request: null, error: null, queue: null },
    ] as unknown as InboxItem[]
    const cards = sessionCards({
      sessions,
      snapshots: {},
      projectNames: { p: '项目' },
      unread: { new: true, old: true },
      inbox,
    })
    expect(cards.map(c => [c.id, c.lane])).toEqual([
      ['waiting', 'waiting'],
      ['new', 'unread'],
      ['running', 'running'],
      ['bg', 'running'],
    ])
    expect(laneCounts(cards)).toEqual({ running: 2, waiting: 2 })
  })
})
