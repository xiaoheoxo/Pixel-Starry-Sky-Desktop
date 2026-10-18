import { describe, expect, it } from 'vitest'
import type { SessionRecord } from '@pixelsky/protocol'
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
