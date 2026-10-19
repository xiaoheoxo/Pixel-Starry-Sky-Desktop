import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { SessionRecord } from '@pixelsky/protocol'
import { platformGateway } from './gateway'
import { chatUsage, withUsageOption } from './chat-usage'
import {
  chatCompat,
  engineProviderProtocols,
  groupEngines,
  pixelApi,
  pixelBaseUrl,
  pixelGatewayEnv,
  pixelSubagentRoute,
} from './pixel-env'
import { oneShotBody, parseReply } from '../core/ai/oneshot'
import { testProvider, upstreamUrl } from '../core/providers/upstream'
import { ProviderStore, normalizeBaseUrl, type ResolvedProvider } from '../core/providers/store'
import type { ProviderProtocol } from '../../shared/types/providers'

let server: Server
afterEach(() => {
  server?.closeAllConnections()
  server?.close()
})

const provider = (protocol: ProviderProtocol, baseUrl: string): ResolvedProvider =>
  ({
    id: 'p',
    name: 'Relay',
    template: 'custom',
    protocol,
    baseUrl,
    auth: 'bearer',
    models: [{ id: 'm' }],
    smallModel: null,
    modelFallback: true,
    headerNames: [],
    apiKey: 'sk-real',
    headers: {},
  }) as unknown as ResolvedProvider

async function start(engine: string, p: ResolvedProvider, reply: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const record = { id: 's', engine, model: 'm', platform: null, provider: { id: 'p' } } as SessionRecord
  server = platformGateway({
    sessions: new Map([['s', { recordId: 's', secret: 'local-secret' }]]),
    record: () => record,
    account: () => null,
    fetch: async () => {
      throw new Error('platform fetch must not be used')
    },
    provider: () => p,
    upstream: async (url, init) => {
      calls.push({ url, init })
      return reply(url, init)
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer local-secret' },
      body: JSON.stringify(body),
    })
  return { calls, post }
}

describe('像素星空的 OpenAI 协议：环境变量', () => {
  it('按协议选 API 种类和带不带 /v1 的地址（OpenAI SDK 自己接 /responses、/chat/completions，不能出现 /v1/v1）', () => {
    expect(pixelApi({ protocol: 'anthropic' })).toBe('anthropic-messages')
    expect(pixelApi({ protocol: 'responses' })).toBe('openai-responses')
    expect(pixelApi({ protocol: 'chat' })).toBe('openai-completions')
    expect(pixelApi({ groupPlatform: 'openai' })).toBe('openai-responses')
    expect(pixelApi({ groupPlatform: 'anthropic', model: 'gpt-6.1-sol' })).toBe('openai-responses')
    expect(pixelApi({ groupPlatform: 'openai', model: 'claude-opus-5-5' })).toBe('anthropic-messages')
    // 自定义接口可以转换协议，仍以用户配置的协议为准。
    expect(pixelApi({ protocol: 'anthropic', model: 'gpt-6.1-sol' })).toBe('anthropic-messages')
    expect(pixelApi({ groupPlatform: 'anthropic' })).toBe('anthropic-messages')
    expect(pixelApi({})).toBe('anthropic-messages')
    expect(pixelBaseUrl('anthropic-messages', 5)).toBe('http://127.0.0.1:5')
    expect(pixelBaseUrl('openai-responses', 5)).toBe('http://127.0.0.1:5/v1')
    expect(pixelBaseUrl('openai-completions', 5)).toBe('http://127.0.0.1:5/v1')
  })

  it('Responses：模型列表照旧；Chat：每个模型带 compat，默认只给文字', () => {
    const models = [{ id: 'a', contextWindow: 64000 }, { id: 'b' }]
    const responses = pixelGatewayEnv({ port: 9, secret: 's', api: 'openai-responses', models, model: 'a' })
    expect(responses).toMatchObject({
      PIXELSKY_PIXEL_BASE_URL: 'http://127.0.0.1:9/v1',
      PIXELSKY_PIXEL_TOKEN: 's',
      PIXELSKY_PIXEL_API: 'openai-responses',
    })
    expect(JSON.parse(responses.PIXELSKY_PIXEL_MODELS)).toEqual([{ id: 'a', contextWindow: 64000 }, { id: 'b' }])
    const chat = pixelGatewayEnv({
      port: 9,
      secret: 's',
      api: 'openai-completions',
      models,
      model: 'a',
      upstreamBaseUrl: 'https://api.deepseek.com',
    })
    expect(chat.PIXELSKY_PIXEL_API).toBe('openai-completions')
    expect(JSON.parse(chat.PIXELSKY_PIXEL_MODELS)[0]).toMatchObject({
      id: 'a',
      contextWindow: 64000,
      input: ['text'],
      compat: { supportsStore: false, maxTokensField: 'max_tokens', thinkingFormat: 'deepseek' },
    })
    // 平台会话没有模型列表：只有当前模型；什么都没有时不给变量
    const platform = pixelGatewayEnv({ port: 9, secret: 's', api: 'openai-responses', model: 'gpt' })
    expect(JSON.parse(platform.PIXELSKY_PIXEL_MODELS)).toEqual([{ id: 'gpt' }])
    expect(pixelGatewayEnv({ port: 9, secret: 's', api: 'openai-responses', model: null })).not.toHaveProperty(
      'PIXELSKY_PIXEL_MODELS',
    )
    expect(chatCompat('https://openrouter.ai/api/v1')).not.toHaveProperty('thinkingFormat')
  })

  it('子智能体类型单独的站点：只有一个模型，Chat 带 compat，带上站点名和放密钥的变量名', () => {
    const route = pixelSubagentRoute({
      api: 'openai-completions',
      model: 'deepseek-chat',
      contextWindow: 64000,
      upstreamBaseUrl: 'https://api.deepseek.com',
      label: 'DeepSeek',
      token: 'PIXELSKY_PIXEL_SUB_TOKEN_2',
    })
    expect(route).toMatchObject({ api: 'openai-completions', label: 'DeepSeek', token: 'PIXELSKY_PIXEL_SUB_TOKEN_2' })
    expect(route.model).toMatchObject({
      id: 'deepseek-chat',
      contextWindow: 64000,
      input: ['text'],
      compat: { thinkingFormat: 'deepseek' },
    })
    const anthropic = pixelSubagentRoute({ api: 'anthropic-messages', model: 'm', label: 'L', token: 'T' })
    expect(anthropic.model).toEqual({ id: 'm' })
  })
})

describe('引擎与协议的对应', () => {
  it('Claude Code 只要 Anthropic，Codex 只要 Responses，像素星空三种都行（Chat 只有它）', () => {
    expect(engineProviderProtocols('claude')).toEqual(['anthropic'])
    expect(engineProviderProtocols('codex')).toEqual(['responses'])
    expect(engineProviderProtocols('pixel')).toEqual(['anthropic', 'responses', 'chat'])
  })
  it('线路目录：openai 线路像素星空也能用；写了 claude / codex 的它都能用', () => {
    expect(groupEngines({ platform: 'openai' })).toEqual(['codex', 'pixel'])
    expect(groupEngines({ platform: 'anthropic' })).toEqual(['claude', 'pixel'])
    expect(groupEngines({ platform: 'x', supported_engines: ['codex'] })).toEqual(['codex', 'pixel'])
    expect(groupEngines({ platform: 'x', supported_engines: ['claude', 'pixel'] })).toEqual(['claude', 'pixel'])
  })
})

describe('网关：像素星空走 Responses / Chat Completions', () => {
  it('自定义 Responses 接口：像素星空和 Codex 一样放行，拼到带 /v1 的地址上', async () => {
    const { calls, post } = await start(
      'pixel',
      provider('responses', 'https://api.openai.com/v1'),
      () => new Response('data: {}\n\n'),
    )
    const res = await post('/v1/responses', { model: 'm', stream: true })
    expect(res.status).toBe(200)
    expect(calls[0].url).toBe('https://api.openai.com/v1/responses')
    expect(calls[0].init.headers).toMatchObject({ authorization: 'Bearer sk-real' })
  })

  it('Chat：拼到 /chat/completions，补 include_usage，换上真实 Key，流式原样转发', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n'
    const { calls, post } = await start(
      'pixel',
      provider('chat', 'https://api.deepseek.com'),
      () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }),
    )
    const res = await post('/v1/chat/completions', { model: 'm', stream: true, messages: [] })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(sse)
    expect(calls[0].url).toBe('https://api.deepseek.com/chat/completions')
    expect(calls[0].init.headers).toMatchObject({ authorization: 'Bearer sk-real' })
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ stream_options: { include_usage: true } })
    // 模型不在列表里时和其他协议一样换成会话当前的模型；非流式不加 stream_options
    await post('/v1/chat/completions', { model: 'other', stream: false })
    expect(JSON.parse(String(calls[1].init.body))).toMatchObject({ model: 'm' })
    expect(JSON.parse(String(calls[1].init.body))).not.toHaveProperty('stream_options')
  })

  it('Chat：连不上上游用 OpenAI 的错误格式回 502；上游错误状态码原样', async () => {
    const down = await start('pixel', provider('chat', 'https://x.example/v1'), () => {
      throw new TypeError('fetch failed')
    })
    const res = await down.post('/v1/chat/completions', { model: 'm' })
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: { type: 'invalid_request_error' } })
    server.closeAllConnections()
    server.close()
    const limited = await start(
      'pixel',
      provider('chat', 'https://x.example/v1'),
      () => new Response('{"error":{"message":"slow down"}}', { status: 429 }),
    )
    const rate = await limited.post('/v1/chat/completions', { model: 'm' })
    expect(rate.status).toBe(429)
    expect(await rate.text()).toContain('slow down')
  })

  it.each(['claude', 'codex'])('Chat 接口不让 %s 用', async engine => {
    const { calls, post } = await start(engine, provider('chat', 'https://x.example/v1'), () => new Response('{}'))
    expect((await post('/v1/chat/completions', { model: 'm' })).status).toBe(403)
    expect((await post(engine === 'codex' ? '/v1/responses' : '/v1/messages', { model: 'm' })).status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('协议和路径对不上被拒：Anthropic 接口走 Chat 路径；Claude Code 走 Responses 路径', async () => {
    const a = await start('pixel', provider('anthropic', 'https://x.example'), () => new Response('{}'))
    expect((await a.post('/v1/chat/completions', { model: 'm' })).status).toBe(403)
    server.closeAllConnections()
    server.close()
    const c = await start('claude', provider('responses', 'https://x.example/v1'), () => new Response('{}'))
    expect((await c.post('/v1/responses', { model: 'm' })).status).toBe(403)
  })

  it('平台线路没有 Chat Completions 入口；平台 Responses 对像素星空放行', async () => {
    const record = { id: 's', engine: 'pixel', model: 'gpt', platform: { groupId: '3', account: 'u' } } as SessionRecord
    const paths: string[] = []
    server = platformGateway({
      sessions: new Map([['s', { recordId: 's', secret: 'local-secret' }]]),
      record: () => record,
      account: () => 'u',
      fetch: async path => {
        paths.push(path)
        return new Response('data: {}\n\n')
      },
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
    const send = (path: string) =>
      fetch(base + path, {
        method: 'POST',
        headers: { Authorization: 'Bearer local-secret' },
        body: '{"model":"gpt","stream":true}',
      })
    expect((await send('/v1/chat/completions')).status).toBe(404)
    expect((await send('/v1/responses')).status).toBe(200)
    expect(paths).toEqual(['/v1/platform/responses'])
  })
})

describe('Chat Completions：用量与一次性调用', () => {
  it('流式取最后一个带 usage 的事件，缓存读从输入里扣出来', () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"x"}}],"usage":null}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":60}}}\n\n' +
      'data: [DONE]\n\n'
    expect(chatUsage(sse)).toEqual({ input: 40, output: 7, cacheRead: 60 })
    expect(chatUsage('data: {"choices":[]}\n\ndata: [DONE]\n\n')).toBeNull()
  })
  it('非流式是一个 JSON', () => {
    expect(chatUsage('{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}')).toEqual({
      input: 5,
      output: 1,
      cacheRead: 0,
    })
  })
  it('只给流式请求补 include_usage，已有的不动', () => {
    expect(withUsageOption({ stream: true })).toEqual({ stream: true, stream_options: { include_usage: true } })
    expect(withUsageOption({ stream: true, stream_options: { x: 1 } })).toEqual({
      stream: true,
      stream_options: { x: 1, include_usage: true },
    })
    const keep = { stream: true, stream_options: { include_usage: true } }
    expect(withUsageOption(keep)).toBe(keep)
    const off = { stream: false }
    expect(withUsageOption(off)).toBe(off)
  })
  it('AI 提交说明：Chat 的请求体和回复', () => {
    expect(oneShotBody({ protocol: 'chat', model: 'm', system: 's', prompt: 'p', maxTokens: 9 })).toEqual({
      model: 'm',
      max_tokens: 9,
      stream: false,
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'p' },
      ],
    })
    expect(
      parseReply('chat', {
        choices: [{ message: { content: 'fix: x' } }],
        usage: { prompt_tokens: 20, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 5 } },
      }),
    ).toEqual({ text: 'fix: x', usage: { input: 15, output: 3, cacheRead: 5, cacheWrite: 0 } })
  })
})

describe('自定义接口：Chat 协议的存取与测试连接', () => {
  const cipher = {
    available: () => true,
    encrypt: (t: string) => 'enc:' + Buffer.from(t).toString('base64'),
    decrypt: (t: string) => Buffer.from(t.replace(/^enc:/, ''), 'base64').toString(),
  }
  it('接口地址保留路径（和 Responses 一样），网关路径去掉 /v1 再拼', () => {
    expect(normalizeBaseUrl('https://openrouter.ai/api/v1/', 'chat')).toBe('https://openrouter.ai/api/v1')
    expect(normalizeBaseUrl('https://api.deepseek.com', 'chat')).toBe('https://api.deepseek.com')
    const p = { protocol: 'chat' as const, baseUrl: 'https://openrouter.ai/api/v1' }
    expect(upstreamUrl(p, '/v1/chat/completions')).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(upstreamUrl(p, '/v1/models')).toBe('https://openrouter.ai/api/v1/models')
  })
  it('测试连接发 /chat/completions 最小请求', async () => {
    const seen: Array<{ url: string; body: unknown }> = []
    const result = await testProvider(provider('chat', 'https://api.deepseek.com'), async (url, init) => {
      seen.push({ url, body: JSON.parse(String(init.body)) })
      return new Response('{}', { status: 200 })
    })
    expect(result).toEqual({ ok: true, status: 200, model: 'm' })
    expect(seen[0].url).toBe('https://api.deepseek.com/chat/completions')
    expect(seen[0].body).toMatchObject({ model: 'm', max_tokens: 16 })
  })
  it('保存 / 重新读取 chat，不能换协议；没见过的协议值读回按 anthropic（旧版本读到新值不崩）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'providers-'))
    try {
      const store = new ProviderStore(dir, cipher)
      const saved = store.save({
        name: 'DS',
        protocol: 'chat',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-abc',
        models: [{ id: 'deepseek-chat' }],
      })
      expect(saved).toMatchObject({ protocol: 'chat', auth: 'bearer' })
      expect(() =>
        store.save({ id: saved.id, name: 'DS', protocol: 'anthropic', baseUrl: 'https://api.deepseek.com' }),
      ).toThrow('不能换协议')
      expect(() => store.save({ name: 'x', protocol: 'bogus' as never, baseUrl: 'https://a.example' })).toThrow(
        '请选择协议',
      )
      expect(new ProviderStore(dir, cipher).get(saved.id)?.protocol).toBe('chat')
      const file = join(dir, 'providers.json')
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      raw.providers[0].protocol = 'future'
      writeFileSync(file, JSON.stringify(raw))
      expect(new ProviderStore(dir, cipher).get(saved.id)?.protocol).toBe('anthropic')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
