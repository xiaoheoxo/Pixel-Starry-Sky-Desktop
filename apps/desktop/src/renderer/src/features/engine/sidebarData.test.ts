import { describe, expect, it } from 'vitest'
import type { ProjectRecord, SessionSummary } from '@pixelsky/protocol'
import { captureRecency, demoSidebarData, freezeRecency, recentSpansProjects, sidebarData } from './sidebarData'
describe('侧栏归档分组', () => {
  it('置底在项目尾部；最近先取八条再置底，目标仍可见，普通项顺序稳定', () => {
    const projects: ProjectRecord[] = [{ id: 'p', name: '项目', path: 'test', addedAt: 1 }]
    const sessions = Array.from({ length: 10 }, (_, i) => ({
      record: {
        id: 's' + i,
        projectId: 'p',
        title: '会话' + i,
        updatedAt: 100 - i,
        bottomedAt: i === 0 ? 2 : i === 2 ? 1 : null,
      },
      state: 'idle',
    })) as SessionSummary[]
    const data = sidebarData(projects, sessions, {}, String)
    expect(data.projects[0].sessions.map(s => s.id)).toEqual([
      's1',
      's3',
      's4',
      's5',
      's6',
      's7',
      's8',
      's9',
      's2',
      's0',
    ])
    expect(data.recent.map(s => s.id)).toEqual(['s1', 's3', 's4', 's5', 's6', 's7', 's2', 's0'])
    expect(sessions[0].record.id).toBe('s0')
  })
  it('归档与演示重命名 / 置底保持所属列表，标题同步到最近任务', () => {
    const projects = [
      {
        id: 'p',
        name: '项目',
        sessions: [
          { id: 'a', title: 'A', status: 'idle' as const },
          { id: 'c', title: 'C', status: 'idle' as const },
        ],
        archived: [{ id: 'b', title: 'B', status: 'idle' as const, archivedAt: 1 }],
      },
    ]
    const data = demoSidebarData(
      projects,
      [
        { id: 'a', title: 'A', time: '' },
        { id: 'c', title: 'C', time: '' },
      ],
      {
        a: { archivedAt: null, deleted: false, stopped: false, title: '已改名', bottomedAt: 2 },
        b: { archivedAt: 1, deleted: false, stopped: false, title: '归档名称', bottomedAt: 3 },
      },
    )
    expect(data.projects[0].sessions.map(s => s.title)).toEqual(['C', '已改名'])
    expect(data.recent.map(s => s.title)).toEqual(['C', '已改名'])
    expect(data.projects[0].archived[0].title).toBe('归档名称')
    expect(projects[0].sessions[0].title).toBe('A')
  })
  it('置顶的会话只在置顶分组（后置顶的在前、带项目名），归档的不算；演示的置顶改动同样生效', () => {
    const projects: ProjectRecord[] = [
      { id: 'p', name: '项目', path: 'test', addedAt: 1 },
      { id: 'q', name: '另一个', path: 'test2', addedAt: 2 },
    ]
    const sessions = [
      { record: { id: 'a', projectId: 'p', title: 'A', updatedAt: 3, pinnedAt: 5 }, state: 'idle' },
      { record: { id: 'b', projectId: 'p', title: 'B', updatedAt: 2 }, state: 'idle' },
      { record: { id: 'c', projectId: 'q', title: 'C', updatedAt: 1, pinnedAt: 9 }, state: 'running' },
      { record: { id: 'd', projectId: 'q', title: 'D', updatedAt: 0, pinnedAt: 7, archivedAt: 4 }, state: 'idle' },
    ] as SessionSummary[]
    const data = sidebarData(projects, sessions, {}, String)
    expect(data.pinned.map(s => [s.id, s.project, s.status])).toEqual([
      ['c', '另一个', 'running'],
      ['a', '项目', 'idle'],
    ])
    expect(data.projects.map(p => p.sessions.map(s => s.id))).toEqual([['b'], []])
    expect(data.projects[1].archived?.map(s => s.id)).toEqual(['d'])

    const demo = demoSidebarData(
      [
        {
          id: 'p',
          name: '项目',
          sessions: [
            { id: 'a', title: 'A', status: 'idle' as const, pinnedAt: 1 },
            { id: 'b', title: 'B', status: 'running' as const },
          ],
        },
      ],
      [],
      {
        a: { archivedAt: null, deleted: false, stopped: false, pinnedAt: null },
        b: { archivedAt: null, deleted: false, stopped: false, pinnedAt: 3 },
      },
    )
    expect(demo.pinned.map(s => s.id)).toEqual(['b'])
    expect(demo.projects[0].sessions.map(s => s.id)).toEqual(['a'])
  })
  it('先过滤归档再取最近八条，项目保留归档入口', () => {
    const projects: ProjectRecord[] = [{ id: 'p', name: '项目', path: 'test', addedAt: 1 }]
    const sessions = Array.from({ length: 12 }, (_, i) => ({
      record: { id: 's' + i, projectId: 'p', title: '会话' + i, updatedAt: i, archivedAt: i < 3 ? 10 : null },
      state: 'idle',
    })) as SessionSummary[]
    const data = sidebarData(projects, sessions, { s0: true, s4: true }, String)
    expect(data.recent).toHaveLength(8)
    expect(data.recent[0].id).toBe('s3')
    expect(data.projects[0].archived).toHaveLength(3)
  })
  it('演示归档、恢复与删除仅根据内存覆盖，不改原始数据', () => {
    const projects = [
      {
        id: 'p',
        name: '项目',
        sessions: [{ id: 'a', title: 'A', status: 'idle' as const }],
        archived: [{ id: 'b', title: 'B', status: 'idle' as const, archivedAt: 1 }],
      },
    ]
    const data = demoSidebarData(projects, [{ id: 'a', title: 'A', time: '' }], {
      a: { archivedAt: 2, deleted: false, stopped: true },
      b: { archivedAt: null, deleted: false, stopped: true },
    })
    expect(data.projects[0].sessions.map(s => s.id)).toEqual(['b'])
    expect(data.projects[0].archived.map(s => s.id)).toEqual(['a'])
    expect(data.recent.map(s => s.id)).toEqual(['b'])
    expect(projects[0].sessions[0].id).toBe('a')
  })
})

describe('最近任务只在跨项目时显示（docs/ui/conversation-ux-2.md §2.3）', () => {
  it('一个项目不显示，两个项目显示；演示数据没有项目 id 时按项目名', () => {
    const projects: ProjectRecord[] = [
      { id: 'a', name: 'A', path: 'a', addedAt: 1 },
      { id: 'b', name: 'B', path: 'b', addedAt: 2 },
    ]
    const session = (id: string, projectId: string) =>
      ({ record: { id, projectId, title: id, updatedAt: 1 }, state: 'idle' }) as SessionSummary
    const one = sidebarData(projects, [session('s1', 'a'), session('s2', 'a')], {}, String)
    expect(one.recent.map(r => r.projectId)).toEqual(['a', 'a'])
    expect(recentSpansProjects(one.recent)).toBe(false)
    const two = sidebarData(projects, [session('s1', 'a'), session('s2', 'b')], {}, String)
    expect(recentSpansProjects(two.recent)).toBe(true)
    expect(recentSpansProjects([{ project: 'A' }, { project: 'B' }])).toBe(true)
    expect(recentSpansProjects([])).toBe(false)
  })
})

describe('后台子智能体还在跑', () => {
  it('会话空着但后台还在跑：算运行中（不显示成有新回复），项目和运行条都算上', () => {
    const projects: ProjectRecord[] = [{ id: 'p', name: '项目', path: 'test', addedAt: 1 }]
    const sessions = [
      { record: { id: 'a', projectId: 'p', title: 'A', updatedAt: 2 }, state: 'idle', background: 3 },
      { record: { id: 'b', projectId: 'p', title: 'B', updatedAt: 1 }, state: 'idle' },
    ] as SessionSummary[]
    const data = sidebarData(projects, sessions, { a: true, b: true }, String)
    expect(data.projects[0].running).toBe(true)
    expect(data.projects[0].sessions.map(s => [s.id, s.status])).toEqual([
      ['a', 'running'],
      ['b', 'unread'],
    ])
  })
})

describe('鼠标在侧栏里时冻结按最近活动的排序', () => {
  const projects: ProjectRecord[] = [{ id: 'p', name: '项目', path: 'test', addedAt: 1 }]
  const session = (id: string, updatedAt: number, extra: Record<string, unknown> = {}) =>
    ({ record: { id, projectId: 'p', title: id, updatedAt, ...extra }, state: 'idle' }) as SessionSummary
  /** 宿主给的顺序：updatedAt 从新到旧 */
  const host = (list: SessionSummary[]) => [...list].sort((a, b) => b.record.updatedAt - a.record.updatedAt)
  const ids = (data: ReturnType<typeof sidebarData>) => data.projects[0].sessions.map(s => s.id)
  const before = [session('a', 30), session('b', 20), session('c', 10)]

  it('冻结后某个会话有了新活动，位置不动，时间标签照常更新；解冻后换到最前', () => {
    const frozen = captureRecency(host(before))
    const after = host([session('a', 30), session('b', 20), session('c', 99)])
    const data = sidebarData(projects, after, {}, String, frozen)
    expect(ids(data)).toEqual(['a', 'b', 'c'])
    expect(data.projects[0].sessions.find(s => s.id === 'c')?.time).toBe('99')
    expect(data.recent.map(s => s.id)).toEqual(['a', 'b', 'c'])
    expect(ids(sidebarData(projects, after, {}, String, null))).toEqual(['c', 'a', 'b'])
    expect(ids(sidebarData(projects, after, {}, String))).toEqual(['c', 'a', 'b'])
  })

  it('冻结期间新建的会话马上出现在最前面（最近任务里也是）', () => {
    const frozen = captureRecency(host(before))
    const after = host([...before, session('n', 100)])
    const data = sidebarData(projects, after, {}, String, frozen)
    expect(ids(data)).toEqual(['n', 'a', 'b', 'c'])
    expect(data.recent.map(s => s.id)).toEqual(['n', 'a', 'b', 'c'])
  })

  it('删除、归档、置顶、取消置顶、置底立即生效，其余会话保持冻结的顺序', () => {
    const frozen = captureRecency(host(before))
    const moved = host([session('a', 30), session('b', 77), session('c', 10)])
    // 删除 a
    expect(
      ids(
        sidebarData(
          projects,
          moved.slice(0).filter(s => s.record.id !== 'a'),
          {},
          String,
          frozen,
        ),
      ),
    ).toEqual(['b', 'c'])
    // 归档 a：从列表里出去，进归档
    const archived = host([session('a', 30, { archivedAt: 5 }), session('b', 77), session('c', 10)])
    const archivedData = sidebarData(projects, archived, {}, String, frozen)
    expect(ids(archivedData)).toEqual(['b', 'c'])
    expect(archivedData.projects[0]?.archived?.map(s => s.id)).toEqual(['a'])
    // 置顶 c：进置顶分组，项目里不再有
    const pinned = sidebarData(
      projects,
      host([session('a', 30), session('b', 77), session('c', 10, { pinnedAt: 8 })]),
      {},
      String,
      frozen,
    )
    expect(pinned.pinned.map(s => s.id)).toEqual(['c'])
    expect(ids(pinned)).toEqual(['a', 'b'])
    // 取消置顶：回到冻结时它的位置（不是最前）
    expect(ids(sidebarData(projects, moved, {}, String, frozen))).toEqual(['a', 'b', 'c'])
    // 置底 a：排到最后，剩下的仍是冻结顺序
    const bottomed = sidebarData(
      projects,
      host([session('a', 30, { bottomedAt: 9 }), session('b', 77), session('c', 10)]),
      {},
      String,
      frozen,
    )
    expect(ids(bottomed)).toEqual(['b', 'c', 'a'])
  })

  it('多个置顶之间按置顶先后排，不受冻结影响', () => {
    const frozen = captureRecency(host(before))
    const list = host([session('a', 90, { pinnedAt: 1 }), session('b', 20, { pinnedAt: 2 }), session('c', 10)])
    expect(sidebarData(projects, list, {}, String, frozen).pinned.map(s => s.id)).toEqual(['b', 'a'])
  })

  it('换项目、改名后按冻结的位置排进新项目', () => {
    const two: ProjectRecord[] = [...projects, { id: 'q', name: '另一个', path: 'q', addedAt: 2 }]
    const frozen = captureRecency(host(before))
    const list = host([session('a', 30), session('b', 20, { projectId: 'q', title: '新名字' }), session('c', 99)])
    const data = sidebarData(two, list, {}, String, frozen)
    expect(data.projects[0].sessions.map(s => s.id)).toEqual(['a', 'c'])
    expect(data.projects[1]?.sessions.map(s => [s.id, s.title])).toEqual([['b', '新名字']])
  })

  it('freezeRecency：没有快照原样返回，不改输入数组；冻结的 updatedAt 相同保持原顺序', () => {
    const list = host(before)
    expect(freezeRecency(list, null)).toBe(list)
    expect(freezeRecency(list, new Map())).toBe(list)
    const tie = new Map([
      ['a', 5],
      ['b', 5],
      ['c', 5],
    ])
    expect(freezeRecency([session('c', 1), session('a', 3), session('b', 2)], tie).map(s => s.record.id)).toEqual([
      'c',
      'a',
      'b',
    ])
    expect(list.map(s => s.record.id)).toEqual(['a', 'b', 'c'])
  })
})
