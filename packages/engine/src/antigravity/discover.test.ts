import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpConnection } from '../acp/connection'
import { AntigravityAdapter } from './index'
import { agyCatalog, agyOneShot, agyTier, agyVersionStatus, discoverAgy, probeAgyAuth } from './discover'

// 假的 agy acp：照 P0 录像（docs/antigravity-engine.md §7）回 initialize；
// 有 GEMINI_API_KEY 时 authenticate 成功，没有时 session/new 回 -32000；收到 ping 时反过来发一个字符串 id 的请求
const dir = mkdtempSync(join(tmpdir(), 'pixelsky-agy-test-'))
const fake = join(dir, 'fake-agy.mjs')
writeFileSync(
  fake,
  `
import { createInterface } from 'node:readline'
const out = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: 1, authMethods: [{ id: 'gemini-api-key' }] } })
  else if (m.method === 'authenticate') { globalThis.authed = true; out({ id: m.id, result: {} }) }
  else if (m.method === 'session/list')
    process.env.FAKE_SIGNED_IN ? out({ id: m.id, result: { sessions: [] } }) : out({ id: m.id, error: { code: -32000, message: 'Authentication required' } })
  else if (m.method === 'session/new') {
    if (!process.env.FAKE_SIGNED_IN && !globalThis.authed) {
      out({ id: m.id, error: { code: -32000, message: 'Authentication required' } })
      return
    }
    const tier = process.env.FAKE_TIER ? { name: process.env.FAKE_TIER, id: 'g1-ultra-tier' } : undefined
    out({ id: m.id, result: { sessionId: 'c1', configOptions: [{ id: 'model', currentValue: 'g', options: [{ value: 'g', name: 'G' }] }], ...(tier ? { _meta: { antigravity: { tier } } } : {}) } })
    out({ method: 'session/update', params: { sessionId: 'c1', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'goal', description: 'Set a goal' }, { name: '' }] } } })
  }
  else if (m.method === 'session/close') out({ id: m.id, result: {} })
  else if (m.method === 'session/prompt') {
    // 先要一次权限，等回答后把回答写进回复
    out({ id: 'perm', method: 'session/request_permission', params: { sessionId: 'c1', toolCall: {}, options: [{ optionId: 'allow', kind: 'allow_once' }] } })
    globalThis.prompt = m
  }
  else if (m.id === 'perm') {
    const p = globalThis.prompt
    out({ method: 'session/update', params: { sessionId: 'c1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'feat: ' + m.result.outcome.outcome } } } })
    out({ id: p.id, result: { stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 3, cachedReadTokens: 1, cachedWriteTokens: 0 } } })
  }
  else if (m.method === 'ping') out({ id: '1', method: 'session/request_permission', params: { options: [] } })
  else if (m.id === '1') out({ method: 'pong', params: m.result ?? m.error })
})
`,
)
const launcher = { command: process.execPath, args: [fake] }
// 用户目录指到临时目录：启动前清「按 Key 登录」记录（auth-state.ts）不碰本机真的 ~/.gemini
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: dir, HOME: dir, ...extra }
  delete e.GEMINI_API_KEY
  return { ...e, ...extra }
}

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('agy 版本', () => {
  it('低于 1.5.4 算太旧，读不到版本算出错', () => {
    expect(agyVersionStatus('1.5.9').status).toBe('ready')
    expect(agyVersionStatus('1.5.4').status).toBe('ready')
    expect(agyVersionStatus('1.4.10').status).toBe('outdated')
    expect(agyVersionStatus(null).status).toBe('error')
  })
})

describe('查找 agy', () => {
  it('PATH 和安装位置都没有：missing，带安装命令', async () => {
    const r = await discoverAgy(null, { PATH: dir, LOCALAPPDATA: dir, SystemRoot: dir })
    expect(r.info.status).toBe('missing')
    expect(r.info.message).toContain('antigravity.google/cli/install')
    expect(r.launcher).toBeNull()
  })
  it('替换的命令找不到：missing，不退回自动查找', async () => {
    const r = await discoverAgy(join(dir, 'nope.exe'), { PATH: dir })
    expect(r.info).toMatchObject({ status: 'missing', launch: 'custom' })
  })
})

describe('ACP 连接和探登录', () => {
  it('没有 Key、没登录：未登录', async () => {
    expect(await probeAgyAuth(launcher, [], env())).toEqual({ signedIn: false, reason: 'Authentication required' })
  })
  it('缓存的登录还在：session/list 返回账号登录，不额外新建会话', async () => {
    expect(await probeAgyAuth(launcher, [], env({ FAKE_SIGNED_IN: '1' }))).toEqual({ signedIn: true, kind: 'login' })
  })
  it('有 GEMINI_API_KEY：按 Key 认证', async () => {
    expect(await probeAgyAuth(launcher, [], env({ GEMINI_API_KEY: 'k' }))).toEqual({ signedIn: true, kind: 'apiKey' })
  })
  it('对方发来的请求（字符串 id）没人处理时回「不支持」', async () => {
    const got: unknown[] = []
    const conn = new AcpConnection(launcher, [], dir, env(), { notification: (_m, p) => got.push(p) })
    conn.notify('ping')
    await new Promise(r => setTimeout(r, 500))
    await conn.close()
    expect(got).toEqual([{ code: -32601, message: 'session/request_permission not supported' }])
  })
  it('进程退出后请求直接失败，不挂住', async () => {
    const conn = new AcpConnection({ command: process.execPath, args: ['-e', 'process.exit(3)'] }, [], dir, env())
    await new Promise(r => setTimeout(r, 300))
    await expect(conn.request('initialize')).rejects.toThrow()
  })
})

describe('同时启动的平台会话把「按 Key 登录」写了回去', () => {
  // 假 agy：第一次启动时模拟平台会话刚好写回记录（在我们清完之后），按记录走 Key 模式、没有 Key 就报需要认证；
  // 之后的启动看记录：没有就是已登录
  const home = mkdtempSync(join(tmpdir(), 'pixelsky-agy-home-'))
  const race = join(dir, 'race-agy.mjs')
  writeFileSync(
    race,
    `
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const home = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME
const state = join(home, '.gemini', 'antigravity-cli', 'cache', 'acp-auth-state.json')
const marker = join(home, 'raced')
if (!existsSync(marker)) {
  writeFileSync(marker, '1')
  mkdirSync(join(home, '.gemini', 'antigravity-cli', 'cache'), { recursive: true })
  writeFileSync(state, '{"methodId":"gemini-api-key"}')
}
const keyMode = existsSync(state) && readFileSync(state, 'utf8').includes('gemini-api-key')
const out = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: 1 } })
  else if (m.method === 'session/list')
    keyMode ? out({ id: m.id, error: { code: -32000, message: 'Authentication required' } }) : out({ id: m.id, result: { sessions: [] } })
})
`,
  )
  afterAll(() => rmSync(home, { recursive: true, force: true }))
  it('回归：不带 Key 的检测报需要认证、记录又出现了：再清一次重来，仍是已登录', async () => {
    const auth = await probeAgyAuth(
      { command: process.execPath, args: [race] },
      [],
      env({ USERPROFILE: home, HOME: home }),
    )
    expect(auth).toEqual({ signedIn: true, kind: 'login' })
    expect(existsSync(join(home, '.gemini', 'antigravity-cli', 'cache', 'acp-auth-state.json'))).toBe(false)
  })
  it('真的没登录（没有记录可清）不重试，照常报未登录', async () => {
    expect(await probeAgyAuth(launcher, [], env())).toEqual({ signedIn: false, reason: 'Authentication required' })
  })
})

describe('模型目录', () => {
  it('临时会话报的命令与 _meta.antigravity.tier 套餐一起带回', async () => {
    const tiers: (string | undefined)[] = []
    const c = await agyCatalog(launcher, [], env({ FAKE_SIGNED_IN: '1', FAKE_TIER: 'Google AI Ultra' }), t =>
      tiers.push(t),
    )
    expect(c.models?.map(m => m.id)).toEqual(['g'])
    expect(c.commands).toEqual([{ name: 'goal', description: 'Set a goal', source: 'engine' }])
    expect(tiers).toEqual(['Google AI Ultra'])
    expect(agyTier({ _meta: { antigravity: { tier: { name: '', id: 'g1-pro-tier' } } } })).toBe('g1-pro-tier')
    expect(agyTier({})).toBeUndefined()
  })
})

describe('单独问一次', () => {
  it('收集回复文字和用量，权限请求一律拒', async () => {
    const r = await agyOneShot(
      launcher,
      [],
      env({ FAKE_SIGNED_IN: '1' }),
      { prompt: 'write', model: null },
      new AbortController().signal,
    )
    expect(r).toEqual({
      text: 'feat: cancelled',
      model: 'g',
      usage: { input: 7, output: 3, cacheRead: 1, cacheWrite: 0 },
    })
  })
})

describe('适配器检测', () => {
  it('登录且带套餐时写进 info.account.plan', async () => {
    const adapter = new AntigravityAdapter({
      overridePath: () => process.execPath,
      env: env(),
      probe: async () => ({ signedIn: true, kind: 'login', plan: 'Google AI Ultra' }),
    })
    expect(await adapter.info()).toMatchObject({
      id: 'antigravity',
      status: 'ready',
      auth: { kind: 'login' },
      account: { plan: 'Google AI Ultra' },
    })
  })
  it('没登录时状态是 unauthenticated', async () => {
    const adapter = new AntigravityAdapter({
      overridePath: () => process.execPath,
      env: env(),
      probe: async () => ({ signedIn: false, reason: 'Authentication required' }),
    })
    // 用 node 冒充 agy：--version 输出 v24.x.y，够 1.5.4
    const info = await adapter.info()
    expect(info).toMatchObject({ id: 'antigravity', status: 'unauthenticated', launch: 'custom' })
  })
  it('探登录出错（起不来、超时）：仍算可用，原因放进启动错误', async () => {
    const adapter = new AntigravityAdapter({
      overridePath: () => process.execPath,
      env: env(),
      probe: async () => {
        throw new Error('initialize 超时')
      },
    })
    expect(await adapter.info()).toMatchObject({ status: 'ready', launchError: 'initialize 超时' })
  })
  it('没检测过、没装好时不能新建会话', () => {
    expect(() => new AntigravityAdapter().createSession({} as never)).toThrow('unavailable')
  })
  it('最新版本读官方安装器的清单（按系统和架构）', async () => {
    const urls: string[] = []
    const adapter = new AntigravityAdapter({
      fetch: (async (url: string) => {
        urls.push(url)
        return new Response(JSON.stringify({ version: '1.6.0', url: 'x', sha512: 'y' }))
      }) as typeof fetch,
    })
    expect(await adapter.latestVersion()).toBe('1.6.0')
    expect(urls[0]).toMatch(/\/manifests\/(windows|darwin|linux)_(amd64|arm64)\.json$/)
  })
})
