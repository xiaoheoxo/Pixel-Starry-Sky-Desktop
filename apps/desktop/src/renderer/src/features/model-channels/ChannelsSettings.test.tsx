import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ENGINES } from '@pixelsky/protocol'
import { I18nProvider } from '@/i18n/I18nProvider'
import { setCurrentLocale } from '@/i18n/core'
import type { EngineLite } from '@/data/types'
import { ChannelsSettings } from './ChannelsSettings'

const state = vi.hoisted(() => ({ engines: [] as EngineLite[] }))
vi.mock('@/features/account/useAccount', () => ({ useAccount: () => ({}) }))
vi.mock('@/features/account/platform', async original => ({
  ...(await original<typeof import('@/features/account/platform')>()),
  usePlatformCatalog: () => ({ email: null, loaded: true, loading: false, groups: [], hiddenModels: [] }),
}))
vi.mock('@/features/account/providers', () => ({ useProviders: () => ({ providers: [] }) }))
vi.mock('@/features/engine/catalog', () => ({ useEngineCatalog: () => null }))
vi.mock('@/features/engine/store', () => ({ useEngineState: () => 'codex' }))
vi.mock('@/features/machines/store', () => ({ useMachines: () => ({ currentId: 'local' }) }))
vi.mock('@/features/settings/SettingsProvider', () => ({ useSettings: () => ({ openSettings: vi.fn() }) }))
vi.mock('@/features/settings/models/CustomApiSettings', () => ({ CustomApiSettings: () => null }))
vi.mock('./loginStore', () => ({ useChannelEngines: () => state.engines, logoutEngine: vi.fn() }))
vi.mock('./channelPrefs', () => ({
  useChannelPrefs: () => ({ newTask: { mode: 'last' }, menuLayout: 'tabs', executors: {}, googleNote: '' }),
  setGoogleNote: vi.fn(),
  setMenuLayout: vi.fn(),
}))
vi.mock('./accountsStore', () => ({
  ACCOUNT_ENGINE: { claude: 'claude', chatgpt: 'codex' },
  openAccountsPage: vi.fn(),
  useAccounts: (engine: string) => (engine === 'codex' ? { accounts: [{ id: 'default' }], current: 'default' } : null),
}))
vi.mock('./AccountsUI', () => ({ AccountPickList: () => null }))
vi.mock('./newTaskDefault', () => ({ currentNewTaskChoice: vi.fn(), pinNewTask: vi.fn() }))

const render = () =>
  renderToStaticMarkup(
    <I18nProvider>
      <ChannelsSettings />
    </I18nProvider>,
  )
const card = (html: string, id: string) =>
  html.split(`data-channel-card="${id}"`)[1]?.split('data-channel-card=')[0] ?? ''

beforeEach(() => {
  setCurrentLocale('zh-CN')
  state.engines = [
    {
      ...ENGINES.codex,
      status: 'ready',
      message: null,
      version: null,
      path: null,
      auth: { kind: 'login' },
      account: { email: 'shared@example.com', plan: 'pro' },
    },
    { ...ENGINES.dot, status: 'ready', message: null, version: null, path: null },
  ]
})

describe('model channel settings Dot entry', () => {
  it('shows a separate Dot card beside ChatGPT with the same account and management controls', () => {
    const html = render()
    expect(html.indexOf('data-channel-card="dot"')).toBeGreaterThan(html.indexOf('data-channel-card="chatgpt"'))
    expect(html.indexOf('data-channel-card="dot"')).toBeLessThan(html.indexOf('data-channel-card="google"'))
    for (const id of ['dot', 'chatgpt']) {
      expect(card(html, id)).toContain('shared@example.com')
      expect(card(html, id)).toContain('切换账号')
      expect(card(html, id)).toContain('管理账号')
    }
    expect(card(html, 'dot')).toContain('与 Codex 共用 ChatGPT 登录')
    expect(html).not.toContain('DOT_ACCESS_TOKEN')
  })

  it('offers ChatGPT login from Dot when the shared account is signed out', () => {
    state.engines = state.engines.map(e => ({ ...e, status: 'unauthenticated' }))
    expect(card(render(), 'dot')).toContain('登录 ChatGPT')
  })

  it('keeps account controls available and reports Dot connection failures separately', () => {
    state.engines[1] = { ...state.engines[1], status: 'error', message: 'No primary Dot; create one in ChatGPT' }
    const html = card(render(), 'dot')
    expect(html).toContain('shared@example.com')
    expect(html).toContain('No primary Dot')
    expect(html).toContain('管理账号')
  })
  it('hides the Dot card for Plus subscriptions', () => {
    state.engines[0] = { ...state.engines[0], account: { email: 'plus@example.com', plan: 'plus' } }
    expect(render()).not.toContain('data-channel-card="dot"')
  })
})
