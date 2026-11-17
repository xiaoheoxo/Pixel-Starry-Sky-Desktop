import { describe, expect, it } from 'vitest'
import type { ProviderView } from '../../../../shared/types/providers'
import type { PlatformGroupInfo } from '../../../../shared/types/platform-catalog'
import { menuProvider, providersFor } from './providers'
import { groupSupportsEngine } from './platform'

const view = (id: string, protocol: ProviderView['protocol']) => ({ id, protocol }) as ProviderView
const list = [view('a', 'anthropic'), view('r', 'responses'), view('c', 'chat'), view('g', 'gemini')]
const group = (patch: Partial<PlatformGroupInfo>) => ({ id: '1', platform: '', ...patch }) as PlatformGroupInfo

describe('引擎能用哪些自定义接口', () => {
  it('Claude Code 只有 Anthropic，Codex 只有 Responses，像素星空三种（没有 Gemini），Antigravity 只有 Gemini', () => {
    expect(providersFor(list, 'claude').map(p => p.id)).toEqual(['a'])
    expect(providersFor(list, 'codex').map(p => p.id)).toEqual(['r'])
    expect(providersFor(list, 'pixel').map(p => p.id)).toEqual(['a', 'r', 'c'])
    // Antigravity 只能用 Gemini 接口（不然频道成员 / 输入框会列出它用不了的 Anthropic 接口）
    expect(providersFor(list, 'antigravity').map(p => p.id)).toEqual(['g'])
  })
  it('模型菜单里的 Gemini 接口：agy 目录里也有的；读不到目录、一个都对不上时列接口的（不列接口没有的名字）；别的协议不动', () => {
    const p = { ...view('g', 'gemini'), models: [{ id: 'gemini-3.1-pro', contextWindow: 1 }, { id: 'gemini-x' }] }
    expect(menuProvider(p, ['gemini-3.8-flash', 'gemini-3.1-pro']).models).toEqual([
      { id: 'gemini-3.1-pro', contextWindow: 1 },
    ])
    expect(menuProvider(p, [])).toBe(p)
    expect(menuProvider(p, ['gemini-9'])).toBe(p)
    const a = { ...view('a', 'anthropic'), models: [{ id: 'm' }] }
    expect(menuProvider(a, ['gemini-9'])).toBe(a)
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
