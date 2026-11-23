import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/i18n/I18nProvider'
import { setCurrentLocale } from '@/i18n/core'
import { ModelRow } from './ModelMenuRow'

afterEach(() => {
  vi.unstubAllGlobals()
  setCurrentLocale('zh-CN')
})

function renderRow(ui: React.ReactNode): string {
  vi.stubGlobal('localStorage', { getItem: () => 'zh-CN', setItem: () => undefined })
  return renderToStaticMarkup(<I18nProvider>{ui}</I18nProvider>)
}

describe('ModelMenuRow (compact 2-line layout)', () => {
  it('hides API USD reference price chip on ChatGPT subscription channel while keeping full price in hover tooltip', () => {
    const html = renderRow(
      <ModelRow
        title="GPT-6.2 Astra"
        modelId="gpt-6.2-astra"
        channel="chatgpt"
        position="旗舰"
        guide={{ main: '适合架构决策和大规模重构。', evaluator: '' }}
        price={{ basis: 'standard', price: { currency: 'USD', input: 8, output: 40 } }}
      />,
    )
    expect(html).toContain('min-height:48px')
    expect(html).toContain('data-model-position')
    expect(html).toContain('bg-accent-soft text-accent-fg')
    expect(html).toContain('data-model-guide')
    expect(html).not.toContain('data-model-price')
    expect(html).toContain('USD 8 入 / 40 出')
    expect(html).not.toContain('IQ')
  })

  it('shows compact price chip on custom relay channel and when user explicitly configured a custom price', () => {
    const relayHtml = renderRow(
      <ModelRow
        title="gpt-6.2-sol"
        modelId="gpt-6.2-sol"
        channel="custom"
        position="次旗舰"
        guide={{ main: '日常工程开发主力。', evaluator: '' }}
        price={{ basis: 'relay-reference', price: { currency: 'USD', input: 2, output: 10 } }}
      />,
    )
    expect(relayHtml).toContain('data-model-price')
    expect(relayHtml).toContain('$2/$10 参考')

    const customHtml = renderRow(
      <ModelRow
        title="GPT-6.2 Sol"
        modelId="gpt-6.2-sol"
        channel="chatgpt"
        customEdited
        guide={{ main: '自填说明', evaluator: '' }}
        price={{ basis: 'custom', price: { currency: 'CNY', input: 8, output: 24 } }}
      />,
    )
    expect(customHtml).toContain('data-model-price')
    expect(customHtml).toContain('¥8/¥24 自填')
    expect(customHtml).toContain('已自填')
  })
})
