import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptyState, readStateFile, writeStateFile } from './store'

const dir = (): string => mkdtempSync(join(tmpdir(), 'pixelsky-packstate-'))

describe('state.json', () => {
  it('旧格式（没有 store 字段）照常读，store 是空的，原文件不被改名', () => {
    const d = dir()
    const file = join(d, 'state.json')
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        folders: [{ path: 'C:/x', enabled: false, addedAt: 5, options: {} }],
        builtin: { 'pixelsky.a': { enabled: false, options: { overrideBuiltin: ['ts'] } } },
      }),
    )
    const state = readStateFile(file)
    expect(state.store).toEqual({})
    expect(state.folders).toHaveLength(1)
    expect(state.builtin['pixelsky.a']).toEqual({ enabled: false, options: { overrideBuiltin: ['ts'] } })
    expect(existsSync(file)).toBe(true)
    expect(readdirSync(d).filter(n => n.includes('.bad-'))).toEqual([])
  })

  it('新格式：store 里的开关和选项读得出来，version 仍是 1', () => {
    const d = dir()
    const file = join(d, 'state.json')
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        folders: [],
        builtin: {},
        store: { 'acme.a': { enabled: false, options: { overrideBuiltin: ['x', 3] } }, 'acme.b': {} },
      }),
    )
    const state = readStateFile(file)
    expect(state.version).toBe(1)
    expect(state.store['acme.a']).toEqual({ enabled: false, options: { overrideBuiltin: ['x'] } })
    expect(state.store['acme.b']).toEqual({ enabled: true, options: {} })
  })

  it('store 字段形状不对：整个不是对象就当空，单项不是对象就丢掉那一项', () => {
    for (const bad of ['oops', 5, null, ['a']]) {
      const d = dir()
      const file = join(d, 'state.json')
      writeFileSync(file, JSON.stringify({ version: 1, folders: [], builtin: {}, store: bad }))
      expect(readStateFile(file).store).toEqual({})
      expect(existsSync(file)).toBe(true)
    }
    const d = dir()
    const file = join(d, 'state.json')
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        folders: [],
        builtin: {},
        store: { 'acme.a': 'x', 'acme.b': null, 'acme.c': [], 'acme.d': { enabled: true } },
      }),
    )
    expect(Object.keys(readStateFile(file).store)).toEqual(['acme.d'])
  })

  it('写完再读一致，写出去的 version 是 1', () => {
    const d = dir()
    const file = join(d, 'state.json')
    const state = emptyState()
    state.store['acme.a'] = { enabled: false, options: { overrideBuiltin: ['ts'] } }
    state.builtin['pixelsky.a'] = { enabled: true, options: {} }
    writeStateFile(file, state)
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1)
    expect(readStateFile(file)).toEqual(state)
  })
})
