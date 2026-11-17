import { describe, expect, it } from 'vitest'
import { fallbackSource, groupSupportsEngine } from '@/features/account/platform'
import { platformModelSupportsEngine } from '../../../../shared/platform-models'
import {
  buildChannelMenu,
  channelOf,
  executorsFor,
  parseNewTask,
  sourceOfChannel,
  type MenuInput,
} from './channelModel'

const input: MenuInput = {
  selection: null,
  current: null,
  platform: { email: null, loaded: true, loading: false, groups: [], hiddenModels: [] },
  selfModels: { claude: [], chatgpt: [], google: [] },
  providers: [],
  remembered: {},
  engines: [{ id: 'dot', status: 'ready', message: null }],
}

describe('Dot native channel', () => {
  it('offers a model-free Dot choice on capable hosts, with a persistent default', () => {
    const choice = { channel: 'dot', engine: 'dot', model: null, providerId: null } as const
    const group = buildChannelMenu(input).find(g => g.channel === 'dot')!
    expect(group.state.kind).toBe('ready')
    expect(group.rows[0].pick).toMatchObject({ engine: 'dot', unavailable: false })
    expect(group.rows[0].target).toEqual({ channel: 'dot', model: null, providerId: null })
    expect(executorsFor(choice, { groups: [], providers: [] })).toEqual(['dot'])
    expect(parseNewTask(JSON.stringify({ mode: 'fixed', choice }))).toEqual({ mode: 'fixed', choice })
    expect(channelOf('dot', 'self')).toBe('dot')
    expect(sourceOfChannel('dot')).toBe('self')
  })

  it('hides Dot unless this computer is signed in to ChatGPT Pro, and on older remote hosts', () => {
    expect(buildChannelMenu({ ...input, engines: [] }).some(g => g.channel === 'dot')).toBe(false)
    for (const status of ['unauthenticated', 'missing', 'error'] as const)
      expect(
        buildChannelMenu({ ...input, engines: [{ id: 'dot', status, message: null }] }).some(g => g.channel === 'dot'),
      ).toBe(false)
  })

  it('does not offer platform model routing for Dot, even when signed in', () => {
    expect(fallbackSource('dot', 'signed-in@example.com')).toBe('self')
    expect(platformModelSupportsEngine('gpt-6-astra', 'dot')).toBe(false)
    expect(platformModelSupportsEngine('unknown-model', 'dot')).toBe(false)
    expect(groupSupportsEngine({} as never, 'dot')).toBe(false)
  })
})
