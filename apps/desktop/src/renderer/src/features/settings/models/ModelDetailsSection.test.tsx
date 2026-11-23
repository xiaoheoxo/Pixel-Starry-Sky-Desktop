import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/i18n/I18nProvider'
import { setCurrentLocale } from '@/i18n/core'
import { modelDetailKey } from '@pixelsky/protocol'

let cloudCatalogState = true

vi.mock('@/features/engine', () => ({
  bridge: {
    setModelDetail: vi.fn(),
    setCloudModelCatalog: vi.fn(),
    modelDisplayReferences: vi.fn(),
  },
  useEngineState: (sel: (s: unknown) => unknown) =>
    sel({
      modelDetails: {
        [modelDetailKey({ channel: 'custom', sourceId: 'relay-1', model: 'gpt-6.2-sol' })]: {
          main: '公司中转主力',
          price: { currency: 'CNY', input: 8, output: 24 },
        },
      },
      cloudModelCatalog: cloudCatalogState,
    }),
}))

vi.mock('@/features/engine/catalog', () => ({
  useEngineCatalog: (engine: string) =>
    engine === 'codex'
      ? {
          models: [
            {
              id: 'gpt-6.2-sol',
              label: 'GPT-6.2 Sol',
              efforts: ['low', 'medium', 'high'],
              defaultEffort: 'medium',
              inputModalities: ['text'],
              isDefault: false,
              cloudReference: {
                description: 'Balanced coding model',
                price: { currency: 'USD', input: 2, output: 10 },
              },
            },
          ],
          outputStyles: [],
          currentOutputStyle: null,
        }
      : null,
}))

vi.mock('@/features/account/providers', () => ({
  useProviders: () => ({
    loaded: true,
    providers: [
      {
        id: 'relay-1',
        name: 'MyRelay',
        models: [{ id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', priceRef: 'openai/gpt-6.2-sol' }],
      },
    ],
  }),
}))

vi.mock('@/features/account/platform', () => ({
  usePlatform: () => ({ groups: [], email: null, loading: false, hiddenModels: [] }),
  platformModels: () => [],
}))

import { ModelDetailsSection } from './ModelDetailsSection'

afterEach(() => {
  vi.unstubAllGlobals()
  setCurrentLocale('zh-CN')
  cloudCatalogState = true
})

function renderSection(): string {
  vi.stubGlobal('localStorage', { getItem: () => 'zh-CN', setItem: () => undefined })
  return renderToStaticMarkup(
    <I18nProvider>
      <ModelDetailsSection />
    </I18nProvider>,
  )
}

describe('ModelDetailsSection', () => {
  it('renders Scheme 1 borderless cards with cloud toggle, custom count badge, and channel model list', () => {
    const html = renderSection()
    expect(html).toContain('rounded-xl bg-surface shadow-sm')
    expect(html).toContain('自动拉取公开模型说明与参考价')
    expect(html).toContain('模型明细与参考价格')
    expect(html).toContain('已自定义 1 个模型')
    expect(html).toContain('MyRelay')
    expect(html).toContain('ChatGPT')
    expect(html).toContain('gpt-6.2-sol')
    expect(html).toContain('填入原厂参考价')
  })

  it('shows offline notice when cloudModelCatalog is disabled', () => {
    cloudCatalogState = false
    const html = renderSection()
    expect(html).toContain('已关闭联网目录拉取')
  })
})
