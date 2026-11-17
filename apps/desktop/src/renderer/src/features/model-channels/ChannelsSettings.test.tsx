import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ENGINES } from '@pixelsky/protocol'
import { I18nProvider } from '@/i18n/I18nProvider'
import { setCurrentLocale } from '@/i18n/core'
import type { EngineLite } from '@/data/types'
import { ChannelsSettings } from './ChannelsSettings'

const state = vi.hoisted(() => ({ engines: [] as EngineLite[] }))
const dots = vi.hoisted(() => ({
  eligible: true,
  loading: false,
  errors: [] as string[],
  entries: [{ key: 'k', account: 'default', name: 'Nova', accountName: 'shared@example.com' }],
}))
vi.mock('@/features/dot/store', () => ({ useDots: () => dots }))
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
  dots.eligible = true
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
  it('lists Dots inside the ChatGPT card for signed-in Pro users, marked experimental', () => {
    const html = render()
    expect(html).not.toContain('data-channel-card="dot"')
    const chatgpt = card(html, 'chatgpt')
    expect(chatgpt).toContain('data-dot-channel')
    expect(chatgpt).toContain('Nova')
    expect(chatgpt).toContain('实验')
    expect(chatgpt).toContain('和 Codex 共用这里的登录')
    expect(html).not.toContain('DOT_ACCESS_TOKEN')
  })

  it('shows nothing about Dot unless this computer is signed in to ChatGPT Pro', () => {
    dots.eligible = false
    expect(render()).not.toContain('data-dot-channel')
    expect(render()).not.toContain('ChatGPT Dot')
  })
})
