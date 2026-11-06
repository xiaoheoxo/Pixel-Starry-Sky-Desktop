// 环境变量里的接口地址和 Key 一键迁到自定义 API（docs/ui/custom-api.md §3.4）
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderInput, ProviderView } from '../../../../../shared/types/providers'

const saved: ProviderInput[] = []
let failVendor: string | null = null
let source: 'self' | 'platform' | 'custom' = 'self'
const setDefaultCustom = vi.fn()

vi.mock('@/features/account/providers', () => ({
  saveProvider: async (input: ProviderInput): Promise<ProviderView> => {
    if (failVendor && input.protocol === failVendor) throw new Error('save failed')
    saved.push(input)
    return { id: `p${saved.length}`, name: input.name, protocol: input.protocol } as ProviderView
  },
}))
vi.mock('@/features/account/platform', () => ({
  getPlatformState: () => ({ source }),
  setDefaultCustom: (...args: unknown[]) => setDefaultCustom(...args),
}))

const { migrateEnv, providersFromEnv } = await import('./migrateEnv')

beforeEach(() => {
  saved.length = 0
  failVendor = null
  source = 'self'
  setDefaultCustom.mockReset()
})

describe('providersFromEnv', () => {
  it('Claude Code 的 ANTHROPIC_*：一个 Anthropic 协议的接口，名字不带厂商', () => {
    const [p, ...rest] = providersFromEnv('claude', { ANTHROPIC_API_KEY: 'sk-a', HTTPS_PROXY: 'x' })
    expect(rest).toEqual([])
    expect(p.input).toMatchObject({
      name: 'Claude Code 环境变量',
      protocol: 'anthropic',
      auth: 'x-api-key',
      apiKey: 'sk-a',
    })
    expect(p.keys).toEqual(['ANTHROPIC_API_KEY'])
  })

  it('像素星空只有 OPENAI_*：建 OpenAI Responses 接口（原来什么都不建、Key 被删掉）', () => {
    const list = providersFromEnv('pixel', { OPENAI_API_KEY: 'sk-o', OPENAI_BASE_URL: 'https://relay.example/v1' })
    expect(list).toHaveLength(1)
    expect(list[0].input).toMatchObject({
      name: 'Pixel 环境变量（OpenAI）',
      protocol: 'responses',
      template: 'custom',
      baseUrl: 'https://relay.example/v1',
      apiKey: 'sk-o',
    })
    expect(list[0].keys.sort()).toEqual(['OPENAI_API_KEY', 'OPENAI_BASE_URL'])
  })

  it('像素星空两种都有：每个厂商一个接口，Anthropic 在前', () => {
    const list = providersFromEnv('pixel', { anthropic_auth_token: 't', OPENAI_API_KEY: 'sk-o' })
    expect(list.map(p => [p.vendor, p.input.name, p.input.protocol])).toEqual([
      ['anthropic', 'Pixel 环境变量（Anthropic）', 'anthropic'],
      ['openai', 'Pixel 环境变量（OpenAI）', 'responses'],
    ])
    // ANTHROPIC_AUTH_TOKEN 是 Bearer；变量名大小写不敏感，删的时候用原名
    expect(list[0].input.auth).toBe('bearer')
    expect(list[0].keys).toEqual(['anthropic_auth_token'])
  })

  it('Codex 的 OPENAI_* 在前；别的厂商的变量名字带厂商', () => {
    const list = providersFromEnv('codex', { OPENAI_API_KEY: 'sk-o', ANTHROPIC_API_KEY: 'sk-a' })
    expect(list.map(p => p.input.name)).toEqual(['Codex 环境变量（OpenAI）', 'Codex 环境变量（Anthropic）'])
  })

  it('没有值的变量不建接口', () => {
    expect(providersFromEnv('pixel', { OPENAI_API_KEY: '  ' })).toEqual([])
  })
})

describe('migrateEnv', () => {
  it('像素星空：两个接口都建好、迁走的变量删掉、别的变量留着；默认改用第一个接口', async () => {
    const saveConfig = vi.fn(async () => {})
    const result = await migrateEnv(
      'pixel',
      { ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o', HTTPS_PROXY: 'http://127.0.0.1:7890' },
      saveConfig,
    )
    expect(saved.map(p => p.protocol)).toEqual(['anthropic', 'responses'])
    expect(saveConfig).toHaveBeenCalledWith({ env: { HTTPS_PROXY: 'http://127.0.0.1:7890' } })
    expect(setDefaultCustom).toHaveBeenCalledWith('p1', null, 'pixel')
    expect(result?.name).toBe('Pixel 环境变量（Anthropic） / Pixel 环境变量（OpenAI）')
  })

  it('有一个接口没建成：它的变量留在环境变量里，Key 不丢', async () => {
    failVendor = 'responses'
    const saveConfig = vi.fn(async () => {})
    await migrateEnv('pixel', { ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' }, saveConfig)
    expect(saveConfig).toHaveBeenCalledWith({ env: { OPENAI_API_KEY: 'sk-o' } })
  })

  it('全都没建成：不改环境变量，报错', async () => {
    failVendor = 'responses'
    const saveConfig = vi.fn(async () => {})
    await expect(migrateEnv('codex', { OPENAI_API_KEY: 'sk-o' }, saveConfig)).rejects.toThrow('save failed')
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('Claude Code 的环境变量里有 OPENAI_*：也建成接口再删（原来直接删掉）；默认只改成 Anthropic 的', async () => {
    const saveConfig = vi.fn(async () => {})
    await migrateEnv('claude', { OPENAI_API_KEY: 'sk-o' }, saveConfig)
    expect(saved).toHaveLength(1)
    expect(saveConfig).toHaveBeenCalledWith({ env: {} })
    expect(setDefaultCustom).not.toHaveBeenCalled()
  })

  it('默认来源不是自有时不改；值为空的变量直接删', async () => {
    source = 'platform'
    const saveConfig = vi.fn(async () => {})
    expect(await migrateEnv('pixel', { OPENAI_BASE_URL: '' }, saveConfig)).toBeNull()
    expect(saveConfig).toHaveBeenCalledWith({ env: {} })
    expect(setDefaultCustom).not.toHaveBeenCalled()
  })
})
