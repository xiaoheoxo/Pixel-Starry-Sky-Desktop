import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubagentAdvisor } from '@pixelsky/protocol'
import { I18nProvider } from '@/i18n/I18nProvider'
import { setCurrentLocale } from '@/i18n/core'
import { AgnesAdvisorCard } from './AgnesAdvisorCard'
import { CodexSubagentCard } from './CodexSubagentCard'

const engine = vi.hoisted(() => ({ config: { codex: {} as { subagentAdvisor?: SubagentAdvisor } } }))
vi.mock('@/features/engine', () => ({
  useEngineState: (select: (state: typeof engine) => unknown) => select(engine),
}))
vi.mock('@/features/engine/catalog', () => ({
  useEngineCatalog: () => ({ models: [{ id: 'configured-model', label: 'Configured model', efforts: [] }] }),
}))

function render(card: React.ReactElement): string {
  vi.stubGlobal('localStorage', { getItem: () => 'zh-CN', setItem: () => undefined })
  setCurrentLocale('zh-CN')
  return renderToStaticMarkup(<I18nProvider>{card}</I18nProvider>)
}

afterEach(() => {
  engine.config.codex = {}
  vi.unstubAllGlobals()
})

describe('Agnes settings placement', () => {
  it('has a searchable card and remains off by default', () => {
    const html = render(<AgnesAdvisorCard />)
    expect(html).toContain('data-setting-title="Agnes 子智能体模型建议"')
    expect(html).toContain('aria-checked="false"')
    expect(html).not.toContain('困难任务')
  })

  it('reads the existing Codex advisor settings without migrating or reinitializing them', () => {
    engine.config.codex.subagentAdvisor = {
      evaluator: 'configured-model',
      models: ['configured-model', null, null],
      evaluatorPicksModel: true,
      extraModels: ['previous-extra'],
    }
    const html = render(<AgnesAdvisorCard />)
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('Configured model')
    expect(html).toContain('previous-extra')
  })

  it('leaves native subagent defaults in the Codex card without duplicating Agnes', () => {
    const html = render(<CodexSubagentCard onError={() => undefined} />)
    expect(html).toContain('Codex 子智能体')
    expect(html).toContain('子智能体模型')
    expect(html).not.toContain('Agnes')
  })
})
