import { describe, expect, it } from 'vitest'
import { json, merge, nextState, parseSyncState, type SyncState } from './merge'

const keys = ['desktop.theme', 'desktop.fonts', 'desktop.accent']
const at = (value: unknown, updatedAt: number) => ({ value, updatedAt })
const synced = (keys: Record<string, [number | null, unknown]>): SyncState => ({
  v: 1,
  keys: Object.fromEntries(Object.entries(keys).map(([k, [cloudAt, local]]) => [k, { cloudAt, local: json(local) }])),
})

describe('两边都改时的合并函数', () => {
  const k = 'desktop.customThemes'
  const at = (value: unknown, updatedAt: number) => ({ value, updatedAt })
  const conflict = { [k]: (mine: unknown, theirs: unknown) => `${mine}+${theirs}` }
  const state = { v: 1 as const, keys: { [k]: { cloudAt: 1, local: JSON.stringify('old') } } }

  it('两边都改：写到本机也上传合并结果', () => {
    const r = merge({ state, keys: [k], local: { [k]: 'mine' }, cloud: { [k]: at('cloud', 2) }, conflict })
    expect(r.apply[k]).toBe('mine+cloud')
    expect(r.push[k]).toBe('mine+cloud')
  })

  it('只有一边改：不合并', () => {
    const onlyLocal = merge({ state, keys: [k], local: { [k]: 'mine' }, cloud: { [k]: at('old', 1) }, conflict })
    expect(onlyLocal.push[k]).toBe('mine')
    expect(onlyLocal.apply).toEqual({})
    const onlyCloud = merge({ state, keys: [k], local: { [k]: 'old' }, cloud: { [k]: at('cloud', 2) }, conflict })
    expect(onlyCloud.apply[k]).toBe('cloud')
    expect(onlyCloud.push).toEqual({})
  })

  it('第一次同步：本机已有的不被云端整份盖掉', () => {
    const r = merge({ state: null, keys: [k], local: { [k]: 'mine' }, cloud: { [k]: at('cloud', 2) }, conflict })
    expect(r.apply[k]).toBe('mine+cloud')
    expect(r.push[k]).toBe('mine+cloud')
    expect(r.restored).toBe(true)
  })

  it('没传合并函数的键：照旧本机覆盖云端', () => {
    const r = merge({ state, keys: [k], local: { [k]: 'mine' }, cloud: { [k]: at('cloud', 2) } })
    expect(r.push[k]).toBe('mine')
    expect(r.apply).toEqual({})
  })
})

describe('设置云同步：对账（docs/ui/settings-sync.md §4）', () => {
  it('第一次、云端什么都没有：上传本机改过的（没有的不传）', () => {
    const r = merge({ state: null, keys, local: { 'desktop.theme': 'dark' }, cloud: {} })
    expect(r).toEqual({ apply: {}, push: { 'desktop.theme': 'dark' }, restored: false })
  })

  it('第一次、云端已有：用云端的覆盖本机并提示；云端没有的键上传本机的', () => {
    const r = merge({
      state: null,
      keys,
      local: { 'desktop.theme': 'light', 'desktop.accent': 'rose' },
      cloud: { 'desktop.theme': at('dark', 10), 'desktop.fonts': at('{"scale":1.1}', 11) },
    })
    expect(r.apply).toEqual({ 'desktop.theme': 'dark', 'desktop.fonts': '{"scale":1.1}' })
    expect(r.push).toEqual({ 'desktop.accent': 'rose' })
    expect(r.restored).toBe(true)
  })

  it('第一次、云端和本机一样：什么都不用做，也不提示', () => {
    const r = merge({
      state: null,
      keys,
      local: { 'desktop.theme': 'dark' },
      cloud: { 'desktop.theme': at('dark', 1) },
    })
    expect(r).toEqual({ apply: {}, push: {}, restored: false })
  })

  it('云端比上次看到的新、本机没改：用云端的', () => {
    const state = synced({ 'desktop.theme': [10, 'light'] })
    const r = merge({ state, keys, local: { 'desktop.theme': 'light' }, cloud: { 'desktop.theme': at('dark', 20) } })
    expect(r).toEqual({ apply: { 'desktop.theme': 'dark' }, push: {}, restored: false })
  })

  it('本机改了：上传；两边都改了也上传本机的（最后到达服务端的为准）', () => {
    const state = synced({ 'desktop.theme': [10, 'light'], 'desktop.accent': [5, 'blue'] })
    const r = merge({
      state,
      keys,
      local: { 'desktop.theme': 'dark', 'desktop.accent': 'rose' },
      cloud: { 'desktop.theme': at('light', 10), 'desktop.accent': at('teal', 30) },
    })
    expect(r.push).toEqual({ 'desktop.theme': 'dark', 'desktop.accent': 'rose' })
    expect(r.apply).toEqual({})
  })

  it('本机恢复默认：删掉云端的键；云端也没有就什么都不做', () => {
    const state = synced({ 'desktop.theme': [10, 'dark'], 'desktop.fonts': [null, '{}'] })
    const r = merge({ state, keys, local: {}, cloud: { 'desktop.theme': at('dark', 10) } })
    expect(r.push).toEqual({ 'desktop.theme': null })
  })

  it('云端删了这个键：本机恢复默认', () => {
    const state = synced({ 'desktop.theme': [10, 'dark'] })
    const r = merge({ state, keys, local: { 'desktop.theme': 'dark' }, cloud: {} })
    expect(r.apply).toEqual({ 'desktop.theme': null })
  })

  it('都没变：什么都不做', () => {
    const state = synced({ 'desktop.theme': [10, 'dark'] })
    const r = merge({ state, keys, local: { 'desktop.theme': 'dark' }, cloud: { 'desktop.theme': at('dark', 10) } })
    expect(r).toEqual({ apply: {}, push: {}, restored: false })
  })

  it('关掉的分类不在 keys 里：既不上传也不接收', () => {
    const r = merge({
      state: synced({}),
      keys: ['desktop.theme'],
      local: { 'desktop.accent': 'rose' },
      cloud: { 'desktop.fonts': at('x', 9) },
    })
    expect(r).toEqual({ apply: {}, push: {}, restored: false })
  })
})

describe('设置云同步：同步后的状态', () => {
  it('上传的记上传的值，写回的记重新读到的值（被校验改过以它为准），其余记这一轮读到的', () => {
    const local = { 'desktop.theme': 'dark', 'desktop.fonts': 'old', 'desktop.accent': 'rose' }
    const result = { push: { 'desktop.theme': 'dark' }, apply: { 'desktop.fonts': 'bad-value' } }
    const cloud = { 'desktop.theme': at('dark', 40), 'desktop.fonts': at('bad-value', 30) }
    const next = nextState(null, keys, local, { 'desktop.fonts': undefined }, result, cloud)
    expect(next.keys).toEqual({
      'desktop.theme': { cloudAt: 40, local: '"dark"' },
      'desktop.fonts': { cloudAt: 30, local: null },
      'desktop.accent': { cloudAt: null, local: '"rose"' },
    })
    // 下一轮：本机没再改、云端没再变 → 不会因为校验改过的值来回同步
    expect(merge({ state: next, keys, local: { ...local, 'desktop.fonts': undefined }, cloud })).toMatchObject({
      apply: {},
    })
  })

  it('损坏的状态当作第一次同步', () => {
    expect(parseSyncState(null)).toBeNull()
    expect(parseSyncState({ v: 2, keys: {} })).toBeNull()
    expect(parseSyncState({ v: 1, keys: { a: { cloudAt: 'x', local: 3 }, b: null } })).toEqual({
      v: 1,
      keys: { a: { cloudAt: null, local: null } },
    })
  })
})
