// 截断点在上下文压缩之前时，自己复制 Claude Code 的记录（docs/ui/rewind-fork-sidechat.md §2.4）
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearTranscriptIndexCache, leafOf, transcriptIndex } from '../src/claude/transcript-index'
import {
  anchorPosition,
  copyTranscriptUntil,
  currentLeaf,
  findRewindAnchor,
  pointLastPrompt,
  seedTranscript,
} from '../src/claude/transcript'

let dir: string
let file: string
const rows = [
  { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'old' },
  { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'old' },
  { type: 'system', subtype: 'compact_boundary', uuid: 'b1', parentUuid: null, sessionId: 'old' },
  { type: 'user', uuid: 'u2', parentUuid: 'b1', sessionId: 'old' },
]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pixelsky-transcript-'))
  file = join(dir, 'old.jsonl')
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n不是 JSON\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('Claude Code 记录的截断点', () => {
  it('最近一次压缩之前是 compacted，之后是 loaded，没有是 null', async () => {
    expect(await anchorPosition(file, 'a1')).toBe('compacted')
    expect(await anchorPosition(file, 'b1')).toBe('compacted')
    expect(await anchorPosition(file, 'u2')).toBe('loaded')
    expect(await anchorPosition(file, 'nope')).toBeNull()
  })

  it('复制到截断点为止，换成新的会话 id；已有同名记录不覆盖', async () => {
    const copied = await copyTranscriptUntil(file, 'a1', 'new')
    expect(copied).toBe(join(dir, 'new.jsonl'))
    const lines = readFileSync(copied!, 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l) as Record<string, unknown>)
    expect(lines.map(l => l.uuid)).toEqual(['u1', 'a1'])
    expect(lines.every(l => l.sessionId === 'new')).toBe(true)
    await expect(copyTranscriptUntil(file, 'a1', 'new')).rejects.toThrow()
    expect(await copyTranscriptUntil(file, 'nope', 'other')).toBeNull()
  })
})

// GitHub #82：辅助进程用 --resume-session-at 读当前分支，不靠 Claude Code 退出时才写的 last-prompt
describe('当前分支的最后一条', () => {
  const write = (lines: unknown[]): void =>
    writeFileSync(file, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n')

  it('取主线上最后写进去的 user / assistant；跳过子智能体、快照、last-prompt 和写坏的行', () => {
    write([
      { type: 'user', uuid: 'u1', parentUuid: null },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1' },
      // 回退后接着聊：新分支从 a0 接出去，写在旧分支后面
      { type: 'user', uuid: 'u6', parentUuid: 'a0' },
      { type: 'assistant', uuid: 'a6', parentUuid: 'u6' },
      { type: 'assistant', uuid: 'side', parentUuid: 'a6', isSidechain: true },
      { type: 'file-history-snapshot', messageId: 'u6', snapshot: {} },
      { type: 'last-prompt', leafUuid: 'a1' },
      '{"type":"user","uuid":',
    ])
    expect(currentLeaf(file)).toBe('a6')
  })

  it('记录很大时只读末尾一段，半截的第一行不算；整段都没有消息时 null', () => {
    const big = 'x'.repeat(300 * 1024)
    write([
      { type: 'user', uuid: 'early', parentUuid: null, text: big },
      { type: 'assistant', uuid: 'leaf', parentUuid: 'early' },
      { type: 'cost-state', text: big },
    ])
    expect(currentLeaf(file)).toBe('leaf')
    write([
      { type: 'user', uuid: 'only', parentUuid: null, text: big },
      { type: 'cost-state', text: big },
    ])
    expect(currentLeaf(file)).toBe('only')
    write([{ type: 'queue-operation' }, { type: 'last-prompt', leafUuid: 'x' }])
    expect(currentLeaf(file)).toBeNull()
  })

  it('last-prompt 不是当前末端时补一条（沿用上一条的 lastPrompt），已经是就不写', () => {
    write([
      { type: 'user', uuid: 'u1', parentUuid: null },
      { type: 'assistant', uuid: 'a5', parentUuid: 'u1' },
      { type: 'last-prompt', lastPrompt: '旧的', leafUuid: 'a5', sessionId: 's' },
      { type: 'user', uuid: 'u6', parentUuid: 'u1' },
      { type: 'assistant', uuid: 'a6', parentUuid: 'u6' },
    ])
    pointLastPrompt(file, 's')
    const lines = () => readFileSync(file, 'utf8').trim().split('\n')
    expect(JSON.parse(lines().at(-1)!)).toEqual({
      type: 'last-prompt',
      lastPrompt: '旧的',
      leafUuid: 'a6',
      sessionId: 's',
    })
    const count = lines().length
    pointLastPrompt(file, 's')
    expect(lines()).toHaveLength(count)
  })
})

describe('跨引擎接力：把聊天写进 Claude Code 的记录', () => {
  const uuid = '11111111-2222-4333-8444-555555555555'
  const read = (path: string) =>
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .flatMap(l => {
        try {
          return [JSON.parse(l) as Record<string, unknown>]
        } catch {
          return []
        }
      })

  it('没有记录时新建：用户和助手交替，从头接成一条链', async () => {
    const path = await seedTranscript(
      dir,
      '/work/proj',
      'fresh',
      [
        { id: uuid, user: '问', assistant: '答' },
        { id: 'not-a-uuid', user: '再问', assistant: null },
      ],
      '（没回复）',
    )
    expect(path).toBe(join(dir, '-work-proj', 'fresh.jsonl'))
    const lines = read(path)
    expect(lines.map(l => l.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(lines[0]).toMatchObject({
      parentUuid: null,
      uuid,
      sessionId: 'fresh',
      message: { role: 'user', content: '问' },
    })
    expect(lines[1]).toMatchObject({ parentUuid: uuid, message: { content: [{ type: 'text', text: '答' }] } })
    // 不是 uuid 的条目 id 换成新的，链照样接上
    expect(lines[2].uuid).not.toBe('not-a-uuid')
    expect(lines[2].parentUuid).toBe(lines[1].uuid)
    expect(lines[3]).toMatchObject({ message: { content: [{ type: 'text', text: '（没回复）' }] } })
    // 回退时按我们的条目 id 照样找得到截断点
    expect(await findRewindAnchor(path, [uuid])).toEqual({ at: null })
    expect(currentLeaf(path)).toBe(lines[3].uuid)
  })

  it('已有记录时接在当前末端后面，并让 last-prompt 指向新末端', async () => {
    // Claude Code 的记录放在项目目录下：<projects>/<编码后的工作目录>/<会话 id>.jsonl
    const existing = join(dir, '-work-proj', 'old.jsonl')
    mkdirSync(join(dir, '-work-proj'))
    writeFileSync(existing, readFileSync(file))
    const path = await seedTranscript(dir, '/work/proj', 'old', [{ id: uuid, user: '问', assistant: '答' }], '')
    expect(path).toBe(existing)
    const lines = read(path)
    const seeded = lines.filter(l => l.sessionId === 'old' && (l.type === 'user' || l.type === 'assistant')).slice(-3)
    expect(seeded[0]).toMatchObject({ type: 'assistant', parentUuid: 'u2' })
    expect(seeded[1]).toMatchObject({ uuid, parentUuid: seeded[0].uuid })
    expect(lines.at(-1)).toMatchObject({ type: 'last-prompt', leafUuid: seeded[2].uuid })
  })

  // 失败的一轮游标不动，进程关掉后重试会把同一轮再交一次
  describe('重复交接同一轮', () => {
    const second = '66666666-2222-4333-8444-555555555555'

    it('已经接力写过的轮次不再写：uuid 不重复，父链不成环，截断点不变', async () => {
      const turns = [{ id: uuid, user: '问', assistant: '答' }]
      const path = await seedTranscript(dir, '/work/proj', 'again', turns, '')
      const before = read(path)
      await seedTranscript(dir, '/work/proj', 'again', turns, '')
      expect(read(path).filter(l => l.type !== 'last-prompt')).toEqual(before)
      expect(read(path).at(-1)).toMatchObject({ type: 'last-prompt', leafUuid: currentLeaf(path) })
      const pointed = readFileSync(path, 'utf8')
      await seedTranscript(dir, '/work/proj', 'again', turns, '')
      expect(readFileSync(path, 'utf8')).toBe(pointed)
      // 后面跟着新的一轮时只写新的那轮，接在原来的末端后面
      const leaf = currentLeaf(path)
      await seedTranscript(dir, '/work/proj', 'again', [...turns, { id: second, user: '再问', assistant: '再答' }], '')
      const users = read(path).filter(l => l.type === 'user')
      expect(users.map(u => u.uuid)).toEqual([uuid, second])
      expect(users[1].parentUuid).toBe(leaf)
      expect(await findRewindAnchor(path, [uuid])).toEqual({ at: null })
    })

    it('Claude Code 自己记过的失败消息（当前分支上）不再写', async () => {
      const existing = join(dir, '-work-proj', 'failed.jsonl')
      mkdirSync(join(dir, '-work-proj'))
      writeFileSync(
        existing,
        [
          { type: 'user', uuid: 'u0', parentUuid: null, version: '2.1.0' },
          { type: 'assistant', uuid: 'a0', parentUuid: 'u0', message: { model: 'claude' } },
          { type: 'user', uuid, parentUuid: 'a0', version: '2.1.0', message: { role: 'user', content: '问' } },
          { type: 'assistant', uuid: 'err', parentUuid: uuid, message: { model: '<synthetic>' } },
        ]
          .map(r => JSON.stringify(r))
          .join('\n') + '\n',
      )
      const before = read(existing)
      await seedTranscript(dir, '/work/proj', 'failed', [{ id: uuid, user: '问', assistant: null }], '')
      expect(read(existing).filter(l => l.type !== 'last-prompt')).toEqual(before)
      expect(read(existing).at(-1)).toMatchObject({ type: 'last-prompt', leafUuid: 'err' })
      expect(await findRewindAnchor(existing, [uuid])).toEqual({ at: 'a0' })
    })

    it('uuid 在回退掉的旧分支上：换一个新的 uuid 写', async () => {
      const existing = join(dir, '-work-proj', 'rewound.jsonl')
      mkdirSync(join(dir, '-work-proj'))
      writeFileSync(
        existing,
        [
          { type: 'user', uuid: 'u0', parentUuid: null },
          { type: 'assistant', uuid: 'a0', parentUuid: 'u0' },
          { type: 'user', uuid, parentUuid: 'a0' },
          { type: 'assistant', uuid: 'old', parentUuid: uuid },
          // 回退后从 a0 接出的新分支
          { type: 'user', uuid: 'u1', parentUuid: 'a0' },
          { type: 'assistant', uuid: 'a1', parentUuid: 'u1' },
        ]
          .map(r => JSON.stringify(r))
          .join('\n') + '\n',
      )
      await seedTranscript(dir, '/work/proj', 'rewound', [{ id: uuid, user: '问', assistant: '答' }], '')
      const seeded = read(existing)
        .filter(l => l.type === 'user')
        .at(-1)!
      expect(seeded.uuid).not.toBe(uuid)
      expect(seeded.pixelskyItemId).toBe(uuid)
      expect(seeded.parentUuid).toBe('a1')
      expect(read(existing).filter(l => l.uuid === uuid)).toHaveLength(1)
      expect(await findRewindAnchor(existing, [uuid])).toEqual({ at: 'a1' })
      clearTranscriptIndexCache()
      expect(await findRewindAnchor(existing, [uuid])).toEqual({ at: 'a1' })
      const before = readFileSync(existing, 'utf8')
      await seedTranscript(dir, '/work/proj', 'rewound', [{ id: uuid, user: '问', assistant: '答' }], '')
      expect(readFileSync(existing, 'utf8')).toBe(before)
    })

    it('跳过未回复的末端用户消息后，先补助手占位再接下一轮', async () => {
      mkdirSync(join(dir, '-work-proj'))
      const existing = join(dir, '-work-proj', 'unfinished.jsonl')
      writeFileSync(
        existing,
        [
          { type: 'user', uuid: 'u0', parentUuid: null },
          { type: 'assistant', uuid: 'a0', parentUuid: 'u0' },
          { type: 'user', uuid, parentUuid: 'a0' },
        ]
          .map(r => JSON.stringify(r))
          .join('\n') + '\n',
      )
      await seedTranscript(
        dir,
        '/work/proj',
        'unfinished',
        [
          { id: uuid, user: '未回复', assistant: null },
          { id: second, user: '下一轮', assistant: '答' },
        ],
        'NO_REPLY',
      )
      const messages = read(existing).filter(l => l.type === 'user' || l.type === 'assistant')
      expect(messages.map(l => l.type)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
      expect(messages.filter(l => l.uuid === uuid)).toHaveLength(1)
      expect(messages[3]).toMatchObject({
        parentUuid: uuid,
        message: { content: [{ type: 'text', text: 'NO_REPLY' }] },
      })
      expect(messages[4]).toMatchObject({ uuid: second, parentUuid: messages[3].uuid })
      expect(messages[5].parentUuid).toBe(second)
      expect(await findRewindAnchor(existing, [uuid])).toEqual({ at: 'a0' })
    })

    it('全部跳过时仍把旧 last-prompt 指向当前分支末端', async () => {
      mkdirSync(join(dir, '-work-proj'))
      const existing = join(dir, '-work-proj', 'stale.jsonl')
      writeFileSync(
        existing,
        [
          { type: 'user', uuid: 'u0', parentUuid: null },
          { type: 'assistant', uuid: 'a0', parentUuid: 'u0' },
          { type: 'user', uuid: 'o1', parentUuid: 'a0' },
          { type: 'assistant', uuid: 'o2', parentUuid: 'o1' },
          { type: 'last-prompt', leafUuid: 'o2', lastPrompt: '旧提示' },
          { type: 'user', uuid, parentUuid: 'a0' },
          { type: 'assistant', uuid: 'a1', parentUuid: uuid },
        ]
          .map(r => JSON.stringify(r))
          .join('\n') + '\n',
      )
      const before = read(existing)
      await seedTranscript(dir, '/work/proj', 'stale', [{ id: uuid, user: '问', assistant: '答' }], '')
      expect(read(existing).slice(0, -1)).toEqual(before)
      expect(read(existing).at(-1)).toMatchObject({ type: 'last-prompt', leafUuid: 'a1', lastPrompt: '旧提示' })
      expect(leafOf(await transcriptIndex(existing))).toBe('a1')
    })

    it('去重和续写使用与导入相同的 last-prompt 分支', async () => {
      mkdirSync(join(dir, '-work-proj'))
      const existing = join(dir, '-work-proj', 'selected.jsonl')
      writeFileSync(
        existing,
        [
          { type: 'user', uuid: 'u0', parentUuid: null },
          { type: 'assistant', uuid: 'a0', parentUuid: 'u0' },
          { type: 'user', uuid, parentUuid: 'a0' },
          { type: 'assistant', uuid: 'selected', parentUuid: uuid },
          { type: 'user', uuid: 'other', parentUuid: 'a0' },
          { type: 'assistant', uuid: 'physical-tail', parentUuid: 'other' },
          { type: 'last-prompt', leafUuid: 'selected' },
        ]
          .map(r => JSON.stringify(r))
          .join('\n') + '\n',
      )
      const before = readFileSync(existing, 'utf8')
      await seedTranscript(dir, '/work/proj', 'selected', [{ id: uuid, user: '问', assistant: '答' }], '')
      expect(readFileSync(existing, 'utf8')).toBe(before)
      await seedTranscript(
        dir,
        '/work/proj',
        'selected',
        [
          { id: uuid, user: '问', assistant: '答' },
          { id: second, user: '新问', assistant: '新答' },
        ],
        '',
      )
      expect(
        read(existing)
          .filter(l => l.type === 'user')
          .at(-1),
      ).toMatchObject({ uuid: second, parentUuid: 'selected' })
    })
  })

  describe('带图片的轮次', () => {
    const image = {
      id: 'i1',
      name: 'image.png',
      mediaType: 'image/png' as const,
      bytes: 3,
      width: 1,
      height: 1,
      dataBase64: 'AAAA',
    }
    const imageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }

    it('用户消息写成文字块加图片块的数组，没有图的轮次仍是一段文字', async () => {
      const path = await seedTranscript(
        dir,
        '/work/proj',
        'img',
        [
          { id: uuid, user: '看这个（附：image.png）', assistant: null, images: [image] },
          { id: 'plain', user: '再问', assistant: '答' },
        ],
        '（没回复）',
      )
      const lines = read(path)
      expect(lines[0]).toMatchObject({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '看这个（附：image.png）' }, imageBlock] },
      })
      expect(lines[2]).toMatchObject({ message: { role: 'user', content: '再问' } })
    })

    it('数组内容不影响回退截断点、末端和续写', async () => {
      const turns = [{ id: uuid, user: '看这个', assistant: null, images: [image] }]
      const path = await seedTranscript(dir, '/work/proj', 'img', turns, '（没回复）')
      const lines = read(path)
      expect(await findRewindAnchor(path, [uuid])).toEqual({ at: null })
      expect(currentLeaf(path)).toBe(lines[1].uuid)
      // 之后的新轮次接在末端，图片轮次的 uuid 不变
      await seedTranscript(dir, '/work/proj', 'img', [{ id: 'next', user: '后来', assistant: '嗯' }], '')
      const users = read(path).filter(l => l.type === 'user')
      expect(users).toHaveLength(2)
      expect(users[1]).toMatchObject({ parentUuid: lines[1].uuid })
      expect(await findRewindAnchor(path, [uuid, 'next'])).toEqual({ at: null })
    })
  })

  // PR #96 #10 / #11
  describe('非 UUID 的条目 id 和同一批重复的 id', () => {
    const retryId = `${uuid}-retry-33333333-3333-4333-8333-333333333333`

    it('重试出来的 id（X-retry-…）再交接一次不重复写，记录里带 pixelskyItemId', async () => {
      const turn = { id: retryId, user: '重试的一轮', assistant: null }
      const path = await seedTranscript(dir, '/work/proj', 'retry', [turn], '（没回复）')
      await seedTranscript(dir, '/work/proj', 'retry', [turn], '（没回复）')
      const users = read(path).filter(l => l.type === 'user')
      expect(users).toHaveLength(1)
      expect(users[0]).toMatchObject({ pixelskyItemId: retryId })
      expect(users[0].uuid).not.toBe(retryId)
    })

    it('同一批里 id 相同的轮次只写一次', async () => {
      const path = await seedTranscript(
        dir,
        '/work/proj',
        'dup',
        [
          { id: uuid, user: '一', assistant: '答一' },
          { id: uuid, user: '一（重复）', assistant: '答二' },
          { id: 'plain', user: '二', assistant: '答' },
          { id: 'plain', user: '二（重复）', assistant: '答' },
        ],
        '（没回复）',
      )
      const lines = read(path)
      expect(lines.filter(l => l.uuid === uuid)).toHaveLength(1)
      expect(lines.filter(l => l.type === 'user').map(l => (l.message as { content: string }).content)).toEqual([
        '一',
        '二',
      ])
    })
  })
})
