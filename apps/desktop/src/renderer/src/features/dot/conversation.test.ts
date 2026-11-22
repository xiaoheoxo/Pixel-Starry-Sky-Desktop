import { describe, expect, it } from 'vitest'
import {
  dotComposerState,
  dotEventHasNewMessage,
  dotReplyDisplay,
  dotGuidanceTurn,
  dotHistoryUpdate,
  dotNotice,
  dotReadReceiptRow,
  mergeDotReadReceipt,
  dotTranscript,
  markDotRows,
  mergeDotHistory,
  placeDotTasks,
  readDropped,
} from './conversation'
import type { QueuedMessage, SessionSnapshot } from '@pixelsky/protocol'
import { translateMessage } from '../../../../shared/i18n/translate'
describe('Dot native conversation', () => {
  it('puts a read receipt on the newest confirmed outgoing message reached by the Dot cursor', () => {
    const history = [
      { id: 'older', role: 'user' as const, text: 'one', createdAt: 10, attachments: [] },
      { id: 'read', requestId: 'local-request', role: 'user' as const, text: 'two', createdAt: 20, attachments: [] },
      { id: 'assistant', role: 'assistant' as const, text: 'reply', createdAt: 25, attachments: [] },
      { id: 'pending', role: 'user' as const, text: 'three', createdAt: 30, attachments: [] },
    ]
    const rows = dotTranscript(history, [
      { id: 'optimistic', kind: 'user', text: 'not echoed', createdAt: 23, files: [] },
    ])
    expect(dotReadReceiptRow(rows, undefined)).toBeUndefined()
    expect(dotReadReceiptRow(rows, { readThroughAt: 9 })).toBeUndefined()
    expect(dotReadReceiptRow(rows, { readThroughAt: 25, updatedAt: 27 })).toBe('local-request')
    expect(dotReadReceiptRow(rows, { readThroughAt: 30 })).toBe('dot-pending')
  })

  it('keeps the highest confirmed read cursor and enriches it with a later native timestamp', () => {
    const cursor = { readThroughAt: 20 }
    expect(mergeDotReadReceipt(cursor, undefined)).toBe(cursor)
    expect(mergeDotReadReceipt(cursor, { readThroughAt: 19, updatedAt: 29 })).toBe(cursor)
    expect(mergeDotReadReceipt(cursor, { readThroughAt: 20, updatedAt: 21 })).toEqual({
      readThroughAt: 20,
      updatedAt: 21,
    })
  })

  it('deduplicates native request echoes and local Dot responses while preserving history order', () => {
    const history = [
      { id: 'old', role: 'assistant' as const, text: 'Earlier', createdAt: 1, attachments: [] },
      {
        id: 'user-native',
        requestId: 'local-user',
        role: 'user' as const,
        text: 'Hello',
        createdAt: 20,
        attachments: [],
      },
      { id: 'reply', role: 'assistant' as const, text: 'World', createdAt: 30, attachments: [] },
    ]
    const rows = dotTranscript(history, [
      { kind: 'user', id: 'local-user', text: 'Hello', createdAt: 19 },
      { kind: 'assistant', id: 'dot-reply', text: 'World', status: 'completed' },
      { kind: 'notice', id: 'notice', text: 'Status', level: 'info' },
    ])
    expect(rows).toHaveLength(4)
    expect(rows.filter(r => r.role !== 'notice').map(r => r.text)).toEqual(['Earlier', 'Hello', 'World'])
  })
  it('merges older pages and message edits without losing already loaded items', () => {
    const item = { id: 'one', role: 'assistant' as const, text: 'Original', createdAt: 2, attachments: [] }
    expect(
      mergeDotHistory(
        [item],
        [
          { ...item, text: 'Edited' },
          { ...item, id: 'earlier', createdAt: 1 },
        ],
      ).map(m => m.text),
    ).toEqual(['Original', 'Edited'])
  })
})

// docs/ui/dot-optimize.md §7
describe('Dot conversation details', () => {
  it('notices: the link suffix of old records is dropped so the dictionary matches; ChatGPT-only ones get a link', () => {
    const old = dotNotice('Dot needs your input in ChatGPT: https://chatgpt.com/dots/abc%20d')
    expect(old).toEqual({ text: 'Dot needs your input in ChatGPT', web: true })
    expect(translateMessage(old.text, 'zh-CN')).toBe('Dot 需要你输入')
    for (const text of [
      'View the Dot attachment in ChatGPT',
      'Dot workflow needs your input in ChatGPT',
      'Dot workflow status unavailable. Review it in ChatGPT',
    ]) {
      expect(dotNotice(text).web).toBe(true)
      expect(translateMessage(text, 'zh-CN')).not.toBe(text)
    }
    expect(dotNotice('Status')).toEqual({ text: 'Status', web: false })
    expect(translateMessage('Dot network request failed', 'zh-CN')).toBe('连不上 ChatGPT，请检查网络后重试')
    expect(translateMessage('Dot delivery unknown; check ChatGPT before resending', 'zh-CN')).toContain('核对')
  })
  it('task cards go under the message that started them; unknown or unloaded ones go last', () => {
    const rows = [{ id: 'dot-a' }, { id: 'dot-b' }]
    const tasks = [
      { id: 't1', toolUseId: 'dot-b' },
      { id: 't2', toolUseId: null },
      { id: 't3', toolUseId: 'dot-gone' },
      { id: 't4', toolUseId: 'dot-b' },
    ]
    const placed = placeDotTasks(rows, tasks)
    expect(placed.under.get('dot-b')?.map(t => t.id)).toEqual(['t1', 't4'])
    expect(placed.under.has('dot-a')).toBe(false)
    expect(placed.rest.map(t => t.id)).toEqual(['t2', 't3'])
  })
  it('dropped files: a local path is passed as is, content only when there is no path, 20 MiB limit', async () => {
    const file = (name: string, text: string, size?: number) =>
      ({ name, size: size ?? text.length, arrayBuffer: async () => new TextEncoder().encode(text).buffer }) as File
    const paths: Record<string, string> = { 'a.txt': 'C:\\docs\\a.txt' }
    const pathOf = (f: File) => paths[f.name] ?? ''
    expect(await readDropped([file('a.txt', 'x'), file('image.png', 'png!')], pathOf)).toEqual([
      { path: 'C:\\docs\\a.txt' },
      { name: 'image.png', dataBase64: btoa('png!') },
    ])
    await expect(readDropped([file('big.bin', '', 20 * 1024 * 1024 + 1)], pathOf)).rejects.toThrow('exceeds 20 MiB')
  })
  it('marks where a new day starts and where a run of Dot replies begins', () => {
    const at = (day: number, h: number, m: number) => new Date(2026, 10, day, h, m).getTime()
    const row = (id: string, role: 'user' | 'assistant' | 'notice', createdAt: number) => ({
      id,
      role,
      text: id,
      createdAt,
      attachments: [],
    })
    const marks = markDotRows([
      // 没有时间的本地提示行（排序序号）：不写日期也不写时间
      row('note', 'notice', 1),
      row('u1', 'user', at(17, 21, 14)),
      row('a1', 'assistant', at(17, 21, 14)),
      row('note2', 'notice', at(17, 21, 15)),
      // 中间夹着提示行，还是同一组
      row('a2', 'assistant', at(17, 21, 16)),
      // 隔了 5 分钟以上：再写一次名字
      row('a3', 'assistant', at(17, 21, 30)),
      // 换了一天：写日期，名字也再写一次
      row('a4', 'assistant', at(18, 9, 2)),
      row('a5', 'assistant', at(18, 9, 3)),
      row('u2', 'user', at(18, 9, 5)),
    ])
    const day17 = new Date(2026, 10, 17).getTime()
    const day18 = new Date(2026, 10, 18).getTime()
    expect(marks.get('note')).toEqual({ day: null, head: false, time: null })
    expect(marks.get('u1')).toEqual({ day: day17, head: false, time: at(17, 21, 14) })
    expect(marks.get('a1')).toMatchObject({ day: null, head: true })
    expect(marks.get('a2')).toMatchObject({ day: null, head: false })
    expect(marks.get('a3')).toMatchObject({ day: null, head: true })
    expect(marks.get('a4')).toMatchObject({ day: day18, head: true })
    expect(marks.get('a5')).toMatchObject({ day: null, head: false })
    expect(marks.get('u2')).toMatchObject({ day: null, head: false, time: at(18, 9, 5) })
  })
})

// docs/ui/dot-optimize.md §9：Dot 回完话还在忙时也能发，消息排队、忙完自动发出
describe('dotComposerState', () => {
  const q = (status: QueuedMessage['status']) => ({ id: status, text: status, status }) as QueuedMessage
  const snap = (state: SessionSnapshot['state'], queue: QueuedMessage[] = []) => ({ state, queue })
  const idle = { sending: false, resolving: false }

  it('Dot 正在回复时不锁发送，排队的消息单独列出', () => {
    const s = dotComposerState(snap('running', [q('running'), q('queued')]), idle)
    expect(s.busy).toBe(false)
    expect(s.replying).toBe(true)
    expect(s.queued.map(x => x.id)).toEqual(['queued'])
  })

  it('只有排队的消息、没有在跑的一轮（队列暂停）：不显示「正在回复」', () => {
    expect(dotComposerState(snap('idle', [q('queued')]), idle)).toMatchObject({ busy: false, replying: false })
  })

  it('有待核对的消息要先处理：不能发，也不显示「正在回复」', () => {
    expect(dotComposerState(snap('idle', [q('uncertain')]), idle)).toMatchObject({ busy: true, replying: false })
  })

  it('没读到会话、正在发这一下、正在核对：不能发', () => {
    expect(dotComposerState(null, idle).busy).toBe(true)
    expect(dotComposerState(snap('idle'), { sending: true, resolving: false })).toMatchObject({
      busy: true,
      replying: true,
    })
    expect(dotComposerState(snap('idle'), { sending: false, resolving: true }).busy).toBe(true)
    expect(dotComposerState(snap('idle'), idle)).toMatchObject({ busy: false, replying: false })
  })
})

describe('dotGuidanceTurn', () => {
  const snap = {
    state: 'running' as const,
    turnId: 'current-turn',
    flags: { steerAvailable: true } as SessionSnapshot['flags'],
    queue: [],
  }
  it('targets only the current ready turn', () => {
    expect(dotGuidanceTurn(snap)).toBe('current-turn')
    expect(dotGuidanceTurn({ ...snap, state: 'idle' })).toBeNull()
    expect(dotGuidanceTurn({ ...snap, flags: { ...snap.flags, steerAvailable: false } })).toBeNull()
    expect(dotGuidanceTurn(null)).toBeNull()
  })
  it.each(['delivering', 'uncertain'] as const)('blocks guidance while another message is %s', status => {
    expect(dotGuidanceTurn({ ...snap, queue: [{ status } as QueuedMessage] })).toBeNull()
  })
})

it('rebases history and its older button after the newest cursor is rejected', () => {
  const row = (id: string, createdAt: number) => ({
    id,
    role: 'assistant' as const,
    text: id,
    createdAt,
    attachments: [],
  })
  const replacement = { reset: true as const, before: 'gap', latest: 'new', items: [row('new', 3)] }
  const update = dotHistoryUpdate(replacement, undefined, true)
  expect(update.replaceBefore).toBe(true)
  expect(update.merge([row('old', 1)])).toEqual(replacement.items)
  const older = dotHistoryUpdate({ before: null, items: [row('missed', 2)] }, 'gap', true)
  expect(older.merge(replacement.items).map(m => m.id)).toEqual(['missed', 'new'])
  expect(dotHistoryUpdate({ before: null, items: [] }, undefined, true).replaceBefore).toBe(false)
})

it('shows unanswered at one minute only after acknowledged delivery and clears on reply', () => {
  expect(dotReplyDisplay(true, undefined, 120_000)).toBe('working')
  expect(dotReplyDisplay(true, 10_000, 69_999)).toBe('working')
  expect(dotReplyDisplay(true, 10_000, 70_000)).toBe('unanswered')
  expect(dotReplyDisplay(true, undefined, 70_000)).toBe('working')
  expect(dotReplyDisplay(false, 10_000, 70_000)).toBe('none')
})

it('refreshes canonical room history for replies and attachment notices, not workflow status events', () => {
  expect(
    dotEventHasNewMessage({
      type: 'item_completed',
      item: { id: 'dot-m1', kind: 'assistant', text: 'ready', status: 'completed' },
    }),
  ).toBe(true)
  expect(
    dotEventHasNewMessage({
      type: 'item_completed',
      item: { id: 'dot-attachment-m2', kind: 'notice', text: 'file', level: 'info' },
    }),
  ).toBe(true)
  expect(dotEventHasNewMessage({ type: 'runs', runs: { workflows: [], agents: [] } })).toBe(false)
  expect(
    dotEventHasNewMessage({
      type: 'item_completed',
      item: { id: 'dot-watch-task', kind: 'notice', text: 'slow', level: 'warn' },
    }),
  ).toBe(false)
})

it('anchors a locally delivered reply to the matching server echo even if the local clock differs', () => {
  const rows = dotTranscript(
    [
      { id: 'request', requestId: 'u', role: 'user', text: 'Question', createdAt: 100, attachments: [] },
      { id: 'later', role: 'assistant', text: 'Later', createdAt: 150, attachments: [] },
    ],
    [
      { id: 'u', kind: 'user', text: 'Question', createdAt: 1000 },
      { id: 'dot-early', kind: 'assistant', text: 'First reply', status: 'completed' },
    ],
  )
  expect(rows.map(row => row.text)).toEqual(['Question', 'First reply', 'Later'])
})

it('keeps a local follow-up after the matching native reply while history catches up', () => {
  const rows = dotTranscript(
    [
      { id: 'echo', requestId: 'user', role: 'user', text: 'Question', createdAt: 100, attachments: [] },
      { id: 'first', role: 'assistant', text: 'First reply', createdAt: 130, attachments: [] },
    ],
    [
      { id: 'user', kind: 'user', text: 'Question', createdAt: 100 },
      { id: 'dot-first', kind: 'assistant', text: 'First reply', status: 'completed' },
      { id: 'dot-second', kind: 'assistant', text: 'Second reply', status: 'completed' },
    ],
  )
  expect(rows.map(row => row.text)).toEqual(['Question', 'First reply', 'Second reply'])
})
