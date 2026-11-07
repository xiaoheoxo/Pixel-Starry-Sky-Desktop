// 每轮的过程收成「执行」一行（docs/ui/conversation-concise.md §3）
import { describe, expect, it } from 'vitest'
import type { Item } from './types'
import { foldTurns, summarizeProcess, turnReplies, type TurnEntry } from './turnFold'

const user = (id: string, mode?: 'guidance'): Item => ({ kind: 'user', id, text: id, createdAt: 0, mode })
const say = (id: string, status: 'completed' | 'running' | 'interrupted' = 'completed'): Item => ({
  kind: 'assistant',
  id,
  text: id,
  status,
})
const think = (id: string): Item => ({ kind: 'reasoning', id, text: id, status: 'completed' })
const run = (id: string, status: 'completed' | 'failed' | 'running' = 'completed'): Item => ({
  kind: 'command',
  id,
  command: id,
  description: null,
  output: '',
  exitCode: 0,
  status,
})
const read = (id: string): Item => ({
  kind: 'tool',
  id,
  tool: 'read',
  name: 'Read',
  title: id,
  output: '',
  status: 'completed',
})
const edit = (id: string, path: string): Item => ({
  kind: 'file_change',
  id,
  changes: [{ path, kind: 'update', diff: '', added: 1, removed: 0 }],
  status: 'completed',
})
const notice = (id: string, level: 'info' | 'warn' | 'error'): Item => ({ kind: 'notice', id, level, text: id })
const stats = (id: string): Item => ({
  kind: 'turn_stats',
  id,
  turnId: id,
  outcome: 'completed',
  usage: { durationMs: 1234, models: {} },
})

/** 显示顺序：条目写 id，执行块写 [里面的 id] */
const shape = (entries: TurnEntry[]): (string | string[])[] =>
  entries.map(e => (e.type === 'item' ? e.item.id : e.items.map(i => i.id)))

describe('每轮的过程收成执行块', () => {
  it('思考、工具、过渡话收进去；最后的回复、统计行一直显示；执行块带上这一轮的用时', () => {
    const entries = foldTurns([user('u1'), think('r'), say('a1'), read('t1'), run('c1'), say('a2'), stats('s')], false)
    expect(shape(entries)).toEqual(['u1', ['r', 'a1', 't1', 'c1'], 'a2', 's'])
    expect(entries[1]).toMatchObject({ running: false, durationMs: 1234 })
  })

  it('引导、警告和错误按发生的先后显示，执行块在那里断开；信息提示收进去；用时放在最后一段', () => {
    const entries = foldTurns(
      [
        user('u1'),
        run('c1'),
        user('g', 'guidance'),
        notice('i', 'info'),
        run('c2'),
        notice('e', 'error'),
        say('a'),
        stats('s'),
      ],
      false,
    )
    expect(shape(entries)).toEqual(['u1', ['c1'], 'g', ['i', 'c2'], 'e', 'a', 's'])
    expect(entries.filter(e => e.type === 'process').map(e => e.type === 'process' && e.durationMs)).toEqual([
      null,
      1234,
    ])
    // 被打断后只剩一条思考：照原样显示
    expect(shape(foldTurns([user('u1'), think('r'), user('g', 'guidance'), run('c1'), say('a')], false))).toEqual([
      'u1',
      'r',
      'g',
      ['c1'],
      'a',
    ])
  })

  it('运行中：正在输出、前面已有过程的文字留在执行块里，结束后才出来；没有过程的照常在外面', () => {
    expect(shape(foldTurns([user('u1'), say('a1'), run('c1', 'running')], true))).toEqual(['u1', ['a1', 'c1']])
    const streaming = foldTurns([user('u1'), run('c1'), say('a2', 'running')], true)
    expect(shape(streaming)).toEqual(['u1', ['c1', 'a2']])
    expect(streaming[1]).toMatchObject({ running: true })
    expect(shape(foldTurns([user('u1'), run('c1'), say('a2')], false))).toEqual(['u1', ['c1'], 'a2'])
    expect(shape(foldTurns([user('u1'), say('a', 'running')], true))).toEqual(['u1', 'a'])
    // 一段话已经说完、下一个工具调用还没到：仍留在执行块里，不先跳到外面再跳回去
    const between = foldTurns([user('u1'), run('c1'), say('a2')], true)
    expect(shape(between)).toEqual(['u1', ['c1', 'a2']])
    expect(between[1]).toMatchObject({ running: true })
    // 这一轮有了统计行就算结束：回复显示在外面
    expect(shape(foldTurns([user('u1'), run('c1'), say('a2'), stats('s')], true))).toEqual(['u1', ['c1'], 'a2', 's'])
    // 只有最后一轮算运行中
    const two = foldTurns([user('u1'), run('c1'), say('a'), user('u2'), run('c2', 'running')], true)
    expect(two.filter(e => e.type === 'process').map(e => e.type === 'process' && e.running)).toEqual([false, true])
  })

  it('回复后面只有思考、信息提示或空白文字时，回复仍然显示在外面', () => {
    const blank: Item = { kind: 'assistant', id: 'b', text: '\n\n', status: 'completed' }
    const entries = foldTurns(
      [user('u1'), think('r1'), run('c1'), say('a'), think('r2'), notice('i', 'info'), blank, stats('s')],
      false,
    )
    expect(shape(entries)).toEqual(['u1', ['r1', 'c1', 'r2', 'i', 'b'], 'a', 's'])
    // 回复后面又调了工具：回复是过渡话
    expect(shape(foldTurns([user('u1'), run('c1'), say('a'), think('r'), run('c2')], false))).toEqual([
      'u1',
      ['c1', 'a', 'r', 'c2'],
    ])
  })

  it('统计行之后引擎自己接着干的活（后台任务通知）另算一段，前一轮的回答留在外面', () => {
    const entries = foldTurns(
      [
        user('u1'),
        run('c1'),
        say('answer'),
        stats('s'),
        notice('bg', 'info'),
        think('r'),
        say('cleaning'),
        run('c2'),
        run('c3'),
        say('done'),
        user('u2'),
      ],
      false,
    )
    expect(shape(entries)).toEqual(['u1', ['c1'], 'answer', 's', ['bg', 'r', 'cleaning', 'c2', 'c3'], 'done', 'u2'])
    // 后续那段没有自己的统计行：执行块不带用时；会话还在跑时它算运行中
    expect(entries[4]).toMatchObject({ durationMs: null })
    const live = foldTurns([user('u1'), run('c1'), say('answer'), stats('s'), run('c2', 'running')], true)
    expect(shape(live)).toEqual(['u1', ['c1'], 'answer', 's', ['c2']])
    expect(live.filter(e => e.type === 'process').map(e => e.type === 'process' && e.running)).toEqual([false, true])
    // 统计行后面只有一条提示：照原样显示
    expect(shape(foldTurns([user('u1'), run('c1'), say('a'), stats('s'), notice('w', 'warn')], false))).toEqual([
      'u1',
      ['c1'],
      'a',
      's',
      'w',
    ])
  })

  it('只有一段思考或一条提示、没有工具调用时照原样显示；中断的回复算最后的回复', () => {
    expect(shape(foldTurns([user('u1'), think('r'), say('a')], false))).toEqual(['u1', 'r', 'a'])
    expect(shape(foldTurns([user('u1'), run('c1'), say('a', 'interrupted')], false))).toEqual(['u1', ['c1'], 'a'])
    expect(shape(foldTurns([user('u1'), notice('e', 'error'), stats('s')], false))).toEqual(['u1', 'e', 's'])
  })
})

describe('每轮「复制」的回复', () => {
  it('取显示在外面的最后回复；以工具调用结尾的一轮没有回复，不拿过渡话；后续那段有自己的', () => {
    const map = turnReplies([
      user('u1'),
      say('过渡'),
      run('c1'),
      say('答案'),
      stats('s1'),
      user('u2'),
      say('先看看'),
      run('c2'),
      stats('s2'),
      notice('bg', 'info'),
      run('c3'),
      say('清理完了'),
      stats('s3'),
    ])
    expect(Object.fromEntries(map)).toEqual({ s1: '答案', s3: '清理完了' })
  })
})

describe('执行行的概要', () => {
  it('按类数，同一个文件算一次，失败的单独数', () => {
    expect(
      summarizeProcess([
        run('c1'),
        run('c2', 'failed'),
        read('t1'),
        edit('f1', 'a.ts'),
        edit('f2', 'a.ts'),
        edit('f3', 'b.ts'),
      ]),
    ).toMatchObject({ commands: 2, reads: 1, edits: 2, failed: 1 })
  })

  it('审查超时、被拦下的没执行，不算失败', () => {
    const timedOut: Item = { ...run('c1', 'failed'), review: { status: 'timedOut' } } as Item
    const denied: Item = { ...run('c2', 'failed'), review: { status: 'denied' } } as Item
    expect(summarizeProcess([timedOut, denied, run('c3', 'failed')])).toMatchObject({ commands: 3, failed: 1 })
  })
})

// 子智能体显示成小框（docs/ui/subagent-box.md §4）
describe('子智能体：box / inline', () => {
  const agent = (id: string): Item => ({
    kind: 'tool',
    id,
    tool: 'task',
    name: 'Agent',
    title: id,
    output: '',
    status: 'running',
  })
  /** 子智能体自己调用的工具 */
  const sub = (item: Item): Item => ({ ...item, subagent: 'C1', subagentCall: 'ag1' }) as Item
  const done = (id: string): Item => ({
    kind: 'notice',
    id,
    level: 'info',
    text: id,
    task: { kind: 'agent', status: 'completed', label: id },
  })
  const box = { subagents: 'box' } as const

  it('派发是单独的小框，执行块在它前后断开', () => {
    const items = [user('u'), run('c1'), read('r1'), agent('ag1'), run('c2'), read('r2'), say('a'), stats('s')]
    expect(shape(foldTurns(items, false, box))).toEqual(['u', ['c1', 'r1'], 'ag1', ['c2', 'r2'], 'a', 's'])
    // inline：派发和别的工具一起收在执行块里（和以前完全一样）
    expect(shape(foldTurns(items, false))).toEqual(['u', ['c1', 'r1', 'ag1', 'c2', 'r2'], 'a', 's'])
    expect(shape(foldTurns(items, false, { subagents: 'inline' }))).toEqual(shape(foldTurns(items, false)))
  })

  it('连着派几个：几个小框相邻，中间没有执行块', () => {
    const items = [user('u'), agent('ag1'), agent('ag2'), agent('ag3'), say('a'), stats('s')]
    expect(shape(foldTurns(items, false, box))).toEqual(['u', 'ag1', 'ag2', 'ag3', 'a', 's'])
  })

  it('子智能体自己的工具调用不进主对话，也不计数；inline 里照旧都在', () => {
    const items = [
      user('u'),
      agent('ag1'),
      sub(run('sc1')),
      sub(edit('sf1', 'x.ts')),
      sub(read('sr1')),
      run('c1'),
      say('a'),
      stats('s'),
    ]
    const entries = foldTurns(items, false, box)
    expect(shape(entries)).toEqual(['u', 'ag1', ['c1'], 'a', 's'])
    const process = entries.find(e => e.type === 'process')
    expect(process?.type === 'process' && summarizeProcess(process.items)).toMatchObject({
      commands: 1,
      edits: 0,
      reads: 0,
    })
    expect(shape(foldTurns(items, false))).toEqual(['u', ['ag1', 'sc1', 'sf1', 'sr1', 'c1'], 'a', 's'])
  })

  it('只剩子智能体的工具调用的一段不出现空的执行块', () => {
    const items = [user('u'), agent('ag1'), sub(run('sc1')), sub(read('sr1')), say('a'), stats('s')]
    expect(shape(foldTurns(items, false, box))).toEqual(['u', 'ag1', 'a', 's'])
  })

  it('后台子智能体完成：带 task 的提示是完成小框，接着主智能体那一轮的回复；没有 task 的提示照旧', () => {
    const items = [
      user('u'),
      agent('ag1'),
      say('a1'),
      stats('s1'),
      done('n1'),
      run('c1'),
      say('a2'),
      stats('s2'),
      notice('old', 'info'),
      run('c2'),
      say('a3'),
      stats('s3'),
    ]
    expect(shape(foldTurns(items, false, box))).toEqual([
      'u',
      'ag1',
      'a1',
      's1',
      'n1',
      ['c1'],
      'a2',
      's2',
      ['old', 'c2'],
      'a3',
      's3',
    ])
    // inline：完成提示收在执行块里
    expect(shape(foldTurns(items, false))).toContainEqual(['n1', 'c1'])
  })

  it('运行中：小框在执行块外面，最后一段执行块才是运行中', () => {
    const entries = foldTurns([user('u'), run('c1'), agent('ag1'), run('c2', 'running')], true, box)
    expect(shape(entries)).toEqual(['u', ['c1'], 'ag1', ['c2']])
    expect(entries.filter(e => e.type === 'process').map(e => e.type === 'process' && e.running)).toEqual([false, true])
  })

  it('每轮「复制」的回复：box 下藏起来的子智能体条目不影响取到哪一段', () => {
    const items = [user('u'), say('a'), sub(run('sc1')), stats('s')]
    expect([...turnReplies(items, box)]).toEqual([['s', 'a']])
  })
})
