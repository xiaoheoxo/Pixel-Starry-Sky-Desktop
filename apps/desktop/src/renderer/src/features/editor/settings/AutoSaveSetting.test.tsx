import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

async function render(prefs: object | null): Promise<string> {
  vi.resetModules()
  vi.stubGlobal('localStorage', {
    getItem: () => (prefs ? JSON.stringify(prefs) : null),
    setItem: () => {},
  })
  // 重置模块后组件拿的是新的 I18nProvider，测试也要用同一份
  const { I18nProvider } = await import('@/i18n/I18nProvider')
  const { AutoSaveSetting } = await import('./AutoSaveSetting')
  return renderToStaticMarkup(
    <I18nProvider>
      <AutoSaveSetting />
    </I18nProvider>,
  )
}

describe('设置 › 编辑器 › 自动保存', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('默认关闭：显示「关闭」和按 Ctrl+S 保存的说明，没有延迟输入框和 AI 的说明', async () => {
    const html = await render(null)
    expect(html).toContain('data-setting-title="自动保存"')
    expect(html).toContain('关闭')
    expect(html).toContain('不自动保存，按 Ctrl+S 保存')
    expect(html).not.toContain('data-autosave-delay')
    expect(html).not.toContain('AI 正在这个项目里干活时先不存')
  })

  it('停止输入后：有延迟输入框，说明里写秒数', async () => {
    const html = await render({ mode: 'afterDelay', delay: 1500 })
    expect(html).toContain('data-autosave-delay')
    expect(html).toContain('value="1500"')
    expect(html).toContain('停止输入 1.5 秒后自动保存')
    expect(html).toContain('AI 正在这个项目里干活时先不存')
  })

  it('编辑器失去焦点时：显示对应说明', async () => {
    const html = await render({ mode: 'onFocusChange' })
    expect(html).toContain('编辑器失去焦点时')
    expect(html).toContain('换标签页或切到别的窗口时')
  })
})
