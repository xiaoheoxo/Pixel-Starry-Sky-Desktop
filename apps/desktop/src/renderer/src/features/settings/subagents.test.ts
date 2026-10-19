import { describe, expect, it } from 'vitest'
import { siteKey, targetProblem } from './subagents'
import type { ProviderView } from '../../../../shared/types/providers'
import type { PlatformGroup } from '@/features/account/platform'

const provider = (over: Partial<ProviderView> = {}): ProviderView => ({
  id: 'ds',
  name: 'DeepSeek',
  template: 'custom',
  protocol: 'chat',
  baseUrl: 'https://api.deepseek.com',
  auth: 'bearer',
  models: [{ id: 'deepseek-chat' }],
  smallModel: null,
  modelFallback: false,
  keyHint: 'ab12',
  headerNames: [],
  insecure: false,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})
const group = { id: '7', name: '经济线路', models: ['gpt-5-mini'], rate_multiplier: 0.3 } as PlatformGroup

describe('设置 › 子智能体：选的站点能不能用', () => {
  const custom = { kind: 'custom', providerId: 'ds', model: 'deepseek-chat' } as const
  const route = { kind: 'platform', groupId: '7', account: 'a@b.c', model: 'gpt-5-mini' } as const
  const signedIn = { email: 'a@b.c', loaded: true, groups: [group] }

  it('自定义接口：删了、没 Key、模型不在了', () => {
    expect(targetProblem(custom, [provider()], signedIn)).toBeNull()
    expect(targetProblem(custom, [], signedIn)).toBe('providerGone')
    expect(targetProblem(custom, [provider({ keyHint: null })], signedIn)).toBe('noKey')
    expect(targetProblem(custom, [provider({ models: [{ id: 'other' }] })], signedIn)).toBe('modelGone')
  })

  it('平台线路：换了账号、线路没了、模型下线；目录还没读到时不报', () => {
    expect(targetProblem(route, [], signedIn)).toBeNull()
    expect(targetProblem(route, [], { ...signedIn, email: null })).toBe('signedOut')
    expect(targetProblem(route, [], { ...signedIn, groups: [] })).toBe('routeGone')
    expect(targetProblem(route, [], { ...signedIn, groups: [{ ...group, models: ['gpt-5'] }] })).toBe('modelGone')
    expect(targetProblem(route, [], { email: 'a@b.c', loaded: false, groups: [] })).toBeNull()
  })

  it('下拉框的值', () => {
    expect(siteKey(custom)).toBe('custom:ds')
    expect(siteKey(route)).toBe('platform:7')
  })
})
