import { describe, expect, it } from 'vitest'
import type { ProjectRecord, SessionSummary } from '@pixelsky/protocol'
import { filterTasks, sessionList, sessionStatus, taskProjects } from './tasks'

const task = (
  id: string,
  title: string,
  projectId: string,
  updatedAt: number,
  state: SessionSummary['state'] = 'idle',
  engine: 'claude' | 'codex' = 'claude',
  archivedAt: number | null = null,
): SessionSummary => ({ record: { id, title, projectId, updatedAt, engine, archivedAt }, state }) as SessionSummary

const projects: ProjectRecord[] = [
  { id: 'web', name: 'Website', path: 'D:\\web', addedAt: 0 },
  { id: 'app', name: '手机 App', path: 'D:\\app', addedAt: 0 },
  { id: 'empty', name: '没任务的', path: 'D:\\empty', addedAt: 0 },
]
const sessions = [
  task('a', '修登录页的按钮', 'web', 5),
  task('b', 'Add Login tests', 'app', 9, 'running', 'codex'),
  task('c', '整理日志', 'app', 3),
  task('d', '归档了的登录', 'web', 10, 'idle', 'claude', 7),
]
const name = (s: SessionSummary) => projects.find(p => p.id === s.record.projectId)?.name ?? ''

describe('任务搜索和筛选', () => {
  it('标题、项目名、引擎名都能搜，多个词都要有，不分大小写', () => {
    expect(filterTasks(sessions, '登录', null, name).map(s => s.record.id)).toEqual(['a', 'd'])
    expect(filterTasks(sessions, 'login', null, name).map(s => s.record.id)).toEqual(['b'])
    expect(filterTasks(sessions, '手机 codex', null, name).map(s => s.record.id)).toEqual(['b'])
    expect(filterTasks(sessions, '  ', null, name)).toHaveLength(4)
  })

  it('按项目筛，可以和关键词一起用', () => {
    expect(filterTasks(sessions, '', 'app', name).map(s => s.record.id)).toEqual(['b', 'c'])
    expect(filterTasks(sessions, '日志', 'web', name)).toEqual([])
  })

  it('筛选用的项目只列有（没归档的）任务的，按最近一次任务排', () => {
    expect(taskProjects(sessions, projects).map(p => p.id)).toEqual(['app', 'web'])
  })

  it('会话列表：等你处理置顶，其余置顶的在前再按时间，不含归档；截断后告诉还有几条', () => {
    const pinned = {
      ...task('p', '置顶的', 'web', 1),
      record: { ...task('p', '置顶的', 'web', 1).record, pinnedAt: 1 },
    }
    const list = sessionList([...sessions, task('w', '等我', 'web', 2, 'waiting'), pinned as SessionSummary])
    expect(list.waiting.map(s => s.record.id)).toEqual(['w'])
    expect(list.rest.map(s => s.record.id)).toEqual(['p', 'b', 'a', 'c'])
    expect(list.more).toBe(0)
    const many = Array.from({ length: 7 }, (_, i) => task('t' + i, 't' + i, 'web', i))
    expect(sessionList(many, 5).rest.map(s => s.record.id)).toEqual(['t6', 't5', 't4', 't3', 't2'])
    expect(sessionList(many, 5).more).toBe(2)
  })

  it('一行的状态：等你处理、启动中、正在回复、上一轮出错；空闲是 null', () => {
    expect(sessionStatus(task('a', '', 'web', 1, 'waiting'))?.text).toBe('等你处理')
    expect(sessionStatus(task('a', '', 'web', 1, 'starting'))?.tone).toBe('online')
    expect(sessionStatus(task('a', '', 'web', 1, 'running'))?.text).toBe('正在回复…')
    const failed = task('a', '', 'web', 1)
    expect(sessionStatus({ ...failed, record: { ...failed.record, lastOutcome: 'failed' } })?.tone).toBe('warn')
    expect(sessionStatus(task('a', '', 'web', 1))).toBeNull()
  })
})
