import { describe, expect, it } from 'vitest'
import {
  assetUrl,
  compareContributionPriority,
  contributionsFrom,
  isContributionActive,
  livePacks,
  packIdRef,
} from './model'
import { fakePack, fakeState } from './testing'

describe('livePacks', () => {
  it('内置在前，其后按添加时间；不生效的不要', () => {
    const a = fakePack({ key: 'f-a', addedAt: 5 })
    const b = fakePack({ key: 'f-b', addedAt: 2 })
    const c = fakePack({ key: 'b-c', source: 'builtin', addedAt: 9 })
    const d = fakePack({ key: 'f-d', live: false })
    expect(livePacks(fakeState(a, b, c, d)).map(p => p.key)).toEqual(['b-c', 'f-b', 'f-a'])
  })
  it('三种来源：内置 → 商店 → 文件夹，同来源按添加时间', () => {
    const f = fakePack({ key: 'f', source: 'folder', addedAt: 1 })
    const s2 = fakePack({ key: 's2', source: 'store', addedAt: 8 })
    const s1 = fakePack({ key: 's1', source: 'store', addedAt: 3 })
    const b = fakePack({ key: 'b', source: 'builtin', addedAt: 9 })
    expect(livePacks(fakeState(f, s2, s1, b)).map(p => p.key)).toEqual(['b', 's1', 's2', 'f'])
  })
})

describe('contributionsFrom', () => {
  const grammar = (scopeName: string) => ({ scopeName, path: 'g.json', samples: [] })
  it('跳过不生效的扩展和被停用的下标，返回清单下标', () => {
    const p = fakePack({
      contributes: { grammars: [grammar('source.a'), grammar('source.b')] },
      inactive: { grammars: [0] },
    })
    const off = fakePack({ key: 'f-off', live: false, contributes: { grammars: [grammar('source.c')] } })
    const refs = contributionsFrom(fakeState(p, off), 'grammars')
    expect(refs.map(r => [r.index, r.item.scopeName])).toEqual([[1, 'source.b']])
  })
  it('isContributionActive', () => {
    const p = fakePack({ inactive: { themes: [2] } })
    expect(isContributionActive(p, 'themes', 1)).toBe(true)
    expect(isContributionActive(p, 'themes', 2)).toBe(false)
    expect(isContributionActive({ ...p, live: false }, 'themes', 1)).toBe(false)
  })
})

describe('assetUrl', () => {
  it('每一段单独编码，带版本', () => {
    expect(assetUrl('f-1', 'icons/a b/文件.svg', 3)).toBe(
      `pixelsky-ext://f-1/icons/a%20b/${encodeURIComponent('文件')}.svg?v=3`,
    )
  })
})

describe('packIdRef', () => {
  it('拆 pub.name/item', () => {
    expect(packIdRef('pixelsky.dotenv/material')).toEqual({ packId: 'pixelsky.dotenv', itemId: 'material' })
    expect(packIdRef('material')).toBeNull()
    expect(packIdRef('a.b/')).toBeNull()
  })
})

describe('compareContributionPriority', () => {
  it('后装的赢，同扩展下标大的赢', () => {
    expect(
      compareContributionPriority({ pack: { addedAt: 2 }, index: 0 }, { pack: { addedAt: 1 }, index: 5 }),
    ).toBeGreaterThan(0)
    expect(
      compareContributionPriority({ pack: { addedAt: 1 }, index: 3 }, { pack: { addedAt: 1 }, index: 1 }),
    ).toBeGreaterThan(0)
    expect(
      compareContributionPriority({ pack: { addedAt: 1 }, index: 1 }, { pack: { addedAt: 1 }, index: 3 }),
    ).toBeLessThan(0)
    expect(compareContributionPriority({ pack: { addedAt: 1 }, index: 1 }, { pack: { addedAt: 1 }, index: 1 })).toBe(0)
  })
})
