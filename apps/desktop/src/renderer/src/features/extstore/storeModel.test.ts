import { describe, expect, it } from 'vitest'
import type { ExtStoreCatalogPage, ExtStoreItem } from '@pixelsky/protocol'
import {
  installToast,
  cardAction,
  cardFields,
  catalogQueryOf,
  categoryParam,
  clampQuery,
  formatDownloads,
  installedIdsOf,
  installedVersionsOf,
  isCategorySelectable,
  mergePages,
  nextBeforeOf,
  QUERY_MAX,
  showsFeatured,
  STORE_CATEGORIES,
  storeIconSrc,
} from './storeModel'
import { fakeStoreItem } from './testing'

const page = (ids: string[], nextBefore: string | null): ExtStoreCatalogPage => ({
  items: ids.map(id => fakeStoreItem({ id })),
  nextBefore,
})

describe('clampQuery', () => {
  it('100 字以内原样返回，101 字截成 100 字', () => {
    expect(clampQuery('a'.repeat(100))).toBe('a'.repeat(100))
    expect(clampQuery('a'.repeat(101))).toBe('a'.repeat(100))
    expect(clampQuery('中'.repeat(150))).toHaveLength(QUERY_MAX)
  })
  it('按字截，不把 emoji 截成两半', () => {
    const out = clampQuery('😀'.repeat(101))
    expect([...out]).toHaveLength(100)
    expect(out.endsWith('😀')).toBe(true)
  })
})

describe('分类', () => {
  it('「命令」第二期、「MCP」「插件」第三期，都不能选', () => {
    const phase = Object.fromEntries(STORE_CATEGORIES.map(c => [c.id, c.phase]))
    expect(phase.commands).toBe(2)
    expect(phase.mcp).toBe(3)
    expect(phase.plugins).toBe(3)
    for (const id of ['commands', 'mcp', 'plugins']) expect(isCategorySelectable(id)).toBe(false)
  })
  it('其余分类和两个组标题都能选', () => {
    for (const id of [
      'all',
      'code',
      'ai',
      'grammars',
      'themes',
      'snippets',
      'iconThemes',
      'taskTemplates',
      'skills',
      'prompts',
    ])
      expect(isCategorySelectable(id)).toBe(true)
  })
  it('分类和请求参数的对应：全部不传，组标题是 code / ai，其余是贡献种类，不能选的不传', () => {
    expect(categoryParam('all')).toBeUndefined()
    expect(categoryParam('code')).toBe('code')
    expect(categoryParam('ai')).toBe('ai')
    expect(categoryParam('grammars')).toBe('grammars')
    expect(categoryParam('mcp')).toBeUndefined()
  })
  it('代码模式五种 + AI 引擎两种；分类没有数量字段', () => {
    expect(STORE_CATEGORIES.filter(c => c.group === 'code' && !c.phase).map(c => c.id)).toEqual([
      'grammars',
      'themes',
      'snippets',
      'iconThemes',
      'taskTemplates',
    ])
    expect(STORE_CATEGORIES.filter(c => c.group === 'ai' && !c.phase).map(c => c.id)).toEqual(['skills', 'prompts'])
    expect(STORE_CATEGORIES.every(c => !('count' in c))).toBe(true)
  })
})

describe('catalogQueryOf', () => {
  it('默认条件什么都不传', () => {
    expect(catalogQueryOf({ q: '', category: 'all', sort: 'recommended' })).toEqual({})
  })
  it('带上搜索词（去空白、截 100 字）、分类、排序和翻页游标', () => {
    expect(catalogQueryOf({ q: '  swift ', category: 'code', sort: 'downloads' }, '30')).toEqual({
      q: 'swift',
      category: 'code',
      sort: 'downloads',
      before: '30',
    })
    expect(catalogQueryOf({ q: 'x'.repeat(120), category: 'all', sort: 'updated' }).q).toHaveLength(100)
  })
  it('不能选的分类不传 category', () => {
    expect(catalogQueryOf({ q: '', category: 'mcp', sort: 'recommended' })).toEqual({})
  })
})

describe('分页合并', () => {
  it('按页顺序合并，同 id 只留第一次出现的', () => {
    const merged = mergePages([page(['a', 'b'], '2'), page(['b', 'c'], null)])
    expect(merged.map(i => i.id)).toEqual(['a', 'b', 'c'])
  })
  it('nextBefore 取最后一页的；没有页是 null', () => {
    expect(nextBeforeOf([page(['a'], '30'), page(['b'], '60')])).toBe('60')
    expect(nextBeforeOf([page(['a'], null)])).toBeNull()
    expect(nextBeforeOf([])).toBeNull()
  })
})

describe('showsFeatured', () => {
  it('只有没搜索词、分类「全部」、排序「推荐」时才画大卡片', () => {
    expect(showsFeatured({ q: '', category: 'all', sort: 'recommended' })).toBe(true)
    expect(showsFeatured({ q: ' ', category: 'all', sort: 'recommended' })).toBe(true)
    expect(showsFeatured({ q: 'a', category: 'all', sort: 'recommended' })).toBe(false)
    expect(showsFeatured({ q: '', category: 'code', sort: 'recommended' })).toBe(false)
    expect(showsFeatured({ q: '', category: 'all', sort: 'downloads' })).toBe(false)
  })
})

describe('cardFields', () => {
  const item: ExtStoreItem = fakeStoreItem({
    id: 'pixelsky.swift',
    name: 'Swift 支持',
    publisher: { name: 'pixelsky', official: true },
    kinds: ['snippets', 'grammars', 'future-kind'],
    downloads: 1284,
  })
  it('发布者、官方标、说明、种类（按固定顺序，不认识的不显示）、下载量', () => {
    const f = cardFields(item)
    expect(f).toMatchObject({ publisher: 'pixelsky', official: true, downloads: 1284 })
    expect(f.kinds).toEqual(['grammars', 'snippets'])
    expect(f.description).toBe(item.description)
  })
  it('图标地址：商店图标走 pixelsky-ext 协议；演示目录的 data: 图标原样用', () => {
    expect(storeIconSrc({ id: 'pixelsky.swift', version: '1.2.0', iconUrl: '/x' })).toBe(
      'pixelsky-ext://store-icon/pixelsky.swift/1.2.0',
    )
    expect(storeIconSrc({ id: 'a.b', version: '1.0.0', iconUrl: 'data:image/svg+xml;utf8,%3Csvg' })).toMatch(/^data:/)
  })
  it('下载量带千位逗号', () => {
    expect(formatDownloads(2036)).toBe('2,036')
    expect(formatDownloads(612)).toBe('612')
  })
})

describe('cardAction', () => {
  it('没装是「安装」，装了是「已安装」', () => {
    expect(cardAction({ installed: false })).toEqual({ kind: 'install' })
    expect(cardAction({ installed: true })).toEqual({ kind: 'installed' })
  })
  it('有更新是「更新」；新版本要求更高的像素星空时不给更新', () => {
    expect(cardAction({ installed: true, update: { latest: '1.1.0', engineOk: true } })).toEqual({
      kind: 'update',
      version: '1.1.0',
    })
    expect(cardAction({ installed: true, update: { latest: '2.0.0', engineOk: false, engineNeed: '0.5.0' } })).toEqual({
      kind: 'updateBlocked',
      need: '0.5.0',
    })
  })
  it('知道本机版本时只有商店的版本更新才是「更新」：换回的条目（latest 比本机低）和已经更新完的都不是', () => {
    const update = { latest: '1.1.0', engineOk: true }
    expect(cardAction({ installed: true, installedVersion: '1.0.0', update })).toEqual({
      kind: 'update',
      version: '1.1.0',
    })
    expect(cardAction({ installed: true, installedVersion: '1.1.0', update })).toEqual({ kind: 'installed' })
    expect(
      cardAction({ installed: true, installedVersion: '1.2.0', update: { ...update, rollbackTo: '1.0.0' } }),
    ).toEqual({
      kind: 'installed',
    })
    expect(
      cardAction({ installed: true, installedVersion: '1.2.0', update: { latest: '2.0.0', engineOk: false } }),
    ).toEqual({
      kind: 'updateBlocked',
      need: null,
    })
  })
  it('正在装时优先显示进度', () => {
    expect(
      cardAction({
        installed: false,
        progress: { phase: 'downloading', version: '1.0.0', kind: 'install', received: 50, total: 200 },
      }),
    ).toEqual({ kind: 'installing', percent: 25, phase: 'downloading' })
    expect(
      cardAction({
        installed: true,
        progress: { phase: 'verifying', version: '1.0.0', kind: 'update', received: 0, total: null },
      }),
    ).toEqual({ kind: 'installing', percent: null, phase: expect.any(String) })
  })
})

describe('installedVersionsOf', () => {
  it('只算商店装的，版本优先用安装回执里的', () => {
    const versions = installedVersionsOf([
      { id: 'a.store', source: 'store', store: { version: '1.2.0' }, manifest: { version: '1.0.0' } },
      { id: 'a.nomanifest', source: 'store', store: { version: '2.0.0' } },
      { id: 'a.dev', source: 'folder', manifest: { version: '9.9.9' } },
      { id: null, source: 'store', store: { version: '1.0.0' } },
    ])
    expect([...versions]).toEqual([
      ['a.store', '1.2.0'],
      ['a.nomanifest', '2.0.0'],
    ])
  })
})

describe('installedIdsOf', () => {
  it('只算商店装的，内置和开发中的同 id 不算', () => {
    const ids = installedIdsOf([
      { id: 'a.store', source: 'store' },
      { id: 'a.builtin', source: 'builtin' },
      { id: 'a.dev', source: 'folder' },
      { id: null, source: 'store' },
    ])
    expect([...ids]).toEqual(['a.store'])
  })
})

describe('installToast', () => {
  it('装好：已安装 X（用名字，没有名字用 id）；更新是 updated', () => {
    expect(installToast({ id: 'a.b', name: 'Swift 支持', ok: true })).toEqual({
      kind: 'installed',
      id: 'a.b',
      name: 'Swift 支持',
    })
    expect(installToast({ id: 'a.b', ok: true, kind: 'update' })).toMatchObject({ kind: 'updated', name: 'a.b' })
    expect(installToast({ id: 'a.b', ok: true, kind: 'update', rollback: true })).toMatchObject({ kind: 'rolledBack' })
  })
  it('silent 不弹；取消不弹；失败带原因', () => {
    expect(installToast({ id: 'a.b', ok: true, silent: true })).toBeNull()
    expect(installToast({ id: 'a.b', ok: false, cancelled: true, reason: '下载已取消' })).toBeNull()
    expect(installToast({ id: 'a.b', name: 'X', ok: false, reason: '连不上' })).toEqual({
      kind: 'failed',
      id: 'a.b',
      name: 'X',
      reason: '连不上',
    })
  })
})
