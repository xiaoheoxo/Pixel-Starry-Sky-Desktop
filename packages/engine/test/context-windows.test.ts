// 云端 / 本机模型的上下文窗口、Codex 的自动压缩（GitHub #20，docs/ui/context-settings-branch-switch.md §2）
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HostEvent } from '@pixelsky/protocol'
import { ClaudeAdapter, CodexAdapter, EngineHost } from '../src'
import { windowSettings } from '../src/claude/long-context'
import { claudeSettingsArgument } from '../src/claude/session'
import { codexContextConfig } from '../src/codex/context-config'
import {
  CodexCatalog,
  FALLBACK_WINDOW,
  catalogWith,
  fallbackEntry,
  reasoningFromSibling,
  withUltrafast,
} from '../src/codex/model-catalog'
import { makeTmp, removeTmp } from './helpers/tmp'

const FAKE_CLAUDE = fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url))
const FAKE_CODEX = fileURLToPath(new URL('./fakes/fake-codex.mjs', import.meta.url))
/** 假 Codex 的默认资料提示词（fakes/fake-codex-catalog.mjs） */
const FAKE_DEFAULT_PROMPT = 'You are the fake Codex default prompt.'

let root: string
let events: HostEvent[]
let hosts: EngineHost[]

beforeEach(() => {
  root = makeTmp('context-windows')
  events = []
  hosts = []
})

afterEach(async () => {
  await Promise.all(hosts.map(h => h.shutdown()))
  removeTmp(root)
})

async function waitFor<T>(pick: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = pick()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, 20))
  }
}

const lines = (file: string): string[][] => {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as string[])
  } catch {
    return []
  }
}

/** 建一个项目目录 */
function dir(name: string): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  return path
}

const turnsDone = (id: string): number =>
  events.filter(e => e.kind === 'session' && e.sessionId === id && e.event.type === 'turn_completed').length

function codexHost(sessionEnv?: (r: { provider?: unknown; model?: string | null }) => NodeJS.ProcessEnv) {
  const argvLog = join(root, 'codex-argv.log')
  let host: EngineHost | null = null
  const adapter = new CodexAdapter({
    launcher: { command: process.execPath, args: [FAKE_CODEX] },
    env: { ...process.env, FAKE_CODEX_ARGV: argvLog, FAKE_CODEX_LOG: join(root, 'rpc.jsonl') },
    sessionEnv: r => ({
      ...(r.platform || r.provider
        ? { PIXELSKY_CODEX_BASE_URL: 'http://127.0.0.1:1234/v1', PIXELSKY_CODEX_TOKEN: 'loopback-only' }
        : {}),
      ...(sessionEnv?.(r) ?? {}),
    }),
    launchOptions: () => {
      const o = host!.launchOptions('codex')
      return {
        askQuestions: o.askQuestions,
        args: o.args,
        autoCompactPct: o.autoCompactPct,
        contextWindows: o.contextWindows,
        autoReviewModel: o.autoReviewModel,
        steeringValidated: true,
      }
    },
  })
  host = new EngineHost({ dataDir: join(root, 'data'), emit: e => events.push(e), adapters: { codex: adapter } })
  hosts.push(host)
  const project = host.addProject(dir('project-' + hosts.length))
  /** 最近一次启动会话进程的参数（检测握手不带 -c 的上下文项，按 app-server 后面有没有会话设置区分不了，取最后一次） */
  const launches = (): string[] => lines(argvLog).map(a => a.join(' '))
  return { host, project, launches }
}

describe('设置：每个模型的上下文窗口', () => {
  it('按模型合并、null 清掉；范围和模型名不对就整个不保存；会广播', async () => {
    const { host } = codexHost()
    await host.setEngineConfig('codex', { contextWindows: { platform: { 'gpt-5': 400_000 }, self: { o3: 200_000 } } })
    await host.setEngineConfig('codex', { contextWindows: { self: { 'gpt-5': 272_000 } } })
    expect(host.engineConfig().codex.contextWindows).toEqual({
      platform: { 'gpt-5': 400_000 },
      self: { o3: 200_000, 'gpt-5': 272_000 },
    })
    await host.setEngineConfig('codex', { contextWindows: { self: { o3: null } } })
    expect(host.engineConfig().codex.contextWindows.self).toEqual({ 'gpt-5': 272_000 })
    await expect(host.setEngineConfig('codex', { contextWindows: { self: { x: 999 } } })).rejects.toThrow(
      '上下文窗口不对',
    )
    await expect(host.setEngineConfig('codex', { contextWindows: { self: { x: 100_000_001 } } })).rejects.toThrow()
    await expect(host.setEngineConfig('codex', { contextWindows: { self: { ' x': 200_000 } } })).rejects.toThrow(
      '模型名不对',
    )
    expect(host.engineConfig().codex.contextWindows.self).toEqual({ 'gpt-5': 272_000 })
    expect(
      events.some(e => e.kind === 'engine_config' && e.config.codex.contextWindows.platform['gpt-5'] === 400_000),
    ).toBe(true)
    // 全清掉后设置文件里不留空对象
    await host.setEngineConfig('codex', { contextWindows: { platform: { 'gpt-5': null }, self: { 'gpt-5': null } } })
    const file = JSON.parse(readFileSync(join(root, 'data', 'engine-settings.json'), 'utf8'))
    expect(file.options?.codex?.contextWindows).toBeUndefined()
  })

  it('设置云同步带上窗口，收到时整份换掉本机的', async () => {
    const a = codexHost().host
    await a.setEngineConfig('codex', { contextWindows: { platform: { 'gpt-5': 400_000 } }, autoCompactPct: 80 })
    const synced = a.syncableSettings()['desktop.engine.options']
    expect(synced.engines.codex).toMatchObject({
      autoCompactPct: 80,
      contextWindows: { platform: { 'gpt-5': 400_000 }, self: {} },
    })
    const b = codexHost().host
    await b.setEngineConfig('codex', { contextWindows: { self: { o3: 200_000 } } })
    await b.applySyncableSetting('desktop.engine.options', synced)
    expect(b.engineConfig().codex.contextWindows).toEqual({ platform: { 'gpt-5': 400_000 }, self: {} })
    expect(b.engineConfig().codex.autoCompactPct).toBe(80)
  })
})

describe('Codex：窗口和自动压缩的启动参数', () => {
  it('没设时不带；本机模型带窗口和按百分比算的 token 数，放在用户参数后面', async () => {
    const { host, project, launches } = codexHost()
    const s = host.createSession({ projectId: project.id, engine: 'codex', model: 'gpt-5', permissionMode: 'ask' })
    await host.send(s.id, '一')
    await waitFor(() => turnsDone(s.id) === 1)
    expect(launches().at(-1)).not.toContain('model_context_window')
    expect(launches().at(-1)).not.toContain('model_auto_compact_token_limit')

    await host.setEngineConfig('codex', {
      args: ['-c', 'model_context_window=1'],
      contextWindows: { self: { 'gpt-5': 300_000 } },
      autoCompactPct: 80,
    })
    await host.send(s.id, '二')
    await waitFor(() => turnsDone(s.id) === 2)
    const argv = launches().at(-1)!
    expect(argv).toContain('model_context_window=300000')
    expect(argv).toContain('model_auto_compact_token_limit=240000')
    // 后写的生效：设置的窗口在用户参数后面
    expect(argv.indexOf('model_context_window=300000')).toBeGreaterThan(argv.indexOf('model_context_window=1'))
  })

  it('云端模型用 platform 那一份；只设百分比时按价格表的窗口算', async () => {
    const { host, project, launches } = codexHost()
    await host.setEngineConfig('codex', { contextWindows: { platform: { 'gpt-5-mini': 150_000 } }, autoCompactPct: 60 })
    const s = host.createSession({
      projectId: project.id,
      engine: 'codex',
      model: 'gpt-5-mini',
      platform: { groupId: '7', account: 'a@example.com' },
      permissionMode: 'ask',
    })
    await host.send(s.id, '一')
    await waitFor(() => turnsDone(s.id) === 1)
    expect(launches().at(-1)).toContain('model_context_window=150000')
    expect(launches().at(-1)).toContain('model_auto_compact_token_limit=90000')

    // 本机模型没填窗口：gpt-5 在价格表里是 272K
    const own = host.createSession({ projectId: project.id, engine: 'codex', model: 'gpt-5', permissionMode: 'ask' })
    await host.send(own.id, '一')
    await waitFor(() => turnsDone(own.id) === 1)
    expect(launches().at(-1)).not.toContain('model_context_window')
    expect(launches().at(-1)).toContain('model_auto_compact_token_limit=163200')
  })

  it('不知道窗口时先不带；Codex 报过窗口后按它算', async () => {
    const { host, project, launches } = codexHost()
    await host.setEngineConfig('codex', { autoCompactPct: 80 })
    const s = host.createSession({ projectId: project.id, engine: 'codex', permissionMode: 'ask' })
    await host.send(s.id, '一')
    await waitFor(() => turnsDone(s.id) === 1)
    expect(launches().at(-1)).not.toContain('model_auto_compact_token_limit')
    // 假 Codex 的当前模型是 fake-codex，报的窗口是 128000
    await host.setEngineConfig('codex', { autoCompactPct: 90 })
    await host.send(s.id, '二')
    await waitFor(() => turnsDone(s.id) === 2)
    expect(launches().at(-1)).toContain('model_auto_compact_token_limit=115200')
  })

  it('自定义 API 的窗口经环境变量带来，不留在进程环境里；换模型时重启进程按新模型取', async () => {
    const windows: Record<string, number> = { 'deepseek-chat': 64_000, 'kimi-k2': 256_000 }
    const { host, project, launches } = codexHost(r =>
      r.provider && r.model && windows[r.model] ? { PIXELSKY_CODEX_CONTEXT_WINDOW: String(windows[r.model]) } : {},
    )
    await host.setEngineConfig('codex', { autoCompactPct: 70 })
    const s = host.createSession({
      projectId: project.id,
      engine: 'codex',
      model: 'deepseek-chat',
      provider: { id: 'p1' },
      permissionMode: 'ask',
    })
    await host.send(s.id, '一')
    await waitFor(() => turnsDone(s.id) === 1)
    expect(launches().at(-1)).toContain('model_context_window=64000')
    expect(launches().at(-1)).toContain('model_auto_compact_token_limit=44800')
    const count = launches().length
    await host.update(s.id, { model: 'kimi-k2' })
    await host.send(s.id, '二')
    await waitFor(() => turnsDone(s.id) === 2)
    expect(launches().length).toBe(count + 1)
    expect(launches().at(-1)).toContain('model_context_window=256000')
  })
})

describe('Claude Code：云端 / 本机模型的窗口', () => {
  it('本机会话：超过 200K 的模型名带 [1m]，--settings 里按模型写自动压缩窗口（别名和完整名都写）', async () => {
    const projectsDir = join(root, 'claude-projects')
    let host: EngineHost | null = null
    const adapter = new ClaudeAdapter({
      launcher: { command: process.execPath, args: [FAKE_CLAUDE] },
      projectsDir,
      launchOptions: () => host!.launchOptions('claude'),
      env: { ...process.env, FAKE_CLAUDE_PROJECTS: projectsDir, FAKE_CLAUDE_LOG: join(root, 'argv.log') },
    })
    host = new EngineHost({ dataDir: join(root, 'data'), emit: e => events.push(e), adapters: { claude: adapter } })
    hosts.push(host)
    // 先读一次模型列表：别名 opus 指向的完整模型名
    const catalog = await host.engineCatalog('claude')
    const opus = catalog.models?.find(m => m.id === 'opus')
    await host.setEngineConfig('claude', { contextWindows: { self: { opus: 1_000_000, haiku: 150_000 } } })
    const s = host.createSession({ projectId: host.addProject(dir('p')).id, model: 'opus' })
    await host.send(s.id, '你好')
    await waitFor(() => turnsDone(s.id) === 1)
    const args = lines(join(root, 'argv.log')).at(-1)!
    expect(args[args.indexOf('--model') + 1]).toBe('opus[1m]')
    const settings = JSON.parse(args[args.indexOf('--settings') + 1])
    expect(settings.modelSettings).toMatchObject({
      opus: { autoCompactWindow: 1_000_000 },
      haiku: { autoCompactWindow: 150_000 },
    })
    if (opus?.resolved) expect(settings.modelSettings[opus.resolved]).toEqual({ autoCompactWindow: 1_000_000 })
  })
})

describe('Codex 经网关：模型目录（§2.3.1）', () => {
  const launcher = { command: process.execPath, args: [FAKE_CODEX] }
  const readCatalog = (argv: string): { models: Array<Record<string, unknown>> } => {
    const path = /model_catalog_json="([^"]+)"/.exec(argv)?.[1]
    if (!path) throw new Error('没有 model_catalog_json')
    return JSON.parse(readFileSync(path.replace(/\\\\/g, '\\'), 'utf8'))
  }

  it('自带目录有的模型：不超上限不生成，超了复制这一项改窗口；没有的加一项默认资料', () => {
    const bundled = [{ slug: 'gpt-5', context_window: 272_000, max_context_window: 272_000, extra: 1 }]
    expect(catalogWith(bundled, 'gpt-5', 200_000, null, 'P')).toBeNull()
    expect(catalogWith(bundled, 'gpt-5', null, 500_000, 'P')).toBeNull()
    expect(catalogWith(bundled, 'gpt-5', 500_000, null, null)?.models).toEqual([
      {
        slug: 'gpt-5',
        context_window: 500_000,
        max_context_window: 500_000,
        extra: 1,
        auto_review_model_override: 'gpt-5',
      },
    ])
    const added = catalogWith(bundled, 'grok-4.7', null, 500_000, 'P')!.models
    expect(added[0]).toBe(bundled[0])
    expect(added[1]).toEqual({ ...fallbackEntry('grok-4.7', 500_000, 'P'), auto_review_model_override: 'grok-4.7' })
    expect(catalogWith(bundled, 'glm-5', 300_000, 500_000, 'P')!.models[1].context_window).toBe(300_000)
    expect(catalogWith(bundled, 'glm-5', null, null, 'P')!.models[1].max_context_window).toBe(FALLBACK_WINDOW)
    // 没拿到默认提示词：照现在用 Codex 的默认资料
    expect(catalogWith(bundled, 'glm-5', 300_000, null, null)).toBeNull()
  })

  it('自动审核用的模型（docs/ui/codex-auto-review-model.md）：生成的这一项总写上，不设就是对话模型；只有换审核模型才为自带模型生成', () => {
    const bundled = [
      { slug: 'gpt-6.1-sol', context_window: 272_000 },
      { slug: 'codex-auto-review', context_window: 272_000 },
    ]
    // 不给文件时 Codex 本来就用对话模型审核（实测 0.169）：不设审核模型、窗口也没超，照旧不生成
    expect(catalogWith(bundled, 'gpt-6.1-sol', null, null, 'P')).toBeNull()
    expect(catalogWith(bundled, 'gpt-6.1-sol', null, null, 'P', { reviewModel: 'gpt-6.1-sol' })).toBeNull()
    const own = catalogWith(bundled, 'gpt-6.1-sol', null, null, 'P', { reviewModel: 'gpt-6-luna' })!.models
    expect(own[0]).toEqual({ slug: 'gpt-6.1-sol', context_window: 272_000, auto_review_model_override: 'gpt-6-luna' })
    // 别的模型那几项不动
    expect(own[1]).toBe(bundled[1])
    // 没资料的模型：加的那一项写上审核模型，不设时是对话模型自己（不然 Codex 会改用 codex-auto-review）
    expect(catalogWith(bundled, 'gpt-6.2-astra', null, null, 'P')!.models.at(-1)!.auto_review_model_override).toBe(
      'gpt-6.2-astra',
    )
    expect(
      catalogWith(bundled, 'gpt-6.2-astra', null, null, 'P', { reviewModel: 'codex-auto-review' })!.models.at(-1)!
        .auto_review_model_override,
    ).toBe('codex-auto-review')
  })

  it('没资料的新模型抄自带目录里同系列、版本最高的推理档位；找不到同系列的照旧不写', () => {
    const levels = (n: number) => Array.from({ length: n }, (_, i) => ({ effort: 'e' + i, description: '' }))
    const bundled = [
      { slug: 'gpt-6-sol', supported_reasoning_levels: levels(2), default_reasoning_level: 'medium' },
      { slug: 'gpt-6.1-sol', supported_reasoning_levels: levels(6), default_reasoning_level: 'low' },
      { slug: 'gpt-5.6-sol', supported_reasoning_levels: levels(3) },
      { slug: 'gpt-6-astra', supported_reasoning_levels: levels(6), default_reasoning_level: 'low' },
      { slug: 'gpt-6-luna', supported_reasoning_levels: [] },
      { slug: 'codex-auto-review', supported_reasoning_levels: levels(1) },
    ]
    expect(reasoningFromSibling(bundled, 'gpt-6.2-sol')).toEqual({
      supported_reasoning_levels: levels(6),
      default_reasoning_level: 'low',
    })
    expect(reasoningFromSibling(bundled, 'gpt-6.2-astra').supported_reasoning_levels).toEqual(levels(6))
    // 同系列只有空档位的、认不出系列的、别家的：不写
    expect(reasoningFromSibling(bundled, 'gpt-6.2-luna')).toEqual({})
    expect(reasoningFromSibling(bundled, 'deepseek-v4-pro')).toEqual({})
    expect(reasoningFromSibling(bundled, 'kimi-k3')).toEqual({})
    // 生成目录时并进补的那一项，Ultrafast 照常声明
    const added = catalogWith(bundled, 'gpt-6.2-sol', null, null, 'P', { ultrafast: true })!.models.at(-1)!
    expect(added).toMatchObject({ slug: 'gpt-6.2-sol', default_reasoning_level: 'low', base_instructions: 'P' })
    expect(added.supported_reasoning_levels).toEqual(levels(6))
    expect((added.service_tiers as { id: string }[]).map(t => t.id)).toContain('ultrafast')
    expect(catalogWith(bundled, 'deepseek-v4-pro', null, null, 'P')!.models.at(-1)!.supported_reasoning_levels).toEqual(
      [],
    )
  })

  it('取自带目录、实测默认提示词（只测一次，存到磁盘），写出目录文件', async () => {
    const catalog = new CodexCatalog(join(root, 'catalog'))
    const env = { ...process.env }
    const file = await catalog.file(launcher, 'test', env, 'grok-4.7', null, 500_000)
    const models = (JSON.parse(readFileSync(file!, 'utf8')) as { models: Array<Record<string, unknown>> }).models
    expect(models.map(m => m.slug)).toEqual(['gpt-5', 'gpt-5-mini', 'o3', 'grok-4.7'])
    expect(models[3]).toMatchObject({ context_window: 500_000, base_instructions: FAKE_DEFAULT_PROMPT })
    expect(
      readFileSync(
        join(root, 'catalog', readdirSync(join(root, 'catalog')).find(n => n.startsWith('instructions-'))!),
        'utf8',
      ),
    ).toBe(FAKE_DEFAULT_PROMPT)
    expect(await catalog.file(launcher, 'test', env, 'gpt-5', 200_000, null)).toBeNull()
    // 新的实例（重启应用）读存下的提示词
    const again = new CodexCatalog(join(root, 'catalog'))
    expect(await again.file(launcher, 'test', env, 'glm-5', 300_000, null)).toBeTruthy()
  })

  it('云端线路上 Codex 没有资料的模型：启动带 model_catalog_json；自有会话、用户自己写了目录时不带', async () => {
    const { host, project, launches } = codexHost()
    await host.setEngineConfig('codex', { contextWindows: { platform: { 'grok-4.7': 500_000 } } })
    const s = host.createSession({
      projectId: project.id,
      engine: 'codex',
      model: 'grok-4.7',
      platform: { groupId: '7', account: 'a@example.com' },
      permissionMode: 'ask',
    })
    await host.send(s.id, '一')
    await waitFor(() => turnsDone(s.id) === 1)
    const argv = launches().at(-1)!
    expect(argv).toContain('model_context_window=500000')
    const grok = readCatalog(argv).models.find(m => m.slug === 'grok-4.7')
    expect(grok).toMatchObject({ context_window: 500_000, max_context_window: 500_000 })

    const own = host.createSession({ projectId: project.id, engine: 'codex', model: 'grok-4.7', permissionMode: 'ask' })
    await host.send(own.id, '一')
    await waitFor(() => turnsDone(own.id) === 1)
    expect(launches().at(-1)).not.toContain('model_catalog_json')

    await host.setEngineConfig('codex', { args: ['-c', 'model_catalog_json="mine.json"'] })
    await host.send(s.id, '二')
    await waitFor(() => turnsDone(s.id) === 2)
    expect(
      launches()
        .at(-1)!
        .match(/model_catalog_json/g),
    ).toHaveLength(1)
  })

  // docs/codex-ultrafast-platform.md：Codex 只发目录里声明了的档位
  it('平台线路的 Ultrafast：目录里给这个模型声明 Fast、Ultrafast；有资料的模型不改窗口也复制一份', () => {
    const bundled = [
      { slug: 'gpt-6-astra', context_window: 272_000, service_tiers: [{ id: 'priority', name: 'Fast' }] },
      { slug: 'gpt-5', context_window: 272_000 },
    ]
    expect(catalogWith(bundled, 'gpt-6-astra', null, null, 'P')).toBeNull()
    const astra = catalogWith(bundled, 'gpt-6-astra', null, null, 'P', { ultrafast: true })!.models
    expect(astra[0].service_tiers).toEqual([
      { id: 'priority', name: 'Fast' },
      expect.objectContaining({ id: 'ultrafast' }),
    ])
    expect(astra[0].additional_speed_tiers).toEqual(['fast'])
    expect(astra[1]).toBe(bundled[1])
    // 没有资料的模型（GPT-6.2 不在 0.169 的自带目录里）：默认资料加上两个档位
    const sol = catalogWith(bundled, 'gpt-6.2-sol', null, null, 'P', { ultrafast: true })!.models[2]
    expect(sol).toMatchObject({ slug: 'gpt-6.2-sol', base_instructions: 'P' })
    expect((sol.service_tiers as Array<{ id: string }>).map(x => x.id)).toEqual(['priority', 'ultrafast'])
    // 已经声明过的不重复
    expect(withUltrafast(withUltrafast(bundled[0])).service_tiers).toHaveLength(2)
  })

  it('平台线路开 Ultrafast：认的模型启动带声明了 ultrafast 的目录、每轮发 ultrafast；不认的模型退回 Fast', async () => {
    const { host, project, launches } = codexHost()
    const s = host.createSession({
      projectId: project.id,
      engine: 'codex',
      model: 'gpt-6.2-sol',
      platform: { groupId: '7', account: 'a@example.com' },
      permissionMode: 'ask',
    })
    await host.update(s.id, { fast: true, ultrafast: true })
    await host.send(s.id, '一')
    await waitFor(() => turnsDone(s.id) === 1)
    const sol = readCatalog(launches().at(-1)!).models.find(m => m.slug === 'gpt-6.2-sol')
    expect((sol?.service_tiers as Array<{ id: string }>).map(x => x.id)).toContain('ultrafast')
    const turns = lines(join(root, 'rpc.jsonl'))
      .map(m => m as unknown as { method?: string; params?: { serviceTier?: string } })
      .filter(m => m.method === 'turn/start')
    expect(turns.at(-1)?.params?.serviceTier).toBe('ultrafast')
    expect(host.open(s.id).record).toMatchObject({ fast: true, ultrafast: true })

    // 换到 sub2api 不按 Ultrafast 计价的模型：退回 Fast 并提示
    await host.update(s.id, { model: 'grok-4.7' })
    await waitFor(() => host.open(s.id).record.ultrafast === false)
    expect(host.open(s.id).record.fast).toBe(true)
  })

  it('平台会话中途从不认的模型换到认的：下一条换进程，新目录里有它的 Ultrafast', async () => {
    const { host, project, launches } = codexHost()
    const s = host.createSession({
      projectId: project.id,
      engine: 'codex',
      model: 'grok-4.7',
      platform: { groupId: '7', account: 'a@example.com' },
      permissionMode: 'ask',
    })
    await host.send(s.id, '一')
    await waitFor(() => turnsDone(s.id) === 1)
    const before = launches().length
    await host.update(s.id, { model: 'gpt-6.2-sol' })
    await host.update(s.id, { fast: true, ultrafast: true })
    await host.send(s.id, '二')
    await waitFor(() => turnsDone(s.id) === 2)
    expect(launches().length).toBeGreaterThan(before)
    const sol = readCatalog(launches().at(-1)!).models.find(m => m.slug === 'gpt-6.2-sol')
    expect((sol?.service_tiers as Array<{ id: string }>).map(x => x.id)).toContain('ultrafast')
  })
  // 卡死的会话（2026-11-18 日志）：换到不能看图的模型后，旧截图照发，上游报 input[N].content[1] 不对，之后每轮都失败
  it('没资料的模型写上能不能看图：不能看的只收文字，没判断的不写', () => {
    const bundled = [{ slug: 'gpt-5', context_window: 272_000 }]
    expect(
      catalogWith(bundled, 'deepseek-v4-pro', null, null, 'P', { images: false })!.models[1].input_modalities,
    ).toEqual(['text'])
    expect(catalogWith(bundled, 'glm-5', null, null, 'P', { images: true })!.models[1].input_modalities).toEqual([
      'text',
      'image',
    ])
    expect(catalogWith(bundled, 'glm-5', null, null, 'P')!.models[1]).not.toHaveProperty('input_modalities')
  })

  it('平台会话空闲时换到不能看图的模型：马上换进程，新目录里这个模型只收文字', async () => {
    const { host, project, launches } = codexHost()
    const s = host.createSession({
      projectId: project.id,
      engine: 'codex',
      model: 'gpt-6.2-sol',
      platform: { groupId: '7', account: 'a@example.com' },
      permissionMode: 'ask',
    })
    await host.send(s.id, '一')
    await waitFor(() => turnsDone(s.id) === 1)
    const before = launches().length
    await host.update(s.id, { model: 'deepseek-v4-pro' })
    await host.send(s.id, '二')
    await waitFor(() => turnsDone(s.id) === 2)
    expect(launches().length).toBe(before + 1)
    const argv = launches().at(-1)!
    const deepseek = readCatalog(argv).models.find(m => m.slug === 'deepseek-v4-pro')
    expect(deepseek?.input_modalities).toEqual(['text'])
  })

  it('设了自动审核模型：平台会话启动时写进目录（审核请求用它），改设置后下一条重启进程；自己的账号不受影响', async () => {
    const { host, project, launches } = codexHost()
    await host.setEngineConfig('codex', { autoReviewModel: 'gpt-6-luna' })
    expect(host.engineConfig().codex.autoReviewModel).toBe('gpt-6-luna')
    await expect(host.setEngineConfig('codex', { autoReviewModel: 'a b' })).rejects.toThrow('自动审核模型不对')
    // 名字里有 s 的照常能存（gpt-6.2-sol）
    await host.setEngineConfig('codex', { autoReviewModel: 'gpt-6.2-sol' })
    await host.setEngineConfig('codex', { autoReviewModel: 'gpt-6-luna' })
    const s = host.createSession({
      projectId: project.id,
      engine: 'codex',
      model: 'deepseek-v4-pro',
      platform: { groupId: '7', account: 'a@example.com' },
      permissionMode: 'auto',
    })
    await host.send(s.id, '一')
    await waitFor(() => turnsDone(s.id) === 1)
    const entry = (argv: string) => readCatalog(argv).models.find(m => m.slug === 'deepseek-v4-pro')
    expect(entry(launches().at(-1)!)?.auto_review_model_override).toBe('gpt-6-luna')
    // 改回跟随对话模型：下一条消息前换进程，这一项写回对话模型自己
    const before = launches().length
    await host.setEngineConfig('codex', { autoReviewModel: null })
    await host.send(s.id, '二')
    await waitFor(() => turnsDone(s.id) === 2)
    expect(launches().length).toBe(before + 1)
    expect(entry(launches().at(-1)!)?.auto_review_model_override).toBe('deepseek-v4-pro')
    // 自己的账号：不经网关，不生成目录
    await host.setEngineConfig('codex', { autoReviewModel: 'gpt-6-luna' })
    const own = host.createSession({
      projectId: project.id,
      engine: 'codex',
      model: 'fake-codex',
      permissionMode: 'auto',
    })
    await host.send(own.id, '三')
    await waitFor(() => turnsDone(own.id) === 1)
    expect(launches().at(-1)).not.toContain('model_catalog_json')
  })

  it('平台会话跑着时换模型：这一轮结束就关掉旧进程（目标模式不会用旧模型接着开轮），下一条按新模型起', async () => {
    const { host, project, launches } = codexHost()
    const s = host.createSession({
      projectId: project.id,
      engine: 'codex',
      model: 'gpt-6.2-sol',
      platform: { groupId: '7', account: 'a@example.com' },
      permissionMode: 'ask',
    })
    await host.send(s.id, '慢一点')
    await waitFor(() => host.open(s.id).state === 'running')
    await host.update(s.id, { model: 'deepseek-v4-pro' })
    await waitFor(() => turnsDone(s.id) === 1)
    // 一轮结束就放掉旧进程，不等下一条消息（目标模式会在这中间用旧进程接着开轮）
    const runtime = (host as unknown as { ctx: { runtimes: Map<string, { session: unknown }> } }).ctx.runtimes.get(
      s.id,
    )!
    await waitFor(() => runtime.session === null)
    const before = launches().length
    await host.send(s.id, '二')
    await waitFor(() => turnsDone(s.id) === 2)
    expect(launches().length).toBe(before + 1)
    const deepseek = readCatalog(launches().at(-1)!).models.find(m => m.slug === 'deepseek-v4-pro')
    expect(deepseek?.input_modalities).toEqual(['text'])
  })
})

describe('纯函数', () => {
  it('Codex：窗口依次取填的、报过的、价格表；没有百分比不算 token 数', () => {
    const windows = { platform: { a: 100_000 }, self: { a: 200_000 } }
    expect(codexContextConfig({ record: {}, model: 'a', windows, autoCompactPct: 80 })).toEqual({
      window: 200_000,
      limit: 160_000,
    })
    expect(codexContextConfig({ record: { platform: { groupId: 'g', account: 'x' } }, model: 'a', windows })).toEqual({
      window: 100_000,
      limit: null,
    })
    expect(codexContextConfig({ record: {}, model: 'b', windows, autoCompactPct: 50, known: 90_000 })).toEqual({
      window: null,
      limit: 45_000,
    })
    expect(codexContextConfig({ record: {}, model: null, windows, autoCompactPct: 50 })).toEqual({
      window: null,
      limit: null,
    })
    // 自定义 API 不看设置里的，只看带来的
    expect(
      codexContextConfig({ record: { provider: { id: 'p' } }, model: 'a', windows, providerWindow: 'oops' }),
    ).toEqual({ window: null, limit: null })
  })

  it('Claude：窗口夹在 Claude Code 接受的 100K–1M 之间，超过 200K 的进 [1m] 名单', () => {
    expect(windowSettings({ a: 50_000, b: 300_000, c: 5_000_000 })).toEqual({
      long: ['b', 'c'],
      modelSettings: {
        a: { autoCompactWindow: 100_000 },
        b: { autoCompactWindow: 300_000 },
        c: { autoCompactWindow: 1_000_000 },
      },
    })
    expect(windowSettings({})).toEqual({ long: [], modelSettings: null })
  })

  it('--settings：网关文件里自定义 API 的和设置里的按模型合并', () => {
    const merged = claudeSettingsArgument(undefined, null, {
      modelSettings: { opus: { autoCompactWindow: 300_000 } },
    })
    expect(JSON.parse(merged!)).toEqual({ modelSettings: { opus: { autoCompactWindow: 300_000 } } })
  })
})
