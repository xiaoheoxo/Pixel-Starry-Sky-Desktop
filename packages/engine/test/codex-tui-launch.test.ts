// Codex 终端（TUI）模式的启动参数（docs/ui/tui-toggle.md §5.2）：codex resume <线程> + 和界面进程一样的 -c，
// 权限 / 模型 / 推理强度按对话设置给；还没有线程的新对话不能切（Codex 不能预先指定线程 id）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionRecord } from '@pixelsky/protocol'
import { CodexAdapter } from '../src/codex'
import { EngineHost } from '../src/host'

const FAKE = fileURLToPath(new URL('./fakes/fake-codex.mjs', import.meta.url))

let root = ''
let host: EngineHost | null = null
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pixelsky-codex-tui-'))
})
afterEach(async () => {
  await host?.shutdown()
  host = null
  rmSync(root, { recursive: true, force: true })
})

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: 'sess-1',
  projectId: 'project',
  cwd: root,
  engine: 'codex',
  engineSessionId: 'thread-1',
  title: 'test',
  model: 'gpt-x',
  effort: 'high',
  permissionMode: 'full',
  ultracode: false,
  fast: false,
  thinkingSummaries: true,
  createdAt: 0,
  updatedAt: 0,
  lastOutcome: null,
  ...over,
})

const adapter = () =>
  new CodexAdapter({
    launcher: { command: process.execPath, args: [FAKE] },
    env: { ...process.env },
    launchOptions: () => ({ askQuestions: true, args: ['-c', 'user_key=1'] }),
    sessionEnv: () => ({ PIXELSKY_CODEX_BASE_URL: 'http://127.0.0.1:9/v1', PIXELSKY_CODEX_TOKEN: 't' }),
  })

describe('CodexAdapter.tuiLaunch', () => {
  it('codex resume 线程，用户参数在像素星空的 -c 前面，权限 / 模型 / 推理强度 / 附加文件夹照对话设置', async () => {
    const launch = await adapter().tuiLaunch(record({ extraDirs: [join(root, 'more')] }))
    const args = launch.args
    expect(launch.command).toBe(process.execPath)
    expect(launch.engineSessionId).toBe('thread-1')
    expect(args.slice(0, 3)).toEqual([FAKE, 'resume', 'thread-1'])
    expect(args.slice(3, 5)).toEqual(['-c', 'user_key=1'])
    expect(args).toEqual(expect.arrayContaining(['-C', root, '-a', 'never', '-s', 'danger-full-access', '-m', 'gpt-x']))
    expect(args).toEqual(
      expect.arrayContaining(['-c', 'model_reasoning_effort="high"', '--add-dir', join(root, 'more')]),
    )
    // 不经网关：不带网关的 provider
    expect(args.join(' ')).not.toContain('model_provider=')
  })

  it('询问档是 on-request + workspace-write（命令行不认 untrusted）；计划档只读；没设模型和推理强度时不带', async () => {
    const ask = (await adapter().tuiLaunch(record({ permissionMode: 'ask', model: null, effort: null }))).args
    expect(ask).toEqual(expect.arrayContaining(['-a', 'on-request', '-s', 'workspace-write']))
    expect(ask).not.toContain('-m')
    expect(ask.join(' ')).not.toContain('model_reasoning_effort')
    const plan = (await adapter().tuiLaunch(record({ permissionMode: 'plan' }))).args
    expect(plan).toEqual(expect.arrayContaining(['-a', 'on-request', '-s', 'read-only']))
  })

  it('平台会话经本机网关：带网关 provider 和令牌环境变量，和界面进程一样', async () => {
    const launch = await adapter().tuiLaunch(record({ platform: { account: 'a@x.com' } as SessionRecord['platform'] }))
    expect(launch.args).toEqual(expect.arrayContaining(['-c', 'model_provider="pixelsky"']))
    expect(launch.env.PIXELSKY_CODEX_TOKEN).toBe('t')
  })

  it('还没有线程：拒绝；宿主把没聊过的 Codex 新对话标成 fresh', async () => {
    await expect(adapter().tuiLaunch(record({ engineSessionId: null }))).rejects.toThrow()
    host = new EngineHost({ dataDir: join(root, 'engine'), adapters: { codex: adapter() }, emit: () => {} })
    const session = host.createSession({ projectId: host.addProject(root).id, engine: 'codex', permissionMode: 'ask' })
    expect(host.tuiBlock(session.id)).toBe('fresh')
  })
})
