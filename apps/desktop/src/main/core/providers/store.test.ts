import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MASKED_SECRET } from '@pixelsky/engine'
import { normalizeBaseUrl, ProviderStore } from './store'
import {
  classifyStatus,
  fetchModels,
  providerHeaders,
  smallModelOf,
  testProvider,
  upstreamUrl,
  type Fetch,
} from './upstream'

const KEY = 'sk-test-secret-a1b2'
const cipher = (available = true) => ({
  available: () => available,
  encrypt: (t: string) => 'enc:' + Buffer.from(t).toString('base64'),
  decrypt: (t: string) => Buffer.from(t.replace(/^enc:/, ''), 'base64').toString(),
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'providers-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const input = {
  name: 'DeepSeek 兼容',
  protocol: 'anthropic' as const,
  baseUrl: 'https://api.example.com/anthropic/v1/',
  apiKey: KEY,
  models: [{ id: 'deepseek-chat' }, 'deepseek-reasoner' as never],
  headers: { 'X-Org': 'org-secret-9' },
}

describe('自定义 API 配置存储（docs/ui/custom-api.md §4.2）', () => {
  it('Key 和请求头的值只在加密文件里：providers.json、返回给设置页的数据都没有', () => {
    const store = new ProviderStore(dir, cipher())
    const view = store.save(input)
    expect(view).toMatchObject({
      baseUrl: 'https://api.example.com/anthropic',
      auth: 'x-api-key',
      keyHint: 'a1b2',
      headerNames: ['X-Org'],
      models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
      modelFallback: true,
      insecure: false,
    })
    const plain = readFileSync(join(dir, 'providers.json'), 'utf8')
    const enc = readFileSync(join(dir, 'secrets.json'), 'utf8')
    for (const text of [plain, enc, JSON.stringify(view), JSON.stringify(store.state())]) {
      expect(text).not.toContain(KEY)
      expect(text).not.toContain('org-secret-9')
    }
    // 重启后读回，网关能拿到真实值
    const again = new ProviderStore(dir, cipher())
    expect(again.resolve(view.id)).toMatchObject({ apiKey: KEY, headers: { 'X-Org': 'org-secret-9' } })
  })

  it('后台小模型从列表里删掉后：保存成 null；旧配置里存着删掉的模型名，读回时也纠正', () => {
    const store = new ProviderStore(dir, cipher())
    const models = [{ id: 'review-main' }, { id: 'claude-haiku-retired' }]
    const saved = store.save({ ...input, models, smallModel: 'claude-haiku-retired' })
    expect(saved.smallModel).toBe('claude-haiku-retired')
    const edited = store.save({
      ...input,
      id: saved.id,
      models: [{ id: 'review-main' }],
      smallModel: 'claude-haiku-retired',
    })
    expect(edited.smallModel).toBeNull()
    expect(readFileSync(join(dir, 'providers.json'), 'utf8')).not.toContain('claude-haiku-retired')
    // 只改别的字段（不传 models / smallModel）时同样纠正
    expect(store.save({ ...input, id: saved.id, models: undefined, smallModel: undefined }).smallModel).toBeNull()

    // 旧版本存下来的坏配置
    const file = join(dir, 'providers.json')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.providers[0].smallModel = 'claude-haiku-retired'
    writeFileSync(file, JSON.stringify(raw))
    expect(new ProviderStore(dir, cipher()).resolve(saved.id)?.smallModel).toBeNull()
  })

  it('后台小模型只认列表里还有的，不然用列表第一个', () => {
    const models = [{ id: 'review-main' }, { id: 'lite' }]
    expect(smallModelOf({ models, smallModel: 'lite' })).toBe('lite')
    expect(smallModelOf({ models, smallModel: 'claude-haiku-retired' })).toBe('review-main')
    expect(smallModelOf({ models, smallModel: null })).toBe('review-main')
    expect(smallModelOf({ models: [], smallModel: 'x' })).toBeNull()
  })

  it('测试连接 / 读取模型用的草稿不要求名称；保存仍然要名称', () => {
    const store = new ProviderStore(dir, cipher())
    expect(store.draft({ ...input, name: '' })).toMatchObject({ name: '未命名接口', apiKey: KEY })
    expect(store.draft({ ...input, name: undefined as never }).name).toBe('未命名接口')
    expect(store.draft(input).name).toBe('DeepSeek 兼容')
    expect(() => store.save({ ...input, name: '  ' })).toThrow('请填写名称')
  })

  it('编辑时 Key 留空不改、请求头打码不改，没列出的请求头删掉；不能换协议', () => {
    const store = new ProviderStore(dir, cipher())
    const { id } = store.save(input)
    store.save({ ...input, id, apiKey: '', headers: { 'X-Org': MASKED_SECRET, 'X-New': 'v' } })
    expect(store.resolve(id)).toMatchObject({ apiKey: KEY, headers: { 'X-Org': 'org-secret-9', 'X-New': 'v' } })
    store.save({ ...input, id, apiKey: undefined, headers: {} })
    expect(store.resolve(id)?.headers).toEqual({})
    expect(() => store.save({ ...input, id, protocol: 'responses' })).toThrow('不能换协议')
    expect(() => store.save({ ...input, id: 'gone' })).toThrow('已经删除')
  })

  it('系统加密不可用时只放内存，不写 secrets.json；重启后 Key 没了', () => {
    const store = new ProviderStore(dir, cipher(false))
    const { id } = store.save(input)
    expect(store.state().persistent).toBe(false)
    expect(store.resolve(id)?.apiKey).toBe(KEY)
    expect(existsSync(join(dir, 'secrets.json'))).toBe(false)
    expect(new ProviderStore(dir, cipher(false)).resolve(id)?.apiKey).toBeNull()
  })

  it('删除接口连同密钥；坏的配置文件不覆盖、给提示', () => {
    const store = new ProviderStore(dir, cipher())
    const { id } = store.save(input)
    store.remove(id)
    expect(store.state().providers).toEqual([])
    expect(new ProviderStore(dir, cipher()).resolve(id)).toBeNull()
    writeFileSync(join(dir, 'providers.json'), '{bad')
    expect(new ProviderStore(dir, cipher()).state().warning).toContain('读不出来')
    expect(readFileSync(join(dir, 'providers.json'), 'utf8')).toBe('{bad')
  })

  it('接口地址：https 都行；http 只允许本机和内网；不能带账号、查询串', () => {
    expect(normalizeBaseUrl('https://api.openai.com/v1/', 'responses')).toBe('https://api.openai.com/v1')
    expect(normalizeBaseUrl('https://api.anthropic.com/v1', 'anthropic')).toBe('https://api.anthropic.com')
    for (const ok of [
      'http://localhost:8080',
      'http://127.0.0.1:3000/v1',
      'http://192.168.1.5',
      'http://10.0.0.2',
      'http://gpu-box',
      'http://[::1]:9000',
    ])
      expect(() => normalizeBaseUrl(ok, 'responses'), ok).not.toThrow()
    for (const bad of [
      'http://api.example.com',
      'http://8.8.8.8',
      'ftp://x',
      'https://u:p@x.com',
      'https://x.com/?k=1',
      'not a url',
    ])
      expect(() => normalizeBaseUrl(bad, 'responses'), bad).toThrow()
  })

  it('请求头：程序自己管的不能改、重复的拒绝', () => {
    const store = new ProviderStore(dir, cipher())
    expect(() => store.save({ ...input, headers: { Authorization: 'x' } })).toThrow('不能改')
    expect(() => store.save({ ...input, headers: { 'x-a': '1', 'X-A': '2' } })).toThrow('重复')
    expect(() => store.save({ ...input, headers: { 'bad name': '1' } })).toThrow('名称不对')
  })
})

describe('发往接口的请求', () => {
  const p = {
    id: 'p1',
    name: '中转',
    template: 'custom' as const,
    protocol: 'responses' as const,
    baseUrl: 'https://relay.example.com/v1',
    auth: 'bearer' as const,
    models: [{ id: 'gpt-5' }],
    smallModel: null,
    modelFallback: true,
    headerNames: [],
    createdAt: 0,
    updatedAt: 0,
    apiKey: KEY,
    headers: {},
  }
  it('地址拼法和认证头', () => {
    expect(upstreamUrl(p, '/v1/responses')).toBe('https://relay.example.com/v1/responses')
    expect(upstreamUrl({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' }, '/v1/messages')).toBe(
      'https://api.anthropic.com/v1/messages',
    )
    expect(providerHeaders(p)).toEqual({ authorization: `Bearer ${KEY}` })
    expect(providerHeaders({ ...p, protocol: 'anthropic', auth: 'x-api-key' })).toEqual({
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
    })
  })

  it('错误翻成人话，接口回显的 Key 打码', () => {
    expect(classifyStatus(401, `{"error":{"message":"bad key ${KEY}"}}`, p, 'gpt-5')).toEqual({
      problem: 'auth',
      message: '自定义接口「中转」拒绝了这个 Key（401）：bad key ••••',
    })
    expect(classifyStatus(404, '{"error":{"message":"model gpt-9 not found"}}', p, 'gpt-9').problem).toBe('model')
    expect(classifyStatus(404, 'Not Found', p, null).message).toContain('/v1')
    expect(classifyStatus(429, '{"error":"quota exceeded"}', p, null)).toEqual({
      problem: 'quota',
      message: 'quota exceeded',
    })
  })

  it('测试连接和读取模型：不跟随跳转，超时分类', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const ok: Fetch = async (url, init) => {
      calls.push({ url, init })
      return new Response(url.endsWith('/models') ? '{"data":[{"id":"b"},{"id":"a"},{"id":"a"}]}' : '{}', {
        status: 200,
      })
    }
    expect(await testProvider(p, ok)).toEqual({ ok: true, status: 200, model: 'gpt-5' })
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ model: 'gpt-5', input: 'ping' })
    expect(calls[0].init.redirect).toBe('error')
    expect(await fetchModels(p, ok)).toEqual(['a', 'b'])
    const timeout: Fetch = async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    }
    expect(await testProvider(p, timeout)).toMatchObject({ ok: false, problem: 'timeout' })
    const refused: Fetch = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    }
    await expect(fetchModels(p, refused)).rejects.toThrow('连接被拒绝')
  })
})
