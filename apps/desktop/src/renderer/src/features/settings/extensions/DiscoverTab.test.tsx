// 发现页：大卡片和列表、每一项的字段、按钮三种状态、分类栏（第二期 / 第三期灰显）、连不上云端
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
import { I18nProvider } from '@/i18n/I18nProvider'
import { saveDiscoverView } from '@/features/extstore/store'
import { fakeStoreItem } from '@/features/extstore/testing'
import { CategoryRail, DiscoverTab, OfflineNotice } from './DiscoverTab'
import { StoreFeaturedCard, StoreRow } from './StoreCard'

const wrap = (node: React.ReactNode): string => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>)
const handlers = { onOpen: () => {}, onInstall: () => {}, onCancel: () => {} }

const swift = fakeStoreItem({
  id: 'pixelsky.swift',
  name: 'Swift 支持',
  description: 'Swift 语法高亮、代码片段、文件图标',
  publisher: { name: 'pixelsky', official: true },
  kinds: ['grammars', 'snippets', 'iconThemes'],
  downloads: 2036,
})
const plain = fakeStoreItem({ id: 'acme.plain', name: 'Plain', publisher: { name: 'acme', official: false } })

describe('StoreRow：每一项的字段', () => {
  const html = wrap(<StoreRow item={swift} state={{ installed: false }} handlers={handlers} />)
  it('名称、发布者、说明、下载量', () => {
    expect(html).toContain('Swift 支持')
    expect(html).toContain('pixelsky')
    expect(html).toContain('Swift 语法高亮、代码片段、文件图标')
    expect(html).toContain('2,036')
  })
  it('贡献种类小标签', () => {
    expect(html).toContain('语法')
    expect(html).toContain('片段')
    expect(html).toContain('图标')
  })
  it('「官方」标只在 official 时有', () => {
    expect(html).toContain('官方')
    expect(wrap(<StoreRow item={plain} state={{ installed: false }} handlers={handlers} />)).not.toContain('官方')
  })
  it('图标走 pixelsky-ext 协议', () => {
    expect(html).toContain('pixelsky-ext://store-icon/pixelsky.swift/1.0.0')
  })
})

describe('按钮：安装 / 已安装 / 更新', () => {
  const row = (state: Parameters<typeof StoreRow>[0]['state']): string =>
    wrap(<StoreRow item={plain} state={state} handlers={handlers} />)
  it('没装显示「安装」', () => {
    const html = row({ installed: false })
    expect(html).toContain('>安装<')
    expect(html).not.toContain('已安装')
  })
  it('装了显示「已安装」', () => {
    const html = row({ installed: true })
    expect(html).toContain('已安装')
    expect(html).not.toContain('>安装<')
  })
  it('有更新显示「更新」；新版本要求更高的像素星空时显示「无法更新」', () => {
    expect(row({ installed: true, update: { latest: '1.1.0', engineOk: true } })).toContain('>更新<')
    const blocked = row({ installed: true, update: { latest: '2.0.0', engineOk: false, engineNeed: '0.5.0' } })
    expect(blocked).not.toContain('>更新<')
    expect(blocked).toContain('无法更新')
    expect(blocked).toContain('0.5.0')
  })
  it('正在下载显示进度和取消', () => {
    const html = row({
      installed: false,
      progress: { phase: 'downloading', version: '1.0.0', kind: 'install', received: 45, total: 100 },
    })
    expect(html).toContain('下载中 45%')
    expect(html).toContain('取消')
  })
  it('失败原因写在下面', () => {
    expect(row({ installed: false, error: '下载失败：连不上扩展商店' })).toContain('下载失败：连不上扩展商店')
  })
})

describe('大卡片', () => {
  it('同样的字段和按钮', () => {
    const html = wrap(<StoreFeaturedCard item={swift} state={{ installed: true }} handlers={handlers} />)
    expect(html).toContain('data-store-card="featured"')
    expect(html).toContain('Swift 支持')
    expect(html).toContain('官方')
    expect(html).toContain('已安装')
  })
})

describe('DiscoverTab', () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map(n => fakeStoreItem({ id: `acme.${n}`, name: `Ext ${n}` }))
  const seed = (over: Partial<Parameters<typeof saveDiscoverView>[0]> = {}): void =>
    saveDiscoverView({
      q: '',
      category: 'all',
      sort: 'recommended',
      pages: [{ items, nextBefore: null }],
      scrollTop: 0,
      ...over,
    })

  it('推荐 / 全部 / 没搜索词：前 3 个是大卡片，其余是列表', () => {
    seed()
    const html = wrap(<DiscoverTab />)
    expect(html.match(/data-store-card="featured"/g)).toHaveLength(3)
    expect(html.match(/data-store-card="row"/g)).toHaveLength(2)
  })

  it('有搜索词、选了分类或换了排序时都是列表', () => {
    for (const over of [{ q: 'x' }, { category: 'code' }, { sort: 'downloads' as const }]) {
      seed(over)
      const html = wrap(<DiscoverTab />)
      expect(html).not.toContain('data-store-card="featured"')
      expect(html.match(/data-store-card="row"/g)).toHaveLength(5)
    }
  })

  it('从详情回来：搜索词、分类、排序还在', () => {
    seed({ q: 'swift', category: 'grammars', sort: 'updated' })
    const html = wrap(<DiscoverTab />)
    expect(html).toContain('value="swift"')
    expect(html).toMatch(
      /data-store-category="grammars"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-store-category="grammars"/,
    )
    expect(html).toMatch(/aria-checked="true"[^>]*>最新</)
  })

  it('搜索框最多 100 字；有下一页时有「加载更多」', () => {
    seed({ pages: [{ items, nextBefore: '30' }] })
    const html = wrap(<DiscoverTab />)
    expect(html).toContain('maxLength="100"')
    expect(html).toContain('加载更多')
  })

  it('没有结果时显示「没有符合条件的扩展」', () => {
    seed({ pages: [{ items: [], nextBefore: null }] })
    expect(wrap(<DiscoverTab />)).toContain('没有符合条件的扩展')
  })

  it('没有取过的页时先显示「正在加载…」', () => {
    seed({ pages: [] })
    expect(wrap(<DiscoverTab />)).toContain('正在加载')
  })
})

describe('连不上云端', () => {
  it('显示「连不上扩展商店」和「重试」', () => {
    const html = wrap(<OfflineNotice onRetry={() => {}} />)
    expect(html).toContain('连不上扩展商店')
    expect(html).toContain('重试')
  })
})

describe('分类栏', () => {
  const html = wrap(<CategoryRail value="all" onPick={() => {}} />)
  const button = (id: string): string =>
    html.match(new RegExp(`<button[^>]*data-store-category="${id}"[^>]*>.*?</button>`))![0]

  it('「命令」旁有「第二期」、「MCP」「插件」旁有「第三期」，且是禁用的', () => {
    expect(button('commands')).toContain('第二期')
    expect(button('commands')).toContain('disabled')
    for (const id of ['mcp', 'plugins']) {
      expect(button(id)).toContain('第三期')
      expect(button(id)).toContain('disabled')
    }
  })
  it('其余分类能点，也不显示数量', () => {
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
      expect(button(id)).not.toContain('disabled')
    expect(button('grammars').replace(/<[^>]*>/g, '')).toBe('语法高亮')
  })
})
