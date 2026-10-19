// 扩展页的三个页签：都在、默认选中「已安装」、openExtTab 之后渲染对应的页
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
// 「已安装」里的 AI 引擎插件区是另一个大模块，这里不需要
vi.mock('../plugins/PluginsSection', () => ({ PluginsSection: () => null }))
// 机器 store 的 hook 没有服务端快照，静态渲染时换成固定值
vi.mock('@/features/machines/store', () => ({ useMachines: () => ({ currentId: 'local' }) }))
import { I18nProvider } from '@/i18n/I18nProvider'
import { openExtDetail, openExtTab } from '@/features/extstore/nav'
import { ExtTabs } from './ExtTabs'
import { ExtensionsSection } from './ExtensionsSection'

const render = (): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <ExtensionsSection />
    </I18nProvider>,
  )

describe('ExtensionsSection 页签', () => {
  it('三个页签都在，默认选中「已安装」，渲染的是原来的列表', () => {
    openExtTab('installed')
    const html = render()
    expect(html).toContain('role="tablist"')
    for (const label of ['发现', '已安装', '我的发布']) expect(html).toContain(label)
    expect(html).toMatch(/id="ext-tab-installed"[^>]*aria-selected="true"/)
    expect(html).toMatch(/id="ext-tab-discover"[^>]*aria-selected="false"/)
    expect(html).toContain('从文件夹加载')
    expect(html).not.toContain('data-ext-discover')
  })

  it('openExtTab(「discover」) 以后渲染的是发现页', () => {
    openExtTab('discover')
    const html = render()
    expect(html).toMatch(/id="ext-tab-discover"[^>]*aria-selected="true"/)
    expect(html).toContain('data-ext-discover')
    expect(html).not.toContain('从文件夹加载')
    openExtTab('installed')
  })

  it('点进详情时渲染详情页（取到之前是加载中）和返回键，页签仍在', () => {
    openExtDetail('pixelsky.swift')
    const html = render()
    expect(html).toContain('data-store-detail="pixelsky.swift"')
    expect(html).toContain('role="tablist"')
    expect(html).not.toContain('data-ext-discover')
    openExtTab('installed')
  })

  it('「我的发布」渲染发布页（没登录时是登录入口）', () => {
    openExtTab('publish')
    const html = render()
    expect(html).toContain('data-publish="signed-out"')
    expect(html).not.toContain('从文件夹加载')
    openExtTab('installed')
  })
})

describe('ExtTabs', () => {
  it('已安装个数显示在「已安装」后面，0 时不显示；选中的页签 tabIndex 是 0', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ExtTabs value="installed" onChange={() => {}} installedCount={12} />
      </I18nProvider>,
    )
    expect(html).toMatch(/已安装<span[^>]*>12</)
    expect(html).toMatch(/id="ext-tab-installed"[^>]*tabindex="0"/)
    expect(html).toMatch(/id="ext-tab-discover"[^>]*tabindex="-1"/)
    const none = renderToStaticMarkup(
      <I18nProvider>
        <ExtTabs value="discover" onChange={() => {}} installedCount={0} />
      </I18nProvider>,
    )
    expect(none).not.toMatch(/已安装<span/)
  })
})
