import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/i18n/I18nProvider'
import { setCurrentLocale } from '@/i18n/core'

let mockAdvisor: {
  evaluator: string | null
  dispatchMode?: 'suggest' | 'force'
  evaluatorPicksModel?: true
  extraModels?: string[]
  models: [string | null, string | null, string | null, (string | null)?]
} | null = {
  evaluator: 'gpt-6.2-luna',
  dispatchMode: 'suggest',
  evaluatorPicksModel: true,
  extraModels: ['gpt-6.1-terra'],
  models: ['gpt-6.2-luna', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6.2-astra'],
}

vi.mock('@/features/engine', () => ({
  bridge: { setConfig: vi.fn() },
  useEngineState: (sel: (s: unknown) => unknown) =>
    sel({
      config: { codex: { subagentAdvisor: mockAdvisor } },
      modelDetails: {},
    }),
}))

vi.mock('@/features/engine/catalog', () => ({
  useEngineCatalog: () => ({
    models: [
      {
        id: 'gpt-6.2-luna',
        label: 'GPT-6.2 Luna',
        efforts: ['low'],
        defaultEffort: 'low',
        inputModalities: ['text'],
        isDefault: false,
      },
      {
        id: 'gpt-6.2-sol',
        label: 'GPT-6.2 Sol',
        efforts: ['medium'],
        defaultEffort: 'medium',
        inputModalities: ['text'],
        isDefault: false,
      },
      {
        id: 'gpt-6.1-terra',
        label: 'GPT-6.1 Terra',
        efforts: ['high'],
        defaultEffort: 'high',
        inputModalities: ['text'],
        isDefault: false,
      },
      {
        id: 'gpt-6.2-astra',
        label: 'GPT-6.2 Astra',
        efforts: ['xhigh'],
        defaultEffort: 'xhigh',
        inputModalities: ['text'],
        isDefault: true,
      },
    ],
    outputStyles: [],
    currentOutputStyle: null,
  }),
}))

import { AgnesAdvisorCard } from './AgnesAdvisorCard'

afterEach(() => {
  vi.unstubAllGlobals()
  setCurrentLocale('zh-CN')
})

function renderCard(): string {
  vi.stubGlobal('localStorage', { getItem: () => 'zh-CN', setItem: () => undefined })
  return renderToStaticMarkup(
    <I18nProvider>
      <AgnesAdvisorCard />
    </I18nProvider>,
  )
}

describe('AgnesAdvisorCard', () => {
  it('renders Scheme 1 borderless card with 2-mode dispatch, 4-tier grid, and collapsed advanced section', () => {
    const html = renderCard()
    expect(html).toContain('rounded-xl bg-surface shadow-sm')
    expect(html).toContain('Agnes 子智能体模型建议')
    expect(html).toContain('建议')
    expect(html).toContain('强制')
    expect(html).not.toContain('旧版')
    expect(html).toContain('轻量任务')
    expect(html).toContain('常规任务')
    expect(html).toContain('困难任务')
    expect(html).toContain('极难任务')
    expect(html).toContain('进阶：让评估模型自主选型与额外候选池')
    expect(html).toContain('已添 1 个')
  })

  it('hides tier configuration when Agnes is disabled', () => {
    mockAdvisor = null
    const html = renderCard()
    expect(html).toContain('Agnes 子智能体模型建议')
    expect(html).not.toContain('派遣执行方式')
    expect(html).not.toContain('轻量任务')
  })
})
