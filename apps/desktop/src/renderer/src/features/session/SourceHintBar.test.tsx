// 已开始的对话换额度来源 / 换引擎的确认条：还有后台任务时说清楚会一起结束（docs/ui/source-switch.md §9）
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ENGINES, type EngineInfo } from '@pixelsky/protocol'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {}
})
vi.mock('@/features/account/useAccount', () => ({ useAccount: () => ({ status: 'signedIn' }) }))
vi.mock('@/features/account/platform', () => ({
  usePlatform: () => ({ groups: [], groupId: null, providerId: null }),
  groupsForModel: () => [],
  refreshPlatform: () => undefined,
}))
vi.mock('@/features/settings/SettingsProvider', () => ({ useSettings: () => ({}) }))
vi.mock('@/features/account/providers', () => ({ useProviders: () => ({ providers: [] }), providersFor: () => [] }))
vi.mock('@/features/engine/catalog', () => ({ useEngineCatalog: () => null }))
import { I18nProvider } from '@/i18n/I18nProvider'
import type { ComposerController } from '@/features/engine'
import { SourceHintBar } from './SourceHintBar'

const engine = (id: 'claude' | 'dot') =>
  ({ ...ENGINES[id], status: 'ready', version: '1.0.0', path: id, message: null }) as EngineInfo
const live = (patch: Partial<ComposerController>): ComposerController =>
  ({
    engine: engine('claude'),
    sessionEngine: engine('claude'),
    engines: [engine('claude')],
    running: false,
    channel: 'platform',
    groupId: null,
    engineHasSession: () => false,
    backgroundWork: { count: 0, names: [] },
    ...patch,
  }) as unknown as ComposerController

const render = (c: ComposerController) =>
  renderToStaticMarkup(
    <I18nProvider>
      <SourceHintBar
        live={c}
        confirm={{ source: 'self', choice: null }}
        onCancelConfirm={() => {}}
        onRequestSource={() => {}}
        onOpenMenu={() => {}}
      />
    </I18nProvider>,
  )

describe('换来源的确认条', () => {
  it('有后台命令在跑：多一句会一起结束，列出名字', () => {
    const html = render(live({ backgroundWork: { count: 2, names: ['npm run dev', 'pytest -x'] } }))
    expect(html).toContain('正在后台跑的 2 个任务（npm run dev、pytest -x）会一起结束。')
  })

  it('只有后台子智能体：说「后台子智能体」', () => {
    expect(render(live({ backgroundWork: { count: 1, names: [] } }))).toContain(
      '正在后台跑的 1 个任务（后台子智能体）会一起结束。',
    )
  })

  it('没有后台任务、或引擎的后台不在本机（Dot）：不提', () => {
    expect(render(live({}))).not.toContain('会一起结束')
    const dot = engine('dot')
    expect(
      render(live({ engine: dot, sessionEngine: dot, backgroundWork: { count: 1, names: ['云端任务'] } })),
    ).not.toContain('会一起结束')
  })
})
