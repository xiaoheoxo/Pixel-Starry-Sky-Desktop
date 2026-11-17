import { describe, expect, it } from 'vitest'
import type { Item, SessionRecord } from '@pixelsky/protocol'
import { ENGINE_OPS, mobileChangeNotice, type EngineOpContext } from './ops'

const record = {
  id: 's1',
  permissionMode: 'ask',
  model: null,
  effort: 'low',
  thinkingSummaries: false,
} as unknown as SessionRecord

describe('mobileChangeNotice', () => {
  it('names only what really changed', () => {
    expect(mobileChangeNotice(record, { permissionMode: 'edits' })).toBe('手机把模式改成了「自动改文件」')
    expect(mobileChangeNotice(record, { permissionMode: 'plan', model: 'opus', effort: 'low' })).toBe(
      '手机把模式改成了「只规划」，把模型改成了「opus」',
    )
    expect(mobileChangeNotice({ ...record, model: 'opus' }, { model: null, thinkingSummaries: true })).toBe(
      '手机把模型改成了「引擎默认」，把思考摘要改成了「开」',
    )
    expect(mobileChangeNotice(record, { permissionMode: 'ask', effort: 'low' })).toBeNull()
    expect(mobileChangeNotice(null, { effort: 'high' })).toBe('手机把强度改成了「high」')
    expect(mobileChangeNotice(record, { fast: true })).toBe('手机把快速模式改成了「开」')
    // 换了额度来源：网关给的说法放在最前面（docs/mobile-app.md §14.4）
    expect(
      mobileChangeNotice(
        record,
        { platform: { groupId: '34', account: 'a@b.c' }, provider: null, model: 'gpt-6' },
        '平台 · 便宜线路',
      ),
    ).toBe('手机把额度来源改成了「平台 · 便宜线路」，把模型改成了「gpt-6」')
  })
})

describe('engine:updateSession', () => {
  function context() {
    const calls: unknown[][] = []
    const c = {
      host: {
        record: () => record,
        update: async (id: string, patch: unknown) => (calls.push(['update', id, patch]), record),
        addNotice: (id: string, level: string, text: string) => calls.push(['notice', id, level, text]),
      },
    } as unknown as EngineOpContext
    return { c, calls }
  }

  it('leaves a visible (not info) notice in the session when the phone changed it', async () => {
    const { c, calls } = context()
    await ENGINE_OPS['engine:updateSession'](c, 's1', { permissionMode: 'edits' }, 'mobile')
    expect(calls).toEqual([
      ['update', 's1', { permissionMode: 'edits' }],
      ['notice', 's1', 'warn', '手机把模式改成了「自动改文件」'],
    ])
  })

  it('leaves no notice for the desktop window, for a phone change that changes nothing, or for an unknown via', async () => {
    const { c, calls } = context()
    await ENGINE_OPS['engine:updateSession'](c, 's1', { permissionMode: 'edits' })
    await ENGINE_OPS['engine:updateSession'](c, 's1', { permissionMode: 'ask' }, 'mobile')
    await ENGINE_OPS['engine:updateSession'](c, 's1', { permissionMode: 'edits' }, '手机改了')
    expect(calls.filter(call => call[0] === 'notice')).toEqual([])
  })
})

describe('engine:answer', () => {
  // 手机批准计划：原来完全放行的回到自动改文件（docs/ui/plan-mode-split.md §3）
  function context(planReturn: SessionRecord['planReturn'], kind = 'plan') {
    const calls: unknown[][] = []
    const c = {
      host: {
        record: () => ({ ...record, permissionMode: 'plan', planReturn }),
        open: () => ({ pending: [{ requestId: 'r1', kind }] }),
        update: async (id: string, patch: unknown) => (calls.push(['update', id, patch]), record),
        answer: (id: string, rid: string, d: unknown) => calls.push(['answer', id, rid, d]),
      },
    } as unknown as EngineOpContext
    return { c, calls }
  }
  const allow = { type: 'allow' }

  it('phone approving a plan that returns to full access returns to edits instead', async () => {
    const { c, calls } = context('full')
    await ENGINE_OPS['engine:answer'](c, 's1', 'r1', allow, 'mobile')
    expect(calls).toEqual([
      ['update', 's1', { planReturn: 'edits' }],
      ['answer', 's1', 'r1', allow],
    ])
  })

  it('leaves the desktop, a refusal, other cards and other return levels alone', async () => {
    const cases: [ReturnType<typeof context>, unknown, unknown][] = [
      [context('full'), allow, undefined],
      [context('full'), { type: 'deny' }, 'mobile'],
      [context('full', 'command'), allow, 'mobile'],
      [context('edits'), allow, 'mobile'],
    ]
    for (const [ctx, decision, via] of cases) {
      await ENGINE_OPS['engine:answer'](ctx.c, 's1', 'r1', decision, via)
      expect(ctx.calls.map(call => call[0])).toEqual(['answer'])
    }
  })
})

describe('engine:moveQueued', () => {
  function context() {
    const calls: unknown[][] = []
    const c = { host: { moveQueued: (...args: unknown[]) => calls.push(args) } } as unknown as EngineOpContext
    return { c, calls }
  }

  it('passes { before } (a message id or null) through, and still accepts the legacy index', async () => {
    const { c, calls } = context()
    await ENGINE_OPS['engine:moveQueued'](c, 's1', 'q1', { before: 'q2' })
    await ENGINE_OPS['engine:moveQueued'](c, 's1', 'q1', { before: null })
    await ENGINE_OPS['engine:moveQueued'](c, 's1', 'q1', 2)
    expect(calls).toEqual([
      ['s1', 'q1', { before: 'q2' }],
      ['s1', 'q1', { before: null }],
      ['s1', 'q1', 2],
    ])
  })

  it('rejects a malformed anchor instead of moving the message somewhere else', () => {
    const { c, calls } = context()
    expect(() => ENGINE_OPS['engine:moveQueued'](c, 's1', 'q1', { before: 3 })).toThrow()
    expect(() => ENGINE_OPS['engine:moveQueued'](c, 's1', 'q1', { before: '' })).toThrow()
    for (const junk of ['junk', {}, { index: 2 }, undefined, null, NaN, [], { before: undefined }])
      expect(() => ENGINE_OPS['engine:moveQueued'](c, 's1', 'q1', junk)).toThrow()
    expect(calls).toEqual([])
  })
})

describe('engine:image / engine:itemDetail', () => {
  // 只走 host.item（补过图片数据的一条，没载入的会话不载入），不打开整份快照
  function context() {
    const calls: unknown[][] = []
    const user = {
      kind: 'user',
      id: 'u1',
      text: 'hi',
      attachments: [
        { id: 'a', name: 'a.png', mediaType: 'image/png', bytes: 3, width: 1, height: 1, dataBase64: 'QUJD' },
      ],
    } as Item
    const c = {
      host: {
        item: (id: string, itemId: string) => (calls.push([id, itemId]), itemId === 'u1' ? user : null),
        open: () => {
          throw new Error('不该打开整份快照')
        },
      },
    } as unknown as EngineOpContext
    return { c, calls, user }
  }

  it('takes one item by id: the image by id or by index (phone), the detail with its images', async () => {
    const { c, calls, user } = context()
    expect(await ENGINE_OPS['engine:image'](c, 's1', 'u1', 'a')).toMatchObject({ dataBase64: 'QUJD' })
    expect(await ENGINE_OPS['engine:image'](c, 's1', 'u1', 0)).toMatchObject({ id: 'a' })
    expect(await ENGINE_OPS['engine:image'](c, 's1', 'missing', 'a')).toBeNull()
    expect(await ENGINE_OPS['engine:itemDetail'](c, 's1', 'u1')).toEqual({ item: user, truncated: false })
    expect(await ENGINE_OPS['engine:itemDetail'](c, 's1', 'missing')).toBeNull()
    expect(calls).toEqual([
      ['s1', 'u1'],
      ['s1', 'u1'],
      ['s1', 'missing'],
      ['s1', 'u1'],
      ['s1', 'missing'],
    ])
  })

  it('engine:item gives the full item from host.item without image data', async () => {
    const { c, calls, user } = context()
    const item = (await ENGINE_OPS['engine:item'](c, 's1', 'u1')) as Item
    expect(item).toEqual({
      ...user,
      attachments: [{ ...(user as { attachments: object[] }).attachments[0], dataBase64: '' }],
    })
    expect(user).toMatchObject({ attachments: [{ dataBase64: 'QUJD' }] })
    expect(await ENGINE_OPS['engine:item'](c, 's1', 'missing')).toBeNull()
    await expect(async () => ENGINE_OPS['engine:item'](c, 's1', 3)).rejects.toThrow()
    expect(calls).toEqual([
      ['s1', 'u1'],
      ['s1', 'missing'],
    ])
  })
})

describe('engine:openSession / engine:openSessionTail', () => {
  // 先等 host.prepare 分块读完条目，再同步取快照（大对话第一次打开不卡主进程）
  it('waits for host.prepare before taking the snapshot', async () => {
    const calls: string[] = []
    const done: (() => void)[] = []
    const opened = { snapshot: { items: [] }, seq: 3 }
    const c = {
      host: {
        prepare: (id: string) => (calls.push(`prepare ${id}`), new Promise<void>(r => done.push(r))),
        openSession: (id: string) => (calls.push(`open ${id}`), opened),
      },
    } as unknown as EngineOpContext
    const session = ENGINE_OPS['engine:openSession'](c, 's1')
    const tail = ENGINE_OPS['engine:openSessionTail'](c, 's2', { limit: 5 })
    await Promise.resolve()
    expect(calls).toEqual(['prepare s1', 'prepare s2'])
    done.forEach(r => r())
    expect(await session).toBe(opened)
    expect(await tail).toMatchObject({ seq: 3, total: 0 })
    expect(calls).toEqual(['prepare s1', 'prepare s2', 'open s1', 'open s2'])
    await expect(async () => ENGINE_OPS['engine:openSession'](c, 3)).rejects.toThrow()
  })
})
