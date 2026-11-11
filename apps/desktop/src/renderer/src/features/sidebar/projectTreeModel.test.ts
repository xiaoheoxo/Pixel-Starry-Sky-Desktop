import { describe, expect, it } from 'vitest'
import type { SessionLane } from '@/features/board/sessionLanes'
import {
  ARCHIVED_PAGE,
  foldChannels,
  projectCounts,
  projectFolders,
  visibleArchived,
  visibleSessions,
} from './projectTreeModel'

const session = (id: string, status: 'idle' | 'running' | 'unread' = 'idle') => ({ id, title: id, status })

describe('项目标题的状态数', () => {
  it('等你批准 / 出错 / 暂停算等你，在跑算运行，新回复都不算', () => {
    const lanes = new Map<string, SessionLane>([
      ['a', 'running'],
      ['b', 'waiting'],
      ['c', 'failed'],
      ['d', 'unread'],
    ])
    // e 没进看板分类但状态是 running（刚开始跑）也算
    const sessions = [
      session('a', 'running'),
      session('b', 'running'),
      session('c'),
      session('d', 'unread'),
      session('e', 'running'),
    ]
    expect(projectCounts(sessions, lanes)).toEqual({ running: 2, waiting: 2 })
  })
})

describe('先列哪几个对话', () => {
  const sessions = Array.from({ length: 9 }, (_, i) => session(`s${i}`))
  const none = new Map<string, SessionLane>()

  it('不超过 5 个全部列出', () => {
    expect(visibleSessions(sessions.slice(0, 5), { all: false, selected: null, lanes: none })).toEqual({
      shown: sessions.slice(0, 5),
      hidden: 0,
    })
  })

  it('先列 5 个，后面的只露当前打开的和有状态的', () => {
    const list = sessions.map(s => (s.id === 's7' ? session('s7', 'unread') : s))
    const lanes = new Map<string, SessionLane>([['s6', 'waiting']])
    const { shown, hidden } = visibleSessions(list, { all: false, selected: 's8', lanes })
    expect(shown.map(s => s.id)).toEqual(['s0', 's1', 's2', 's3', 's4', 's6', 's7', 's8'])
    expect(hidden).toBe(1)
  })

  it('点了「还有 N 个」全部列出', () => {
    expect(visibleSessions(sessions, { all: true, selected: null, lanes: none })).toEqual({
      shown: sessions,
      hidden: 0,
    })
  })
})

describe('多文件夹项目的文件夹', () => {
  it('主文件夹在前、编号 0，附加文件夹从 1 起，有名字用名字', () => {
    expect(
      projectFolders({
        path: 'D:/PixelSky',
        folders: [{ path: 'D:/PixelSky-cloud', name: 'cloud' }, { path: 'E:\\docs' }],
      }),
    ).toEqual([
      { index: 0, name: 'PixelSky', path: 'D:/PixelSky' },
      { index: 1, name: 'cloud', path: 'D:/PixelSky-cloud' },
      { index: 2, name: 'docs', path: 'E:\\docs' },
    ])
  })

  it('单文件夹项目没有', () => {
    expect(projectFolders({ path: 'D:/PixelSky' })).toEqual([])
    expect(projectFolders({ path: 'D:/PixelSky', folders: [] })).toEqual([])
  })
})

describe('已归档先列几个', () => {
  const archived = Array.from({ length: 120 }, (_, i) => ({ id: `a${i}` }))
  it('不超过上限全列', () => {
    expect(visibleArchived(archived.slice(0, 10), ARCHIVED_PAGE, null)).toEqual({
      shown: archived.slice(0, 10),
      hidden: 0,
    })
  })
  it('超过上限只列前 limit 个，点「还有 N 个」后上限加一页', () => {
    expect(visibleArchived(archived, ARCHIVED_PAGE, null)).toEqual({
      shown: archived.slice(0, ARCHIVED_PAGE),
      hidden: 120 - ARCHIVED_PAGE,
    })
    expect(visibleArchived(archived, ARCHIVED_PAGE * 3, null).hidden).toBe(0)
  })
  it('当前打开的归档会话在后面也列出来', () => {
    const { shown, hidden } = visibleArchived(archived, ARCHIVED_PAGE, 'a99')
    expect(shown.at(-1)?.id).toBe('a99')
    expect(hidden).toBe(120 - ARCHIVED_PAGE - 1)
  })
})

describe('频道的会话收成一行（sidebar-channel-fold.md）', () => {
  const none = new Map<string, SessionLane>()
  // 5 个频道成员都在最前面（刚刚活动），后面 6 个项目自己的对话
  const members = ['m1', 'm2', 'm3', 'm4', 'm5'].map(id => session(id))
  const own = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'].map(id => session(id))
  const channelOf = (id: string) => (id.startsWith('m') ? 'MV制作' : null)

  it('同一频道 2 个以上收成一行，放在最近那个的位置；「先列 5 个」只算项目自己的', () => {
    const {
      entries,
      hidden,
      own: count,
    } = foldChannels([...members, ...own], {
      channelOf,
      all: false,
      selected: null,
      lanes: none,
    })
    expect(entries.map(e => (e.kind === 'channel' ? `#${e.name}:${e.sessions.length}` : e.session.id))).toEqual([
      '#MV制作:5',
      'o1',
      'o2',
      'o3',
      'o4',
      'o5',
    ])
    expect([hidden, count]).toEqual([1, 6])
  })

  it('频道只有 1 个会话时照常一行；频道行带在跑、等你的数目', () => {
    const lanes = new Map<string, SessionLane>([
      ['m1', 'running'],
      ['m2', 'waiting'],
    ])
    const { entries } = foldChannels([session('m1', 'running'), session('m2'), session('x')], {
      channelOf: id => (id === 'x' ? '别的频道' : channelOf(id)),
      all: false,
      selected: null,
      lanes,
    })
    expect(entries[0]).toMatchObject({ kind: 'channel', running: 1, waiting: 1 })
    expect(entries[1]).toMatchObject({ kind: 'session', session: { id: 'x' } })
  })

  it('不收（筛选时传 channelOf 返回 null）就和原来一样', () => {
    const { entries, hidden } = foldChannels([...members, ...own], {
      channelOf: () => null,
      all: false,
      selected: null,
      lanes: none,
    })
    expect(entries).toHaveLength(5)
    expect(hidden).toBe(6)
  })
})
