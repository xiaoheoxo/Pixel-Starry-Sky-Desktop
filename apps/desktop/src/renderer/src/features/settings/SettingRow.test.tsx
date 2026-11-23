import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/i18n/I18nProvider'
import { setCurrentLocale } from '@/i18n/core'
import { SectionTitle, SettingGroup, SettingRow, SettingsPaneProvider } from './SettingRow'

afterEach(() => {
  vi.unstubAllGlobals()
  setCurrentLocale('zh-CN')
})

function wrap(ui: React.ReactNode): string {
  vi.stubGlobal('localStorage', { getItem: () => 'zh-CN', setItem: () => undefined })
  return renderToStaticMarkup(<I18nProvider>{ui}</I18nProvider>)
}

describe('SettingGroup / SettingRow / SectionTitle 布局底座', () => {
  it('独立挂载 SectionTitle 可见；在 SettingsPaneProvider 内转为 sr-only 避免与吸顶页头重复', () => {
    const standalone = wrap(<SectionTitle>通用</SectionTitle>)
    expect(standalone).toContain('text-section')
    expect(standalone).not.toContain('sr-only')

    const insidePane = wrap(
      <SettingsPaneProvider>
        <SectionTitle>通用</SectionTitle>
      </SettingsPaneProvider>,
    )
    expect(insidePane).toContain('sr-only')
    expect(insidePane).toContain('data-section-title')
  })

  it('SettingGroup 渲染圆角卡片容器并保留 data-setting-title 与外观锚点', () => {
    const html = wrap(
      <SettingGroup title="主题与配色" anchorId="theme" action={<button type="button">重置</button>}>
        <SettingRow title="主题" description="浅色或深色" control={<span>控件</span>} />
      </SettingGroup>,
    )
    expect(html).toContain('data-appearance-group="theme"')
    expect(html).toContain('data-setting-title="主题与配色"')
    expect(html).toContain('data-setting-title="主题"')
    expect(html).toContain('rounded-xl bg-surface shadow-sm')
    // 没有 children 时不渲染多余的 mt-3 展开容器
    expect(html).not.toContain('mt-3')
  })

  it('SettingRow 传入 children 时才渲染 mt-3 展开区', () => {
    const html = wrap(
      <SettingGroup>
        <SettingRow title="配色方案" description="8 套预设">
          <div>色卡列表</div>
        </SettingRow>
      </SettingGroup>,
    )
    expect(html).toContain('mt-3')
    expect(html).toContain('色卡列表')
  })
})
