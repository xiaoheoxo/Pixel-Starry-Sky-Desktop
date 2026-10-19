import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
import type { ExtPackManifest, ExtStoreDetail } from '@pixelsky/protocol'
import { I18nProvider } from '@/i18n/I18nProvider'
import { fakePack } from '@/features/extpacks/testing'
import { StoreDetail, type StoreDetailProps } from './StoreDetail'

const manifest = {
  id: 'pixelsky.swift',
  name: 'Swift 支持',
  version: '1.2.0',
  publisher: 'pixelsky',
  description: 'Swift 语法高亮',
  license: 'MIT',
  repository: 'https://github.com/pixelsky/ext-swift',
  homepage: null,
  engines: { pixelsky: '>=0.4.0' },
  contributes: { grammars: [{ scopeName: 'source.swift', language: 'Swift', path: 'g.json' }] },
  main: null,
  permissions: [],
  price: null,
} as unknown as ExtPackManifest

const version = (v: string): ExtStoreDetail['latest'] => ({
  version: v,
  publishedAt: '2026-10-15T00:00:00Z',
  size: 52 * 1024,
  sha256: 'x',
  signature: 'x',
  keyId: 'k',
  downloadUrl: '/d',
})

const detail = (over: Partial<ExtStoreDetail> = {}): ExtStoreDetail => ({
  extension: {
    id: 'pixelsky.swift',
    name: 'Swift 支持',
    description: 'Swift 语法高亮',
    publisher: { name: 'pixelsky', official: true },
    version: '1.2.0',
    iconUrl: '/icon',
    kinds: ['grammars'],
    categories: [],
    downloads: 1284,
    installs: 10,
    updatedAt: '2026-10-15T00:00:00Z',
  },
  latest: version('1.2.0'),
  manifest: { ...manifest, engines: { ...manifest.engines } },
  readme: '## 功能\n\n- 语法高亮',
  contents: [{ kind: 'grammars', count: 1 }],
  license: 'MIT',
  repository: 'https://github.com/pixelsky/ext-swift',
  homepage: null,
  versions: [version('1.2.0'), version('1.0.0')],
  local: null,
  ...over,
})

const noop = (): void => undefined
const render = (over: Partial<StoreDetailProps> = {}): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <StoreDetail
        detail={detail()}
        appVersion="0.4.10-beta"
        signedIn
        onBack={noop}
        onInstall={noop}
        onUninstall={noop}
        onSetEnabled={noop}
        onReport={async () => undefined}
        onLogin={noop}
        {...over}
      />
    </I18nProvider>,
  )

const button = (html: string, action: string): string =>
  new RegExp(`<button[^>]*data-action="${action}"[^>]*>`).exec(html)?.[0] ?? ''

const storePack = (over: Parameters<typeof fakePack>[0] = {}): ReturnType<typeof fakePack> =>
  fakePack({
    key: 'store-1',
    id: 'pixelsky.swift',
    source: 'store',
    manifest,
    store: { version: '1.0.0', installedAt: 1, sha256: 'x', keyId: 'k', site: 's' },
    ...over,
  })

describe('StoreDetail', () => {
  it('顶上：名称、官方标、发布者、版本、下载量；右边「安装」', () => {
    const html = render()
    expect(html).toContain('Swift 支持')
    expect(html).toContain('官方')
    expect(html).toContain('pixelsky')
    expect(html).toContain('v1.2.0')
    expect(html).toContain('1,284')
    expect(button(html, 'install')).not.toBe('')
    expect(button(html, 'install')).not.toContain('disabled=""')
  })

  it('不是官方的没有「官方」标', () => {
    const d = detail()
    d.extension.publisher.official = false
    expect(render({ detail: d })).not.toContain('官方')
  })

  it('README 渲染成 Markdown，右栏有包含什么、权限、许可证、源码、大小、版本要求、举报', () => {
    const html = render()
    expect(html).toContain('<h2>功能</h2>')
    expect(html).toContain('1 个语法高亮（Swift）')
    expect(html).toContain('不运行代码，不需要权限')
    expect(html).toContain('许可证 MIT')
    expect(html).toContain('github.com/pixelsky/ext-swift')
    expect(html).toContain('大小 52 KB')
    expect(html).toContain('需要像素星空 0.4.0 以上')
    expect(html).toContain('举报这个扩展')
  })

  it('版本记录页签：版本列表', () => {
    const html = render({ initialTab: 'versions' })
    expect(html).toContain('v1.2.0')
    expect(html).toContain('v1.0.0')
    expect(html).toContain('data-store-versions')
    expect(html).not.toContain('<h2>功能</h2>')
  })

  it('engineUnmet：安装按钮带 disabled，并写原因', () => {
    const d = detail()
    ;(d.manifest as ExtPackManifest).engines = { pixelsky: '>=0.9.0' }
    const html = render({ detail: d })
    expect(button(html, 'install')).toContain('disabled=""')
    expect(html).toContain('data-action-reason')
    expect(html).toContain('需要像素星空 0.9.0 以上')
  })

  it('本机有同 id 的开发版：写「装上后会被你的开发版替代」', () => {
    expect(render({ devCopy: true })).toContain('装上后会被你的开发版替代')
    expect(render()).not.toContain('装上后会被你的开发版替代')
  })

  it('已装有更新：「更新」「卸载」「停用」，显示已装版本', () => {
    const html = render({
      detail: detail({ local: { key: 'k', version: '1.0.0', source: 'store', enabled: true } }),
      update: { latest: '1.2.0', engineOk: true },
    })
    expect(button(html, 'update')).not.toBe('')
    expect(button(html, 'uninstall')).not.toBe('')
    expect(button(html, 'disable')).not.toBe('')
    expect(button(html, 'install')).toBe('')
    expect(html).toContain('已装 1.0.0')
  })

  it('新版本要求更高：没有「更新」，写「新版本需要像素星空 X」', () => {
    const html = render({
      detail: detail({ local: { key: 'k', version: '1.0.0', source: 'store', enabled: true } }),
      update: { latest: '1.2.0', engineOk: false, engineNeed: '>=0.6.0' },
    })
    expect(button(html, 'update')).toBe('')
    expect(html).toContain('新版本需要像素星空 0.6.0')
  })

  it('进度：下载中 45%，按钮变成进度', () => {
    const html = render({
      progress: { phase: 'downloading', version: '1.2.0', kind: 'install', received: 45, total: 100 },
    })
    expect(html).toContain('下载中 45%')
    expect(button(html, 'install')).toBe('')
  })

  it('详情 404、本机已装：显示本机详情和「已从商店下架」', () => {
    const html = render({ detail: null, localPack: storePack() })
    expect(html).toContain('Swift 支持')
    expect(html).toContain('这个扩展已从商店下架，已装的照常能用')
    expect(html).not.toContain('已被平台停用')
    expect(button(html, 'uninstall')).not.toBe('')
    expect(button(html, 'install')).toBe('')
    expect(html).not.toContain('举报这个扩展')
  })

  it('详情 404、本机那份被平台停用：写停用原因，「启用」灰', () => {
    const html = render({
      detail: null,
      localPack: storePack({ enabled: false, blocked: { reason: '含恶意内容', at: '2026-10-16' } }),
    })
    expect(html).toContain('已从商店下架')
    expect(html).toContain('已被平台停用：含恶意内容')
    expect(button(html, 'enable')).toContain('disabled=""')
  })

  it('详情存在但本机那份被停用：写停用原因，有换回就显示「换回 X」', () => {
    const html = render({
      detail: detail({
        local: { key: 'k', version: '1.0.0', source: 'store', enabled: false, blocked: { reason: '坏了', at: 'x' } },
      }),
      update: { latest: '0.9.0', engineOk: true, rollbackTo: '0.9.0' },
    })
    expect(html).toContain('已被平台停用：坏了')
    expect(html).toContain('换回 0.9.0')
    expect(button(html, 'enable')).toContain('disabled=""')
    expect(html).not.toContain('已从商店下架')
  })

  it('详情取失败（503 / 连不上）、本机已装：不说下架，写错误和「重试」，本机那份照常显示', () => {
    for (const msg of ['云端暂时不可用，稍后再试', '连不上扩展商店，检查一下网络']) {
      const html = render({ detail: null, localPack: storePack(), loadError: msg, onRetry: noop })
      expect(html).not.toContain('已从商店下架')
      expect(html).toContain(`商店详情没取到：${msg}`)
      expect(html).toContain('data-store-retry')
      expect(html).toContain('Swift 支持')
      expect(button(html, 'uninstall')).not.toBe('')
    }
  })

  it('详情取失败、本机也没有：只写错误，不说「不在商店里」', () => {
    const html = render({ detail: null, localPack: null, loadError: '云端暂时不可用', onRetry: noop })
    expect(html).toContain('商店详情没取到：云端暂时不可用')
    expect(html).not.toContain('这个扩展不在商店里')
    expect(html).not.toContain('已从商店下架')
  })

  it('还在取详情时（第一次打开、点了重试）不说下架，也不显示错误', () => {
    const html = render({ detail: null, localPack: storePack(), loading: true, loadError: '旧的错误' })
    expect(html).not.toContain('已从商店下架')
    expect(html).not.toContain('商店详情没取到')
  })

  it('详情 200：没有下架和错误提示', () => {
    const html = render({ localPack: storePack() })
    expect(html).not.toContain('已从商店下架')
    expect(html).not.toContain('商店详情没取到')
  })

  it('停用名单解除后：以实时的本机那份为准，不再用详情里取到的旧 blocked', () => {
    const html = render({
      detail: detail({
        local: {
          key: 'store-1',
          version: '1.0.0',
          source: 'store',
          enabled: false,
          blocked: { reason: '坏了', at: 'x' },
        },
      }),
      localPack: storePack({ enabled: false }),
    })
    expect(html).not.toContain('已被平台停用')
    expect(button(html, 'enable')).not.toBe('')
    expect(button(html, 'enable')).not.toContain('disabled=""')
  })

  it('没登录：举报入口写「登录后举报」', () => {
    expect(render({ signedIn: false })).toContain('登录后举报')
  })

  it('错误文案显示在按钮下面', () => {
    expect(render({ error: '下载失败：连不上扩展商店' })).toContain('下载失败：连不上扩展商店')
  })

  it('图标取不到时显示名字首字母', () => {
    expect(render({ iconSrc: null })).toContain('>S</span>')
  })
})
