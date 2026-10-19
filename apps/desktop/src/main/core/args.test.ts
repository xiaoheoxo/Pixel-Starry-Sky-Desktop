import { describe, expect, it } from 'vitest'
import { artifactRef, engineConfigPatch, engineId, int, mcpOp, str, usageListQuery, usageQuery, value } from './args'

describe('shared argument checks', () => {
  it('accepts only non-empty strings as ids', () => {
    expect(str('a', 'id')).toBe('a')
    expect(() => str('', 'id')).toThrow('参数 id 不对')
    expect(() => str(1, 'queueId')).toThrow('参数 queueId 不对')
    expect(value('  x  ')).toBe('x')
    expect(() => value('a\0b')).toThrow('参数不正确')
    expect(() => value('   ', 10, true)).toThrow('内容不能为空')
  })

  it('clamps integers and knows the engines', () => {
    expect(int(3.7, 0, 10)).toBe(3)
    expect(int(-5, 0, 10)).toBe(0)
    expect(int(50, 0, 10)).toBe(10)
    expect(int('3', 7, 10)).toBe(7)
    expect(int(Number.NaN, 7, 10)).toBe(7)
    expect(engineId('codex')).toBe('codex')
    expect(() => engineId('gpt')).toThrow('未知引擎')
  })

  it('keeps only known usage fields', () => {
    expect(usageQuery({ range: '30d', filter: { model: 'm', engine: 1, other: 'x' }, now: 5 })).toEqual({
      range: '30d',
      filter: { model: 'm' },
      now: 5,
    })
    const q = usageQuery({ range: 'year' })
    expect(q.range).toBe('today')
    expect(q.filter).toEqual({})
    expect(typeof q.now).toBe('number')
    expect(usageListQuery({ now: 1, offset: -1, limit: 9999 })).toMatchObject({ offset: 0, limit: 500 })
    expect(usageListQuery(null)).toMatchObject({ offset: 0, limit: 50 })
  })

  it('keeps the cost filter only for known values (GitHub #22)', () => {
    expect(usageQuery({ filter: { cost: 'missing', model: 'm' }, now: 1 }).filter).toEqual({
      cost: 'missing',
      model: 'm',
    })
    expect(usageQuery({ filter: { cost: 'no-price' }, now: 1 }).filter).toEqual({ cost: 'no-price' })
    expect(usageQuery({ filter: { cost: 'bogus', route: 'cli' }, now: 1 }).filter).toEqual({ route: 'cli' })
  })

  it('checks artifact references', () => {
    const abs = process.platform === 'win32' ? 'C:\\a\\b.txt' : '/a/b.txt'
    expect(artifactRef({ sessionId: 's', path: abs, itemId: 'i' })).toEqual({ sessionId: 's', path: abs, itemId: 'i' })
    expect(artifactRef({ sessionId: 's' })).toEqual({ sessionId: 's', path: '', itemId: undefined })
    expect(() => artifactRef({ sessionId: 's', path: 'relative.txt' })).toThrow('文件路径不正确')
    expect(() => artifactRef({ path: abs })).toThrow('参数 sessionId 不对')
  })

  it('filters engine settings by type', () => {
    expect(
      engineConfigPatch({
        path: null,
        args: ['--debug', '--add-dir', 'D:\\x'],
        compactModel: 3,
        env: { A: 'a', B: 2 },
        defaults: { model: 'x' },
        outputStyle: 'brief',
        askQuestions: 'yes',
        autoCompactPct: 80,
        hidden: true,
        extra: 1,
      }),
    ).toEqual({
      path: null,
      args: ['--debug', '--add-dir', 'D:\\x'],
      env: { A: 'a' },
      defaults: { model: 'x' },
      outputStyle: 'brief',
      autoCompactPct: 80,
      hidden: true,
    })
    // 记住会话里的选择（GitHub #6）、每个模型的上下文窗口（GitHub #20）也要过得去
    expect(
      engineConfigPatch({
        rememberChoices: true,
        contextWindows: { platform: { a: 200_000, b: null, c: '1m' }, self: [], other: { x: 1 } },
      }),
    ).toEqual({ rememberChoices: true, contextWindows: { platform: { a: 200_000, b: null } } })
    expect(engineConfigPatch({ rememberChoices: 'yes', contextWindows: [1] })).toEqual({})
    expect(engineConfigPatch({ args: ['--x', 1] })).toEqual({})
    expect(engineConfigPatch({ args: '--debug' })).toEqual({})
    expect(engineConfigPatch(undefined)).toEqual({})
  })

  it('accepts only known connector actions with a plain server name', () => {
    expect(mcpOp({ kind: 'refresh', name: 'x y' })).toEqual({ kind: 'refresh' })
    expect(mcpOp({ kind: 'reconnect', name: 'gpt-sovits', extra: 1 })).toEqual({
      kind: 'reconnect',
      name: 'gpt-sovits',
    })
    expect(mcpOp({ kind: 'toggle', name: 'a', enabled: false })).toEqual({ kind: 'toggle', name: 'a', enabled: false })
    expect(() => mcpOp({ kind: 'toggle', name: 'a' })).toThrow('未知的连接器操作')
    expect(() => mcpOp({ kind: 'reconnect', name: 'a\n/pixelsky-mode bypass' })).toThrow('连接器名字不对')
    expect(() => mcpOp({ kind: 'login', name: '' })).toThrow('连接器名字不对')
    expect(() => mcpOp({ kind: 'delete', name: 'a' })).toThrow('未知的连接器操作')
    expect(() => mcpOp(null)).toThrow()
  })
})
