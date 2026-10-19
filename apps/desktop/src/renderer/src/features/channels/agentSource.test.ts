import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
import type { PlatformGroup } from '@/features/account/platform'
import type { ProviderView } from '../../../../shared/types/providers'
import {
  modelChoices,
  modelForSource,
  platformModelsFor,
  settingsForSource,
  sourceKeyOf,
  sourceOptions,
  type SourceContext,
} from './agentSource'

// AI 成员的额度来源：自有账号 / 像素星空平台 / 自定义接口（docs/ui/channels-local-ai.md §3.1 #1）

const group = (
  id: string,
  rate: number,
  models: string[],
  engines?: PlatformGroup['supported_engines'],
): PlatformGroup => ({
  id,
  name: id,
  description: '',
  platform: 'x',
  rate_multiplier: rate,
  billing_source: 'balance',
  models,
  modelsError: null,
  ...(engines ? { supported_engines: engines } : {}),
})
const provider = (id: string, protocol: ProviderView['protocol'], models: string[]): ProviderView =>
  ({ id, name: `接口 ${id}`, protocol, models: models.map(m => ({ id: m })) }) as unknown as ProviderView

const groups = [
  group('g-claude-cheap', 0.5, ['claude-sonnet-5-5'], ['claude']),
  group('g-claude', 1, ['claude-opus-5-5', 'claude-sonnet-5-5'], ['claude']),
  group('g-gpt', 1, ['gpt-5.5'], ['codex']),
]
const ctx: SourceContext = {
  email: 'me@example.com',
  groups,
  providers: [provider('anth', 'anthropic', ['my-claude']), provider('resp', 'responses', ['my-gpt', 'my-gpt-mini'])],
}
const own = [{ id: 'opus', label: 'Opus' }]

describe('来源选项', () => {
  it('自有账号、平台、这个引擎能用的接口；Claude Code 看不到 Responses 协议的接口', () => {
    expect(sourceOptions('claude', ctx).map(o => o.value)).toEqual(['self', 'platform', 'custom:anth'])
    expect(sourceOptions('codex', ctx).map(o => o.value)).toEqual(['self', 'platform', 'custom:resp'])
  })
  it('没登录像素星空：平台灰掉写「登录后可用」；平台上没有这个引擎的线路：灰掉写「没有线路」', () => {
    expect(sourceOptions('claude', { ...ctx, email: null })[1]).toMatchObject({ value: 'platform', disabled: 'signin' })
    const onlyGpt = { ...ctx, groups: [groups[2]] }
    expect(sourceOptions('claude', onlyGpt)[1]).toMatchObject({ disabled: 'no-route' })
    expect(sourceOptions('codex', onlyGpt)[1].disabled).toBeUndefined()
  })
  it('从已存的设置认出来源', () => {
    expect(sourceKeyOf(undefined)).toBe('self')
    expect(sourceKeyOf({ model: 'opus' })).toBe('self')
    expect(sourceKeyOf({ platform: { groupId: 'g', account: 'a' } })).toBe('platform')
    expect(sourceKeyOf({ provider: { id: 'anth' } })).toBe('custom:anth')
  })
})

describe('模型列表', () => {
  it('平台只列这个引擎能跑的模型（模型协议 + 线路声明）', () => {
    expect(platformModelsFor('claude', groups)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5'])
    expect(platformModelsFor('codex', groups)).toEqual(['gpt-5.5'])
  })
  it('自有账号用引擎目录；自定义接口用接口里的模型', () => {
    expect(modelChoices('claude', 'self', ctx, own)).toEqual(own)
    expect(modelChoices('codex', 'custom:resp', ctx, own).map(m => m.id)).toEqual(['my-gpt', 'my-gpt-mini'])
  })
  it('换来源：模型还在列表里就保留，否则平台 / 接口取第一个，自有账号回到默认', () => {
    expect(modelForSource('claude', 'platform', 'claude-opus-5-5', ctx, own)).toBe('claude-opus-5-5')
    expect(modelForSource('claude', 'platform', 'opus', ctx, own)).toBe('claude-sonnet-5-5')
    expect(modelForSource('codex', 'custom:resp', 'my-gpt-mini', ctx, own)).toBe('my-gpt-mini')
    expect(modelForSource('codex', 'custom:resp', 'gpt-5.5', ctx, own)).toBe('my-gpt')
    expect(modelForSource('claude', 'self', 'claude-opus-5-5', ctx, own)).toBe('')
    expect(modelForSource('claude', 'self', 'opus', ctx, own)).toBe('opus')
  })
})

describe('存进成员配置的设置', () => {
  it('自有账号：只有模型（默认时什么都不写）', () => {
    expect(settingsForSource('claude', 'self', 'opus', ctx)).toEqual({ model: 'opus' })
    expect(settingsForSource('claude', 'self', '', ctx)).toEqual({})
  })
  it('平台：按模型取倍率最低、支持这个引擎的线路，记下登录的账号', () => {
    expect(settingsForSource('claude', 'platform', 'claude-sonnet-5-5', ctx)).toEqual({
      platform: { groupId: 'g-claude-cheap', account: 'me@example.com' },
      model: 'claude-sonnet-5-5',
    })
    expect(settingsForSource('claude', 'platform', 'claude-opus-5-5', ctx).platform?.groupId).toBe('g-claude')
    expect(settingsForSource('codex', 'platform', 'gpt-5.5', ctx).platform?.groupId).toBe('g-gpt')
  })
  it('自定义接口：记接口 id 和模型', () => {
    expect(settingsForSource('codex', 'custom:resp', 'my-gpt-mini', ctx)).toEqual({
      provider: { id: 'resp' },
      model: 'my-gpt-mini',
    })
  })
  it('平台没登录、没线路、接口删了：报错（界面已经灰掉，这里兜底）', () => {
    expect(() => settingsForSource('claude', 'platform', 'claude-opus-5-5', { ...ctx, email: null })).toThrow()
    expect(() => settingsForSource('claude', 'platform', 'x', { ...ctx, groups: [groups[2]] })).toThrow()
    expect(() => settingsForSource('claude', 'custom:gone', 'm', ctx)).toThrow()
  })
})
