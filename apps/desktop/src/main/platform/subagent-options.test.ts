// 主模型调度：网关现算候选（docs/ui/subagent-model-dispatch.md §3、§4）
import { once } from 'node:events'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecord } from '@pixelsky/protocol'
import type { DispatchCatalog } from '../../shared/subagent-dispatch'
import { parseSubagentSettings, type SubagentSite, type SubagentTarget } from '../../shared/types/subagents'
import { platformGateway } from './gateway'
import { SUBAGENT_OPTIONS_PATH, answerSubagentOptions, staleSubagentKey } from './subagent-options'

const target = (groupId: string, model: string): SubagentTarget => ({
  kind: 'platform',
  groupId,
  account: 'a@b.c',
  model,
})
const RULE = {
  main: { site: { kind: 'platform', groupId: '1' }, model: 'gpt-6-sol' },
  candidates: [
    { target: target('1', 'gpt-6-astra'), note: '', isDefault: true },
    { target: target('1', 'gpt-6-luna'), note: '便宜' },
    { target: target('2', 'other'), note: '' },
  ],
}
const settings = (over: Record<string, unknown> = {}) =>
  parseSubagentSettings({
    types: [{ id: 'explore', dispatch: { rules: [RULE], unruled: 'cheaper', ...over } }, { id: 'general' }],
  })
const record = (over: Partial<SessionRecord> = {}): SessionRecord =>
  ({
    id: 's',
    engine: 'pixel',
    model: 'gpt-6-sol',
    platform: { groupId: '1', account: 'a@b.c' },
    provider: null,
    ...over,
  }) as SessionRecord

const PRICES: Record<string, { input: number; output: number }> = {
  'gpt-6-sol': { input: 2, output: 10 },
  'gpt-6-astra': { input: 10, output: 50 },
  'gpt-6-luna': { input: 0.1, output: 0.5 },
}
const catalog = async (site: SubagentSite | null): Promise<DispatchCatalog> => ({
  problem: () => null,
  siteModels: site ? Object.keys(PRICES) : [],
  price: m => PRICES[m] ?? null,
})
const ask = (request: unknown, rec = record(), s = settings()) => {
  const issue = vi.fn((_type: string, t: SubagentTarget) => ({ route: { model: { id: t.model } }, secret: 'k' }))
  return { issue, reply: answerSubagentOptions({ settings: s, record: rec, request, catalog, issue }) }
}

describe('staleSubagentKey', () => {
  const prefix = 's1#subagent:'

  it('固定站点的类型：没用到才作废', () => {
    expect(staleSubagentKey(`${prefix}explore`, prefix, new Set())).toBe(true)
    expect(staleSubagentKey(`${prefix}explore`, prefix, new Set([`${prefix}explore`]))).toBe(false)
  })

  it('主模型选的路线不清：旁聊也会算一次环境，这时子任务可能还在跑', () => {
    expect(staleSubagentKey(`${prefix}explore@1/gpt-6-luna`, prefix, new Set())).toBe(false)
  })

  it('别的会话和主会话自己的不动', () => {
    expect(staleSubagentKey('s2#subagent:explore', prefix, new Set())).toBe(false)
    expect(staleSubagentKey('s1', prefix, new Set())).toBe(false)
  })
})

describe('answerSubagentOptions', () => {
  it('只列候选时不发密钥', async () => {
    const { issue, reply } = ask({ type: 'explore' })
    expect(await reply).toEqual({
      currentModel: 'gpt-6-sol',
      options: [
        { model: 'gpt-6-astra', note: '', outside: false },
        { model: 'gpt-6-luna', note: '便宜', outside: false },
      ],
      defaultModel: 'gpt-6-astra',
    })
    expect(issue).not.toHaveBeenCalled()
  })

  it('选列表里的：发密钥；不填用默认；列表外的不发', async () => {
    const chosen = ask({ type: 'explore', pick: true, model: 'gpt-6-luna' })
    expect((await chosen.reply).pick).toMatchObject({ outcome: 'route', source: 'chosen', secret: 'k', outside: false })
    expect(chosen.issue).toHaveBeenCalledWith('explore', target('1', 'gpt-6-luna'))
    const dflt = ask({ type: 'explore', pick: true })
    expect((await dflt.reply).pick).toMatchObject({ outcome: 'route', source: 'default' })
    const bad = ask({ type: 'explore', pick: true, model: 'other' })
    expect((await bad.reply).pick).toEqual({ outcome: 'rejected' })
    expect(bad.issue).not.toHaveBeenCalled()
  })

  it('分组外：打开开关后才能选，标上分组外', async () => {
    const { reply } = ask({ type: 'explore', pick: true, model: 'other' }, record(), settings({ outsideGroup: true }))
    expect((await reply).pick).toMatchObject({ outcome: 'route', outside: true })
  })

  it('会话换了分组：同名主模型立刻不按原规则走，原来的同分组模型不再给', async () => {
    const moved = record({ platform: { groupId: '2', account: 'a@b.c' } })
    const { issue, reply } = ask({ type: 'explore', pick: true, model: 'gpt-6-astra' }, moved)
    const out = await reply
    // 分组 2 的 gpt-6-sol 没写规则：不比它贵的，gpt-6-astra 更贵
    expect(out.options.map(o => o.model)).toEqual(['gpt-6-luna'])
    expect(out.pick).toEqual({ outcome: 'rejected' })
    expect(issue).not.toHaveBeenCalled()
  })

  it('没写规则：不填用主模型自己；写自己的名字也算', async () => {
    const rec = record({ model: 'gpt-6-astra' })
    const s = parseSubagentSettings({ types: [{ id: 'explore', dispatch: { rules: [] } }] })
    expect((await ask({ type: 'explore', pick: true }, rec, s).reply).pick).toEqual({ outcome: 'self' })
    const own = await ask({ type: 'explore', pick: true, model: 'gpt-6-astra' }, rec, s).reply
    expect(own.pick).toEqual({ outcome: 'self' })
    // 规则里没列自己时，写自己不行
    const ruled = await ask({ type: 'explore', pick: true, model: 'gpt-6-sol' }).reply
    expect(ruled.pick).toEqual({ outcome: 'rejected' })
  })

  it('用自己的登录、类型关了、删了、不是这种类型：用主模型自己', async () => {
    const own = record({ platform: null, provider: null })
    expect((await ask({ type: 'explore', pick: true }, own).reply).pick).toEqual({ outcome: 'self' })
    for (const type of ['general', 'gone', 1]) {
      expect((await ask({ type, pick: true }).reply).pick).toEqual({ outcome: 'self' })
    }
    const off = parseSubagentSettings({ types: [{ id: 'explore', enabled: false, dispatch: { rules: [RULE] } }] })
    expect((await ask({ type: 'explore', pick: true }, record(), off).reply).pick).toEqual({ outcome: 'self' })
  })

  it('记录没写模型才用命令行报的；[1m] 去掉', async () => {
    const reported = await ask({ type: 'explore', mainModel: 'gpt-6-sol' }, record({ model: null })).reply
    expect(reported.currentModel).toBe('gpt-6-sol')
    const lied = await ask({ type: 'explore', mainModel: 'evil' }).reply
    expect(lied.currentModel).toBe('gpt-6-sol')
    const long = await ask({ type: 'explore' }, record({ model: 'gpt-6-sol[1m]' })).reply
    expect(long.defaultModel).toBe('gpt-6-astra')
  })

  it('临到发密钥时不能用了：当不允许', async () => {
    const reply = await answerSubagentOptions({
      settings: settings(),
      record: record(),
      request: { type: 'explore', pick: true },
      catalog,
      issue: () => null,
    })
    expect(reply.pick).toEqual({ outcome: 'rejected' })
  })
})

describe('网关的候选接口', () => {
  let server: Server
  afterEach(() => {
    server?.closeAllConnections()
    server?.close()
  })
  const start = async () => {
    const upstream = vi.fn(async () => new Response('ok'))
    const subagentOptions = vi.fn(async (token: string, request: unknown) =>
      token === 'options-secret' ? { echo: request } : null,
    )
    server = platformGateway({
      sessions: new Map([['s', { recordId: 's', secret: 'session-secret' }]]),
      record: () => record(),
      account: () => 'a@b.c',
      fetch: upstream,
      subagentOptions,
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const post = (path: string, token: string, body: unknown = { type: 'explore' }) =>
      fetch(url + path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
    return { upstream, subagentOptions, post }
  }

  it('密钥对才回；不对 401；坏 JSON 400；过大 413', async () => {
    const { post, subagentOptions } = await start()
    const ok = await post(SUBAGENT_OPTIONS_PATH, 'options-secret')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ echo: { type: 'explore' } })
    expect((await post(SUBAGENT_OPTIONS_PATH, 'wrong')).status).toBe(401)
    expect((await post(SUBAGENT_OPTIONS_PATH, 'options-secret', '{bad')).status).toBe(400)
    subagentOptions.mockClear()
    expect((await post(SUBAGENT_OPTIONS_PATH, 'options-secret', 'x'.repeat(70_000))).status).toBe(413)
    expect(subagentOptions).not.toHaveBeenCalled()
  })

  it('查候选的密钥发不了模型请求', async () => {
    const { post, upstream } = await start()
    const res = await post('/v1/messages', 'options-secret', { model: 'gpt-6-sol' })
    expect(res.status).toBe(401)
    expect(upstream).not.toHaveBeenCalled()
  })
})
