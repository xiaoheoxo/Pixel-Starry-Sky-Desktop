import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/i18n/I18nProvider'
import { ModelDetailsSection } from './ModelDetailsSection'
import { channelModelDetail, modelRoleGuide } from '@/features/model-channels/modelRoleGuide'
import { modelDetailKey } from '@pixelsky/protocol'

vi.mock('@/features/account/providers', () => ({ useProviders: () => ({ providers: [] }) }))
vi.mock('@/features/engine', () => ({ bridge: null, useEngineState: () => undefined }))
vi.mock('@/features/engine/catalog', () => ({
  useEngineCatalog: (engine: string) =>
    engine === 'codex' ? { models: [{ id: 'gpt-6.2-astra', label: 'GPT 6.2 Astra' }] } : null,
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('model channel details', () => {
  it('prefills descriptions and labels the OpenAI rate as a reference only', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'zh-CN', setItem: () => undefined })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-23T00:00:00Z'))
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ModelDetailsSection platformGroups={[]} />
      </I18nProvider>,
    )
    expect(html).toContain('GPT 6.2 Astra')
    expect(html).toContain('适合架构决策')
    expect(html).toContain('复核误判代价高')
    expect(html).toContain('留空表示未知，不是免费')
    expect(html).toContain('官方 API Standard 短上下文参考价')
    expect(html).toMatch(/type="number"[^>]*value="8"/)
    expect(html).toMatch(/type="number"[^>]*value="40"/)
  })

  it('uses a local note only for the exact matching model channel', () => {
    const direct = { channel: 'chatgpt' as const, sourceId: null, model: 'gpt-6.2-astra' }
    const other = { channel: 'custom' as const, sourceId: 'endpoint', model: direct.model }
    const notes = { [modelDetailKey(direct)]: { main: 'manually entered' } }
    expect(modelRoleGuide(direct.model, channelModelDetail(notes, direct))?.main).toBe('manually entered')
    expect(modelRoleGuide(other.model, channelModelDetail(notes, other))?.main).not.toBe('manually entered')
  })
})
