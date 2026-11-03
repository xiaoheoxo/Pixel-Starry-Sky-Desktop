// 设置 › 本机引擎 › 详情（docs/ui/engine-settings-redesign.md）：按引擎的新会话默认值、引擎级选项传给 Claude Code、改了下一条消息前重启进程
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HostEvent } from '@pixelsky/protocol'
import { ClaudeAdapter, EngineHost } from '../src'

const FAKE = fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url))

let root: string
let events: HostEvent[]
let hosts: EngineHost[]

function makeHost(): EngineHost {
  const projectsDir = join(root, 'claude-projects')
  let host: EngineHost | null = null
  const adapter = new ClaudeAdapter({
    launcher: { command: process.execPath, args: [FAKE] },
    projectsDir,
    launchOptions: () => host!.launchOptions('claude'),
    env: {
      ...process.env,
      FAKE_CLAUDE_PROJECTS: projectsDir,
      FAKE_CLAUDE_LOG: join(root, 'argv.log'),
      FAKE_CLAUDE_ENV_LOG: join(root, 'env.json'),
    },
  })
  host = new EngineHost({ dataDir: join(root, 'data'), emit: e => events.push(e), adapters: { claude: adapter } })
  hosts.push(host)
  return host
}

function spawnArgs(): string[][] {
  try {
    return readFileSync(join(root, 'argv.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as string[])
  } catch {
    return []
  }
}

const envLog = (): { autoCompact?: string; todoTools?: string } =>
  JSON.parse(readFileSync(join(root, 'env.json'), 'utf8'))

async function waitFor<T>(pick: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = pick()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, 20))
  }
}

const turnsDone = (id: string): number =>
  events.filter(e => e.kind === 'session' && e.sessionId === id && e.event.type === 'turn_completed').length

function project(host: EngineHost) {
  return host.addProject(mkdtempSync(join(root, 'proj-')))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pixelsky-engine-options-'))
  events = []
  hosts = []
})

afterEach(async () => {
  await Promise.all(hosts.map(h => h.shutdown()))
  rmSync(root, { recursive: true, force: true })
})

describe('本机引擎详情设置', () => {
  it('旧版的全局默认值迁移到每个引擎名下', () => {
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(
      join(root, 'data', 'engine-settings.json'),
      JSON.stringify({
        version: 1,
        defaults: {
          engine: 'claude',
          model: 'opus',
          effort: 'low',
          permissionMode: 'plan',
          ultracode: false,
          fast: true,
          thinkingSummaries: false,
        },
      }),
    )
    const host = makeHost()
    expect(host.engineConfig().claude.defaults).toEqual({
      model: 'opus',
      effort: 'low',
      permissionMode: 'plan',
      ultracode: false,
      fast: true,
      thinkingSummaries: false,
    })
    expect(host.defaults()).toMatchObject({ engine: 'claude', effort: 'low', permissionMode: 'plan' })
  })

  it('新会话默认值改了立刻用于新会话；会话里改权限记到所属引擎名下，推理强度那几项只影响这个会话（GitHub #6）', async () => {
    const host = makeHost()
    const p = project(host)
    await host.setEngineConfig('claude', { defaults: { effort: 'max', permissionMode: 'full' } })
    const a = host.createSession({ projectId: p.id })
    expect(a).toMatchObject({ engine: 'claude', effort: 'max', permissionMode: 'full' })
    await host.update(a.id, { effort: 'low', fast: true, ultracode: true, thinkingSummaries: false })
    expect(host.engineConfig().claude.defaults).toMatchObject({
      effort: 'max',
      fast: false,
      ultracode: false,
      thinkingSummaries: true,
    })
    await host.update(a.id, { permissionMode: 'plan' })
    expect(host.defaults()).toMatchObject({ engine: 'claude', effort: 'max', permissionMode: 'plan' })
    expect(host.createSession({ projectId: p.id })).toMatchObject({ effort: 'max', permissionMode: 'plan' })
    await expect(host.setEngineConfig('claude', { defaults: { effort: 'huge' as never } })).rejects.toThrow(
      '默认推理强度不对',
    )
    await expect(host.setEngineConfig('claude', { defaults: { permissionMode: 'yolo' as never } })).rejects.toThrow(
      '默认权限不对',
    )
  })

  it('打开「记住会话里的选择」：会话里和新会话界面上改的推理强度那几项都记成默认值，配置随之广播、可以同步', async () => {
    const host = makeHost()
    const p = project(host)
    expect(host.engineConfig().claude.rememberChoices).toBe(false)
    await host.setEngineConfig('claude', { rememberChoices: true })
    expect(host.engineConfig().claude.rememberChoices).toBe(true)
    const a = host.createSession({ projectId: p.id, effort: 'low', fast: true })
    expect(host.engineConfig().claude.defaults).toMatchObject({ effort: 'low', fast: true })
    events = []
    await host.update(a.id, { effort: 'xhigh', thinkingSummaries: false })
    expect(host.engineConfig().claude.defaults).toMatchObject({ effort: 'xhigh', thinkingSummaries: false })
    expect(events.some(e => e.kind === 'engine_config' && e.config.claude.defaults.effort === 'xhigh')).toBe(true)
    expect(host.syncableSettings()['desktop.engine.options'].engines.claude?.rememberChoices).toBe(true)
    await host.applySyncableSetting('desktop.engine.options', { engines: { claude: {} } })
    expect(host.engineConfig().claude.rememberChoices).toBe(false)
    // 关掉以后又只影响会话
    await host.update(a.id, { effort: 'low' })
    expect(host.engineConfig().claude.defaults.effort).toBe('xhigh')
    // 频道成员按自己的配置开会话：不改默认值
    await host.setEngineConfig('claude', { rememberChoices: true })
    host.createSession({ projectId: p.id, effort: 'max', fast: false, rememberChoices: false })
    expect(host.engineConfig().claude.defaults.effort).toBe('xhigh')
    await expect(host.setEngineConfig('claude', { rememberChoices: 'yes' as never })).rejects.toThrow(
      '记住会话里的选择',
    )
  })

  it('引擎级选项传给 Claude Code：输出风格、禁用提问、压缩触发点', async () => {
    const host = makeHost()
    await host.setEngineConfig('claude', {
      outputStyle: 'Explanatory',
      askQuestions: false,
      autoCompactPct: 70,
      autoPlan: false,
    })
    expect(host.engineConfig().claude).toMatchObject({
      outputStyle: 'Explanatory',
      askQuestions: false,
      autoCompactPct: 70,
      autoPlan: false,
    })
    const s = host.createSession({ projectId: project(host).id })
    await host.send(s.id, '你好')
    await waitFor(() => turnsDone(s.id) === 1)
    const args = spawnArgs().at(-1)!
    expect(args.join(' ')).toContain('--disallowedTools AskUserQuestion')
    // 关掉了自动列计划：不追加说明
    expect(args).not.toContain('--append-system-prompt-file')
    const settings = args[args.indexOf('--settings') + 1]
    expect(JSON.parse(settings)).toMatchObject({ outputStyle: 'Explanatory' })
    expect(envLog().autoCompact).toBe('70')
    // 任务清单工具默认打开（不开的话 -p 模式下模型没有待办工具，进度卡片出不来）
    expect(envLog().todoTools).toBe('1')
    await expect(host.setEngineConfig('claude', { autoCompactPct: 33 })).rejects.toThrow('自动压缩触发点不对')
  })

  it('默认：允许提问、跟随 Claude Code 的输出风格和压缩阈值，不接收其他 Claude Code 会话的消息', async () => {
    const host = makeHost()
    expect(host.engineConfig().claude).toMatchObject({
      outputStyle: null,
      askQuestions: true,
      autoPlan: true,
      autoCompactPct: null,
      hidden: false,
      peerMessages: false,
      peekSessions: 'off',
    })
    const s = host.createSession({ projectId: project(host).id })
    await host.send(s.id, '你好')
    await waitFor(() => turnsDone(s.id) === 1)
    const args = spawnArgs().at(-1)!
    expect(args).not.toContain('--disallowedTools')
    // 默认自动列计划：带上说明文件
    expect(args).toContain('--append-system-prompt-file')
    // 只有跨会话消息的收件设置（docs/ui/import-collab.md 第 5 项④）
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ crossSessionInbound: 'refuse' })
    expect(envLog().autoCompact).toBeUndefined()
  })

  it('打开「接收其他 Claude Code 会话发来的消息」：--settings 里改成 accept', async () => {
    const host = makeHost()
    await host.setEngineConfig('claude', { peerMessages: true })
    expect(host.engineConfig().claude.peerMessages).toBe(true)
    const s = host.createSession({ projectId: project(host).id })
    await host.send(s.id, '你好')
    await waitFor(() => turnsDone(s.id) === 1)
    const args = spawnArgs().at(-1)!
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toMatchObject({ crossSessionInbound: 'accept' })
    await host.setEngineConfig('claude', { peerMessages: false })
    expect(host.engineConfig().claude.peerMessages).toBe(false)
    await expect(host.setEngineConfig('claude', { peerMessages: 'yes' as unknown as boolean })).rejects.toThrow(
      '接收其他 Claude Code 会话的消息',
    )
  })

  it('「查看本机其他会话」：存 project / all，关闭时不存；每个引擎分开，值不对时报错', async () => {
    const host = makeHost()
    await host.setEngineConfig('codex', { peekSessions: 'project' })
    expect(host.engineConfig().codex.peekSessions).toBe('project')
    expect(host.engineConfig().claude.peekSessions).toBe('off')
    await host.setEngineConfig('claude', { peekSessions: 'all' })
    expect(host.engineConfig().claude.peekSessions).toBe('all')
    await host.setEngineConfig('codex', { peekSessions: 'off' })
    expect(host.engineConfig().codex.peekSessions).toBe('off')
    await expect(host.setEngineConfig('claude', { peekSessions: 'some' as 'all' })).rejects.toThrow('查看本机其他会话')
  })

  it('改了引擎级选项，已开始的会话在下一条消息前重启进程并接上原对话', async () => {
    const host = makeHost()
    const s = host.createSession({ projectId: project(host).id })
    await host.send(s.id, '第一条')
    await waitFor(() => turnsDone(s.id) === 1)
    await host.send(s.id, '第二条')
    await waitFor(() => turnsDone(s.id) === 2)
    expect(spawnArgs()).toHaveLength(1)

    await host.setEngineConfig('claude', { autoCompactPct: 80 })
    await host.send(s.id, '第三条')
    await waitFor(() => turnsDone(s.id) === 3)
    expect(spawnArgs()).toHaveLength(2)
    expect(spawnArgs().at(-1)).toContain('--resume')
    expect(envLog().autoCompact).toBe('80')

    // 只改新会话默认值、压缩模型不用重启
    await host.setEngineConfig('claude', { defaults: { effort: 'low' }, compactModel: 'claude-haiku-4-5' })
    await host.send(s.id, '第四条')
    await waitFor(() => turnsDone(s.id) === 4)
    expect(spawnArgs()).toHaveLength(2)
  })

  it('默认引擎不能隐藏；不支持的引擎不能设为默认；改了会广播', async () => {
    const host = makeHost()
    await expect(host.setEngineConfig('claude', { hidden: true })).rejects.toThrow('默认引擎不能隐藏')
    expect(() => host.setDefaultEngine('codex')).toThrow('这个引擎暂不支持')
    await host.setEngineConfig('claude', { askQuestions: false })
    expect(events.some(e => e.kind === 'engine_config' && e.config.claude.askQuestions === false)).toBe(true)
  })

  it('输出风格列表从 Claude Code 的初始化握手里读（不发消息）', async () => {
    const host = makeHost()
    const catalog = await host.engineCatalog('claude')
    expect(catalog).toMatchObject({
      outputStyles: ['default', 'Explanatory', 'Learning'],
      currentOutputStyle: 'default',
    })
    expect(catalog.models?.map(m => m.id)).toEqual(['opus', 'haiku'])
    expect(await host.engineCatalog('codex')).toEqual({ outputStyles: [], currentOutputStyle: null })
  })
})
