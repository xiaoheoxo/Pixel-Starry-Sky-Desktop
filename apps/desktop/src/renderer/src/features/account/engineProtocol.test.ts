import { describe, expect, it } from 'vitest'
import type { ProviderView } from '../../../../shared/types/providers'
import type { PlatformGroupInfo } from '../../../../shared/types/platform-catalog'
import { providersFor } from './providers'
import { groupSupportsEngine } from './platform'

const view = (id: string, protocol: ProviderView['protocol']) => ({ id, protocol }) as ProviderView
const list = [view('a', 'anthropic'), view('r', 'responses'), view('c', 'chat')]
const group = (patch: Partial<PlatformGroupInfo>) => ({ id: '1', platform: '', ...patch }) as PlatformGroupInfo

describe('引擎能用哪些自定义接口', () => {
  it('Claude Code 看不到 Responses / Chat，Codex 看不到 Anthropic / Chat，像素星空三种都有', () => {
    expect(providersFor(list, 'claude').map(p => p.id)).toEqual(['a'])
    expect(providersFor(list, 'codex').map(p => p.id)).toEqual(['r'])
    expect(providersFor(list, 'pixel').map(p => p.id)).toEqual(['a', 'r', 'c'])
  })
  it('平台线路：openai 线路给 Codex 和 Pixel，anthropic 线路给 Claude Code 和 Pixel', () => {
    const openai = group({ platform: 'openai' }),
      anthropic = group({ platform: 'anthropic' })
    expect(['claude', 'codex', 'pixel'].filter(e => groupSupportsEngine(openai, e as never))).toEqual([
      'codex',
      'pixel',
    ])
    expect(['claude', 'codex', 'pixel'].filter(e => groupSupportsEngine(anthropic, e as never))).toEqual([
      'claude',
      'pixel',
    ])
    expect(groupSupportsEngine(group({ supported_engines: ['codex'], supported_apis: ['responses'] }), 'pixel')).toBe(
      true,
    )
    expect(groupSupportsEngine(group({ supported_engines: ['claude'], supported_apis: ['messages'] }), 'codex')).toBe(
      false,
    )
  })
})
