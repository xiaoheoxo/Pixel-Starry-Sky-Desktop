import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClaudeAdapter, CodexAdapter, EngineHost } from '../src'
import type { EngineAccountUsage } from '@pixelsky/protocol'
import { makeTmp, removeTmp } from './helpers/tmp'

let root: string
const closing: (() => Promise<void>)[] = []
beforeEach(() => {
  root = makeTmp('account-usage')
})
afterEach(async () => {
  for (const close of closing.splice(0)) await close()
  removeTmp(root)
})
const launcher = (name: string) => ({
  command: process.execPath,
  args: [fileURLToPath(new URL(`./fakes/fake-${name}.mjs`, import.meta.url))],
})
const weekly = {
  rate_limits_available: true,
  subscription_type: 'pro',
  rate_limits: { five_hour: null, seven_day: { utilization: 72, resets_at: '2026-10-22T10:12:00Z' } },
}
const codexWeekly = {
  rateLimits: { primary: null, secondary: { usedPercent: 72, windowDurationMins: 10080, resetsAt: 1800000000 } },
}
const account = { account: { type: 'chatgpt', email: 'test@example.com', planType: 'pro' }, requiresOpenaiAuth: true }

describe('原生额度查询：真实子进程协议，仿真引擎不调用模型', () => {
  it('Claude 主动查询携带 skip_behaviors，缓存和刷新独立于模型目录', async () => {
    const file = join(root, 'usage.json'),
      log = join(root, 'usage.log'),
      control = join(root, 'claude.log')
    writeFileSync(file, JSON.stringify(weekly))
    const adapter = new ClaudeAdapter({
      launcher: launcher('claude'),
      env: { ...process.env, FAKE_CLAUDE_USAGE_FILE: file, FAKE_CLAUDE_USAGE_LOG: log, FAKE_CLAUDE_LOG: control },
    })
    closing.push(() => adapter.close())
    expect(await adapter.accountUsage()).toMatchObject({
      status: 'ready',
      plan: 'pro',
      windows: [{ kind: 'weekly', usedPercent: 72 }],
    })
    writeFileSync(file, JSON.stringify({ ...weekly, rate_limits: { five_hour: { utilization: 0, resets_at: null } } }))
    expect((await adapter.accountUsage()).windows[0].kind).toBe('weekly')
    expect((await adapter.accountUsage(true)).windows[0]).toMatchObject({ kind: 'five_hour', usedPercent: 0 })
    expect(
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line)),
    ).toEqual([
      { subtype: 'get_usage', skip_behaviors: true },
      { subtype: 'get_usage', skip_behaviors: true },
    ])
    const args = readFileSync(control, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(args.every(argv => argv.includes('--no-session-persistence'))).toBe(true)
  })
  it('Claude 不支持控制请求与没有订阅数据分别显示 unsupported / unavailable', async () => {
    const old = new ClaudeAdapter({
      launcher: launcher('claude'),
      env: { ...process.env, FAKE_CLAUDE_USAGE_UNSUPPORTED: '1' },
    })
    closing.push(() => old.close())
    expect((await old.accountUsage()).status).toBe('unsupported')
    const api = new ClaudeAdapter({ launcher: launcher('claude'), env: { ...process.env } })
    closing.push(() => api.close())
    expect(await api.accountUsage()).toMatchObject({ status: 'unavailable', reason: 'api_key', windows: [] })
  })
  it('Codex 查询当前账号，刷新不触发模型重检；API Key 不调用套餐额度接口', async () => {
    const file = join(root, 'usage.json'),
      log = join(root, 'rpc.jsonl')
    writeFileSync(file, JSON.stringify(codexWeekly))
    const adapter = new CodexAdapter({
      launcher: launcher('codex'),
      env: {
        ...process.env,
        FAKE_CODEX_ACCOUNT: JSON.stringify(account),
        FAKE_CODEX_USAGE_FILE: file,
        FAKE_CODEX_LOG: log,
      },
    })
    closing.push(() => adapter.close())
    expect(await adapter.accountUsage()).toMatchObject({
      status: 'ready',
      account: 'test@example.com',
      plan: 'pro',
      windows: [{ kind: 'weekly', usedPercent: 72 }],
    })
    const before = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
      .filter(m => m.method === 'model/list').length
    writeFileSync(file, JSON.stringify({ rateLimits: { primary: { usedPercent: 81, windowDurationMins: 300 } } }))
    expect((await adapter.accountUsage(true)).windows[0]).toMatchObject({ kind: 'five_hour', usedPercent: 81 })
    expect(
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
        .filter(m => m.method === 'model/list'),
    ).toHaveLength(before)
    const apiLog = join(root, 'api-rpc.jsonl')
    const api = new CodexAdapter({ launcher: launcher('codex'), env: { ...process.env, FAKE_CODEX_LOG: apiLog } })
    closing.push(() => api.close())
    expect((await api.accountUsage()).reason).toBe('api_key')
    expect(readFileSync(apiLog, 'utf8')).not.toContain('account/rateLimits/read')
  })
  it('切换环境配置不泄漏旧账号缓存', async () => {
    const a = join(root, 'a.json'),
      b = join(root, 'b.json')
    writeFileSync(a, JSON.stringify(weekly))
    writeFileSync(b, JSON.stringify({ ...weekly, subscription_type: 'max', rate_limits: {} }))
    let file = a
    const adapter = new ClaudeAdapter({
      launcher: launcher('claude'),
      extraEnv: () => ({ FAKE_CLAUDE_USAGE_FILE: file }),
    })
    closing.push(() => adapter.close())
    expect((await adapter.accountUsage()).plan).toBe('pro')
    file = b
    expect(await adapter.accountUsage()).toMatchObject({ status: 'ready', plan: 'max', windows: [] })
  })
  it.each(['claude', 'codex'] as const)('%s 运行时额度事件到达适配器并合并查询结果', async engine => {
    const file = join(root, 'usage.json'),
      updates: EngineAccountUsage[] = []
    writeFileSync(file, JSON.stringify(engine === 'claude' ? weekly : codexWeekly))
    const env =
      engine === 'claude'
        ? {
            FAKE_CLAUDE_USAGE_FILE: file,
            FAKE_CLAUDE_USAGE_EVENT: JSON.stringify({
              rateLimitType: 'five_hour',
              utilization: 0.91,
              resetsAt: 1800000000,
            }),
          }
        : {
            FAKE_CODEX_ACCOUNT: JSON.stringify(account),
            FAKE_CODEX_USAGE_FILE: file,
            FAKE_CODEX_USAGE_EVENT: JSON.stringify({
              rateLimits: { primary: { usedPercent: 91, windowDurationMins: 300, resetsAt: 1800000000 } },
            }),
          }
    const options = {
      launcher: launcher(engine),
      env: { ...process.env, ...env },
      onAccountUsage: (v: EngineAccountUsage) => updates.push(v),
    }
    const adapter = engine === 'claude' ? new ClaudeAdapter(options) : new CodexAdapter(options)
    const host = new EngineHost({ dataDir: join(root, 'host'), adapters: { [engine]: adapter }, emit() {} })
    closing.push(() => host.shutdown())
    await host.engines()
    await host.engineAccountUsage({ engine })
    const record = host.createSession({ projectId: host.addProject(root).id, engine })
    await host.send(record.id, 'hello')
    await expect.poll(() => updates.some(v => v.windows.some(w => w.usedPercent === 91))).toBe(true)
  })
  it('会话引用用于机器路由，额度查询跟随所选引擎；验证会话确实存在', async () => {
    const file = join(root, 'usage.json')
    writeFileSync(file, JSON.stringify(weekly))
    const adapter = new ClaudeAdapter({
      launcher: launcher('claude'),
      extraEnv: () => ({ FAKE_CLAUDE_USAGE_FILE: file }),
    })
    const host = new EngineHost({ dataDir: join(root, 'host'), adapters: { claude: adapter }, emit() {} })
    closing.push(() => host.shutdown())
    const record = host.createSession({
      projectId: host.addProject(root).id,
      engine: 'claude',
      platform: { groupId: 'g', account: 'test@example.com' },
    })
    expect((await host.engineAccountUsage({ engine: 'claude', sessionId: record.id })).status).toBe('ready')
    await expect(host.engineAccountUsage({ engine: 'claude', sessionId: 'absent' })).rejects.toThrow('会话不存在')
  })
})
