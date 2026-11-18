import { describe, expect, it } from 'vitest'
import type { EngineCatalog } from './types'
import { codexUltrafastAllowed, platformUltrafastModel, platformUltrafastMultiplier } from './util'

// docs/codex-ultrafast-platform.md：照 sub2api 0.2.23 的名单和倍率
describe('Codex 平台线路的 Ultrafast', () => {
  it('只认 sub2api 按 Ultrafast 计价的模型，带 provider 前缀也认', () => {
    for (const m of [
      'gpt-6.2-sol',
      'gpt-6.2-astra',
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-6-astra-1010',
      'openai/GPT-6.2-Sol',
    ])
      expect(platformUltrafastModel(m)).toBe(true)
    for (const m of ['gpt-6-sol', 'gpt-6.1-terra', 'gpt-5.6-sol', 'gpt-6-astral', 'grok-4.7', '', null])
      expect(platformUltrafastModel(m)).toBe(false)
  })
  it('倍数：GPT-6.2 在 2027-03-01 00:00 太平洋时间前 3 倍，之后和其余模型一样 6 倍', () => {
    const before = Date.UTC(2027, 2, 1, 7, 59)
    const after = Date.UTC(2027, 2, 1, 8)
    expect(platformUltrafastMultiplier('gpt-6.2-sol', before)).toBe(3)
    expect(platformUltrafastMultiplier('gpt-6.2-astra', after)).toBe(6)
    expect(platformUltrafastMultiplier('gpt-6-astra', before)).toBe(6)
  })
  it('平台按名单，自定义接口不给，自己登录照官方规则', () => {
    const platform = { platform: { groupId: '1', account: 'a@example.com' } }
    expect(codexUltrafastAllowed(platform, null, 'gpt-6.2-sol')).toBe(true)
    expect(codexUltrafastAllowed(platform, null, 'gpt-6-sol')).toBe(false)
    expect(codexUltrafastAllowed({ provider: { id: 'p' } }, null, 'gpt-6.2-sol')).toBe(false)
    const catalog = {
      authType: 'chatgpt',
      models: [{ id: 'gpt-6.2-sol', ultrafast: true }],
    } as unknown as EngineCatalog
    expect(codexUltrafastAllowed({}, catalog, 'gpt-6.2-sol')).toBe(true)
    expect(codexUltrafastAllowed({}, null, 'gpt-6.2-sol')).toBe(false)
  })
})
