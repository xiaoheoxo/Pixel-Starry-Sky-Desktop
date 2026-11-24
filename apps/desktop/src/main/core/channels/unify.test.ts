// 频道和团队融合第 2 批（docs/ui/channels-unify.md §5.2）：共享时的派活规则、改回只有我时留的记录
import { describe, expect, it } from 'vitest'
import type { ChannelMessage } from '../../../shared/types/channels'
import {
  flowNotice,
  freeChannelName,
  sharePolicies,
  sideMirrorText,
  transcriptBlocks,
  transcriptChunks,
  transcriptHead,
} from './unify'

describe('共享时的派活规则', () => {
  it('只认这个频道里自己的成员，没列的不带进去，顺序照频道里的', () => {
    expect(sharePolicies({ b: 'team', x: 'team', a: 'owner' }, ['a', 'b', 'c'])).toEqual([
      ['a', 'owner'],
      ['b', 'team'],
    ])
  })

  it('不认识的规则、要名单的「指定的人」都按要我同意', () => {
    expect(sharePolicies({ a: 'listed', b: 'everyone', c: null }, ['a', 'b', 'c'])).toEqual([
      ['a', 'approve'],
      ['b', 'approve'],
      ['c', 'approve'],
    ])
  })

  it('传来的不是对象：一个都不带', () => {
    expect(sharePolicies(null, ['a'])).toEqual([])
    expect(sharePolicies(['a'], ['a'])).toEqual([])
    expect(sharePolicies('a', ['a'])).toEqual([])
  })

  it('原型上的名字不算列了（toString 这类）', () => {
    expect(sharePolicies({}, ['toString', 'constructor'])).toEqual([])
  })
})

describe('留在本机的记录', () => {
  const names: Record<string, string> = { 'u:1': '林夏', 'u:2': '周宁', ta_1: '接口审查' }
  const name = (id: string): string => names[id] ?? '?'
  const time = (at: number): string => `t${at}`
  const base = { channelId: 'c' }
  const messages: ChannelMessage[] = [
    { ...base, kind: 'event', id: 'e', at: 1, event: 'joined', actorId: 'u:2' } as ChannelMessage,
    { ...base, kind: 'message', id: 'm1', at: 2, authorId: 'u:2', text: ' 稿子放好了 \n', format: 'plain' },
    { ...base, kind: 'message', id: 'm0', at: 3, authorId: 'u:9', text: '   ', format: 'plain' },
    {
      ...base,
      kind: 'task',
      id: 't1',
      at: 4,
      authorId: 'u:1',
      assigneeId: 'ta_1',
      title: '审查接口',
      status: 'done',
      summary: '两处要改\n第二行',
      error: null,
    },
    {
      ...base,
      kind: 'task',
      id: 't2',
      at: 5,
      authorId: 'u:9',
      assigneeId: 'ta_1',
      title: '再看一遍',
      status: 'failed',
      error: '超时',
    },
  ]

  it('文字消息写名字、时间和原文；任务卡写谁交给谁、状态、标题和结果；事件和空消息不记', () => {
    expect(transcriptBlocks(messages, name, 'zh-CN', time)).toEqual([
      '**周宁** t2\n稿子放好了',
      '**林夏 交给 接口审查** t4 · 完成\n审查接口\n> 两处要改\n> 第二行',
      '**? 交给 接口审查** t5 · 失败\n再看一遍\n> 超时',
    ])
  })

  it('英文界面用英文的写法', () => {
    expect(transcriptBlocks(messages.slice(3, 4), name, 'en-US', time)[0]).toBe(
      '**林夏 → 接口审查** t4 · done\n审查接口\n> 两处要改\n> 第二行',
    )
    expect(transcriptHead('小队', 3, true, 'en-US')).toContain('3 messages (only the most recent')
  })

  it('开头一句写团队、条数，截断了要说', () => {
    expect(transcriptHead('小队', 31, false, 'zh-CN')).toBe('从团队「小队」收回的记录：31 条。')
    expect(transcriptHead('小队', 5000, true, 'zh-CN')).toBe('从团队「小队」收回的记录：5000 条（只留了最近的这些）。')
  })

  it('拼成几条消息：每条不超过上限，段和段之间空一行，内容一个字不少', () => {
    const blocks = ['aaaa', 'bbbb', 'cc', 'dddddddddddd', 'e']
    const chunks = transcriptChunks(blocks, 10)
    expect(chunks).toEqual(['aaaa\n\nbbbb', 'cc', 'dddddddddd', 'dd', 'e'])
    expect(chunks.every(c => c.length <= 10)).toBe(true)
    expect(chunks.join('').replace(/\n/g, '')).toBe(blocks.join(''))
    expect(transcriptChunks([], 10)).toEqual([])
  })
})

describe('本机频道不重名', () => {
  it('没被占就用原名；占了加 2、3…，比大小写不敏感', () => {
    expect(freeChannelName('评审', ['别的'])).toBe('评审')
    expect(freeChannelName('Review', ['review'])).toBe('Review 2')
    expect(freeChannelName('评审', ['评审', '评审 2'])).toBe('评审 3')
  })

  it('加了后缀也不超过长度上限', () => {
    const long = 'x'.repeat(40)
    const next = freeChannelName(long, [long])
    expect(next).toHaveLength(40)
    expect(next.endsWith(' 2')).toBe(true)
  })
})

describe('「我的协作」发到团队频道的内容（§7.2）', () => {
  it('登记了的成员原样发；没登记的开头写上成员名，放不下时截断', () => {
    expect(sideMirrorText('  写好了\n', null)).toBe('写好了')
    expect(sideMirrorText('写好了', '审查员')).toBe('**审查员**\n\n写好了')
    const long = sideMirrorText('字'.repeat(9000), '审查员')
    expect(long).toHaveLength(7901)
    expect(long.endsWith('…')).toBe(true)
  })

  const name = (id: string): string => ({ a: '前端助手', b: '审查员' })[id] ?? '?'
  const flow = (status: string, since?: unknown) => ({
    status,
    title: '发版',
    since,
    steps: [
      { title: '写日志', memberId: 'a' },
      { title: '审一遍', memberId: 'b' },
    ],
  })

  it('草稿点了开始：列出步骤和谁做', () => {
    expect(flowNotice({ status: 'draft' }, flow('running', { at: 1 }), name, 'zh-CN')).toEqual({
      kind: 'start',
      text: '开始流程「发版」（2 步）：\n1. 写日志（前端助手）\n2. 审一遍（审查员）',
    })
    expect(flowNotice({ status: 'draft' }, flow('running', { at: 1 }), name, 'en-US')?.text).toBe(
      'Started the flow “发版” (2 steps):\n1. 写日志 — 前端助手\n2. 审一遍 — 审查员',
    )
  })

  it('跑过的流程完成、停止各说一句；暂停、继续、状态没变不说', () => {
    expect(flowNotice({ status: 'running' }, flow('done', { at: 1 }), name, 'zh-CN')).toEqual({
      kind: 'done',
      text: '流程「发版」完成了。',
    })
    expect(flowNotice({ status: 'paused' }, flow('stopped', { at: 1 }), name, 'zh-CN')?.kind).toBe('stopped')
    expect(flowNotice({ status: 'running' }, flow('paused', { at: 1 }), name, 'zh-CN')).toBeNull()
    expect(flowNotice({ status: 'paused' }, flow('running', { at: 1 }), name, 'zh-CN')).toBeNull()
    expect(flowNotice({ status: 'running' }, flow('running', { at: 1 }), name, 'zh-CN')).toBeNull()
  })

  it('没开始过就停掉的（丢弃的草稿、牵头直接派走的计划）不说', () => {
    expect(flowNotice({ status: 'draft' }, flow('stopped'), name, 'zh-CN')).toBeNull()
    expect(flowNotice({ status: 'planning' }, flow('stopped', null), name, 'zh-CN')).toBeNull()
  })
})
