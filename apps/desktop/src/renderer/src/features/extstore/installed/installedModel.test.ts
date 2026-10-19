import { describe, expect, it } from 'vitest'
import type { ExtPackInfo, ExtStoreUpdates } from '@pixelsky/protocol'
import { fakePack } from '@/features/extpacks/testing'
import { namedPack } from './testing'
import {
  blocklistLine,
  filterInstalled,
  installedCounts,
  rowState,
  runUpdateAll,
  sortInstalled,
  updateCandidates,
  updateLine,
  type InstalledQuery,
} from './installedModel'

const SITE = 'https://cloud.test'
const receipt = (version: string, site = SITE) => ({ version, installedAt: 1, sha256: 'x', keyId: 'k', site })
const storePack = (id: string, over: Partial<ExtPackInfo> = {}): ExtPackInfo =>
  fakePack({ key: `s-${id}`, id, source: 'store', store: receipt('1.0.0'), ...over })
const up = (latest: string, extra: Partial<ExtStoreUpdates[string]> = {}) => ({ latest, engineOk: true, ...extra })

describe('sortInstalled', () => {
  it('内置 → 商店 → 文件夹，同来源按添加时间', () => {
    const list = [
      fakePack({ key: 'f', source: 'folder', addedAt: 1 }),
      fakePack({ key: 's2', source: 'store', addedAt: 5 }),
      fakePack({ key: 's1', source: 'store', addedAt: 2 }),
      fakePack({ key: 'b', source: 'builtin', addedAt: 9 }),
    ]
    expect(sortInstalled(list).map(p => p.key)).toEqual(['b', 's1', 's2', 'f'])
  })
})

describe('updateLine', () => {
  it('有新版本', () => {
    expect(updateLine(storePack('a.b'), up('2.5.0'), SITE)).toEqual({
      kind: 'available',
      from: '1.0.0',
      latest: '2.5.0',
    })
  })
  it('没有更新信息 / 不比本机新：null', () => {
    expect(updateLine(storePack('a.b'), undefined, SITE)).toBeNull()
    expect(updateLine(storePack('a.b'), up('1.0.0'), SITE)).toBeNull()
  })
  it('engineOk:false：新版本需要像素星空 0.5.0，不给更新', () => {
    const u = up('2.0.0', { engineOk: false, engineNeed: '0.5.0' })
    expect(updateLine(storePack('a.b'), u, SITE)).toEqual({ kind: 'engineNeed', need: '0.5.0' })
    expect(rowState(storePack('a.b'), u, SITE).canUpdate).toBe(false)
  })
  it('被停用且有更早的可用版本：换回；没有：null', () => {
    const blocked = storePack('a.b', { blocked: { reason: 'r', at: '2026-10-14T00:00:00Z' } })
    expect(updateLine(blocked, up('1.0.0', { rollbackTo: '0.9.0' }), SITE)).toEqual({ kind: 'rollback', to: '0.9.0' })
    expect(rowState(blocked, up('1.0.0', { rollbackTo: '0.9.0' }), SITE).rollbackTo).toBe('0.9.0')
    expect(updateLine(blocked, up('9.0.0'), SITE)).toBeNull()
  })
  it('没被停用时不显示换回', () => {
    expect(updateLine(storePack('a.b'), up('1.0.0', { rollbackTo: '0.9.0' }), SITE)).toBeNull()
  })
  it('别的站点装的：不检查更新', () => {
    const p = storePack('a.b', { store: receipt('1.0.0', 'https://other.test') })
    expect(updateLine(p, up('2.0.0'), SITE)).toEqual({ kind: 'otherSite', site: 'https://other.test' })
    expect(rowState(p, up('2.0.0'), SITE).canUpdate).toBe(false)
  })
  it('内置和文件夹没有这一行', () => {
    expect(updateLine(fakePack({ source: 'folder' }), up('2.0.0'), SITE)).toBeNull()
  })
})

describe('rowState', () => {
  it('被停用：红色、开关灰掉', () => {
    const s = rowState(storePack('a.b', { blocked: { reason: 'r', at: 'x' } }), undefined, SITE)
    expect(s.tone).toBe('blocked')
    expect(s.switchDisabled).toBe(true)
  })
  it('被替代：灰显，开关保留', () => {
    const s = rowState(storePack('a.b', { shadowedBy: 'folder', live: false }), undefined, SITE)
    expect(s.tone).toBe('shadowed')
    expect(s.switchDisabled).toBe(false)
  })
  it('内置不能卸载', () => {
    expect(rowState(fakePack({ source: 'builtin' }), undefined, SITE).canUninstall).toBe(false)
    expect(rowState(storePack('a.b'), undefined, SITE).canUninstall).toBe(true)
  })
})

describe('updateCandidates / runUpdateAll', () => {
  const packs = [
    storePack('a.on'),
    storePack('a.off', { enabled: false, live: false }),
    storePack('a.shadow', { shadowedBy: 'folder', live: false }),
    storePack('a.blocked', { blocked: { reason: 'r', at: 'x' } }),
    storePack('a.other', { store: receipt('1.0.0', 'https://other.test') }),
    storePack('a.engine'),
    storePack('a.same'),
    fakePack({ key: 'f', id: 'a.folder', source: 'folder' }),
  ]
  const updates: ExtStoreUpdates = {
    'a.on': up('2.0.0'),
    'a.off': up('2.0.0'),
    'a.shadow': up('2.0.0'),
    'a.blocked': up('2.0.0', { rollbackTo: '0.9.0' }),
    'a.other': up('2.0.0'),
    'a.engine': up('2.0.0', { engineOk: false, engineNeed: '0.5.0' }),
    'a.same': up('1.0.0'),
    'a.folder': up('2.0.0'),
  }
  it('包括自己关掉的和被替代的；跳过被停用的、别的站点的、engineOk:false 的', () => {
    expect(updateCandidates(packs, updates, SITE).map(p => p.id)).toEqual(['a.on', 'a.off', 'a.shadow'])
  })
  it('逐个装，一个失败不影响后面的', async () => {
    const seen: string[] = []
    const r = await runUpdateAll(updateCandidates(packs, updates, SITE), updates, async (id, v) => {
      seen.push(`${id}@${v}`)
      if (id === 'a.off') throw new Error('boom')
    })
    expect(seen).toEqual(['a.on@2.0.0', 'a.off@2.0.0', 'a.shadow@2.0.0'])
    expect(r).toEqual({ updated: 2, failed: 1 })
  })
})

describe('filterInstalled / installedCounts', () => {
  const grammar = { scopeName: 'source.x', path: 'g.json', samples: [] }
  const withManifest = (over: Partial<ExtPackInfo>, publisher = 'acme'): ExtPackInfo => {
    return namedPack({ contributes: { grammars: [grammar] }, ...over }, '雨天', publisher)
  }
  const a = withManifest({ key: 'a', id: 'acme.rainy', source: 'store', store: receipt('1.0.0') })
  const b = withManifest({ key: 'b', id: 'zed.sunny', enabled: false, live: false }, 'zed')
  const c = fakePack({ key: 'c', id: 'q.themes' })
  const c2 = { ...c, manifest: { ...c.manifest!, contributes: { themes: [{}] } } } as unknown as ExtPackInfo
  const d = withManifest({
    key: 'd',
    id: 'k.blocked',
    source: 'store',
    store: receipt('1.0.0'),
    blocked: { reason: 'r', at: 'x' },
  })
  const all = [a, b, c2, d]
  const base: InstalledQuery = {
    query: '',
    filter: 'all',
    category: 'all',
    updates: { 'acme.rainy': up('2.0.0') },
    site: SITE,
    locale: 'zh-CN',
  }
  const keys = (list: ExtPackInfo[]): string[] => list.map(p => p.key)
  it('搜索：名称、id、发布者', () => {
    expect(keys(filterInstalled(all, { ...base, query: '雨天' }))).toEqual(['a', 'b', 'd'])
    expect(keys(filterInstalled(all, { ...base, query: 'zed' }))).toEqual(['b'])
    expect(keys(filterInstalled(all, { ...base, query: 'q.themes' }))).toEqual(['c'])
  })
  it('筛选：有更新 / 已停用（含被平台停用）', () => {
    expect(keys(filterInstalled(all, { ...base, filter: 'updates' }))).toEqual(['a'])
    expect(keys(filterInstalled(all, { ...base, filter: 'disabled' }))).toEqual(['b', 'd'])
  })
  it('分类按贡献种类', () => {
    expect(keys(filterInstalled(all, { ...base, category: 'themes' }))).toEqual(['c'])
  })
  it('数量', () => {
    const n = installedCounts(all, base)
    expect([n.all, n.updates, n.disabled, n.kinds.grammars, n.kinds.themes]).toEqual([4, 1, 2, 3, 1])
  })
})

describe('blocklistLine', () => {
  const now = Date.parse('2026-10-16T12:00:00Z')
  it('2 天前：带时间那句', () => {
    const line = blocklistLine(new Date(now - 2 * 24 * 3600_000).toISOString(), now)
    expect(line?.kind).toBe('at')
    expect(line && line.kind === 'at' ? line.at : '').toMatch(/^\d\d-\d\d \d\d:\d\d$/)
  })
  it('3 天零 1 分钟前：很久没更新', () => {
    expect(blocklistLine(new Date(now - 3 * 24 * 3600_000 - 60_000).toISOString(), now)).toEqual({ kind: 'stale' })
  })
  it('没有时间：null', () => {
    expect(blocklistLine(null, now)).toBeNull()
  })
})
