import { describe, expect, it } from 'vitest'
import { PROVIDERS_ENV, gatewayExtension, gatewayProviders, modelDefaults } from '../src/extensions/gateway.ts'

describe('gatewayProviders', () => {
  it('桌面端给的 provider：补齐模型字段，密钥占位符原样保留', () => {
    const { providers, warning } = gatewayProviders({
      [PROVIDERS_ENV]: JSON.stringify({
        pixelsky: {
          baseUrl: 'http://127.0.0.1:9',
          api: 'anthropic-messages',
          apiKey: '$PIXELSKY_PIXEL_TOKEN',
          models: [{ id: 'm1', reasoning: true, contextWindow: 200000 }],
        },
      }),
      // 有桌面端配置时不看用户的 *_BASE_URL
      ANTHROPIC_BASE_URL: 'https://ignored.example',
    })
    expect(warning).toBeUndefined()
    expect(providers).toEqual([
      [
        'pixelsky',
        {
          baseUrl: 'http://127.0.0.1:9',
          api: 'anthropic-messages',
          apiKey: '$PIXELSKY_PIXEL_TOKEN',
          models: [
            {
              id: 'm1',
              name: 'm1',
              reasoning: true,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
              maxTokens: 16384,
            },
          ],
        },
      ],
    ])
  })

  it('没有桌面端配置：用户的 ANTHROPIC_BASE_URL / OPENAI_BASE_URL 覆盖内置 provider 的地址', () => {
    expect(gatewayProviders({ ANTHROPIC_BASE_URL: ' https://relay.example ', OPENAI_BASE_URL: '' }).providers).toEqual([
      ['anthropic', { baseUrl: 'https://relay.example' }],
    ])
    expect(gatewayProviders({}).providers).toEqual([])
  })

  it('配置不是 JSON：不注册，给出原因，不让命令行起不来', () => {
    const r = gatewayProviders({ [PROVIDERS_ENV]: '{oops' })
    expect(r.providers).toEqual([])
    expect(r.warning).toMatch(/not valid JSON/)
  })

  it('模型默认值和 Pi 读 models.json 一致', () => {
    expect(modelDefaults({ id: 'x', input: ['text', 'image'] })).toMatchObject({
      name: 'x',
      input: ['text', 'image'],
      contextWindow: 128000,
      maxTokens: 16384,
    })
  })

  it('扩展按顺序注册', () => {
    const calls: unknown[] = []
    const before = process.env[PROVIDERS_ENV]
    process.env[PROVIDERS_ENV] = JSON.stringify({ a: { baseUrl: 'http://a' }, b: { baseUrl: 'http://b' } })
    try {
      gatewayExtension({ registerProvider: (name: string, config: unknown) => calls.push([name, config]) } as never)
    } finally {
      if (before === undefined) delete process.env[PROVIDERS_ENV]
      else process.env[PROVIDERS_ENV] = before
    }
    expect(calls).toEqual([
      ['a', { baseUrl: 'http://a' }],
      ['b', { baseUrl: 'http://b' }],
    ])
  })
})
