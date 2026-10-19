// 终端管理器里的提示符标记：从 pty 输出剥掉、变成 prompt 事件；没注入的 shell 输出原样
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TerminalEvent, TerminalProfile } from '../../shared/types/terminal'

interface FakePty {
  command: string
  args: string[]
  env: Record<string, string>
  data(chunk: string): void
}
const spawned: FakePty[] = []
vi.mock('node-pty', () => ({
  spawn: (command: string, args: string[], options: { env: Record<string, string> }) => {
    let onData: (data: string) => void = () => {}
    spawned.push({ command, args, env: options.env, data: chunk => onData(chunk) })
    return {
      onData: (fn: (data: string) => void) => {
        onData = fn
        return { dispose: () => {} }
      },
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      pause: () => {},
      resume: () => {},
      kill: () => {},
    }
  },
}))

const { TerminalManager } = await import('./manager')

const ESC = '\u001b'
const BEL = '\u0007'
const prompt = `${ESC}]633;A${BEL}`
const end = (code: number): string => `${ESC}]633;D;${code}${BEL}`
const profile = (id: string, command: string, args: string[], custom = false): TerminalProfile => ({
  id,
  label: id,
  command,
  args,
  available: true,
  custom,
})

describe('TerminalManager 的提示符标记', () => {
  let dir = ''
  let events: TerminalEvent[] = []
  beforeEach(async () => {
    spawned.length = 0
    events = []
    dir = await mkdtemp(join(tmpdir(), 'pixelsky-term-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function open(p: TerminalProfile): Promise<FakePty> {
    const manager = new TerminalManager(
      dir,
      () => ({ projectId: 'p', projectName: 'p', cwd: dir }),
      (_owner, event) => events.push(event),
    )
    await manager.init()
    await manager.profilesReady() // 等后台的 Shell 检测完，免得它之后把下面换上的列表覆盖掉
    ;(manager as unknown as { profiles: TerminalProfile[] }).profiles = [p]
    await manager.create(1, { projectId: 'p' }, p.id, 'req-' + p.id)
    return spawned[spawned.length - 1]
  }
  const text = (): string => events.flatMap(e => (e.type === 'data' ? [e.data] : [])).join('')
  const prompts = (): Extract<TerminalEvent, { type: 'prompt' }>[] =>
    events.filter((e): e is Extract<TerminalEvent, { type: 'prompt' }> => e.type === 'prompt')
  const flushed = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 40))

  it('PowerShell：注入启动参数；标记从数据里剥掉，变成带退出码的 prompt 事件', async () => {
    const pty = await open(profile('pwsh', 'pwsh.exe', ['-NoLogo']))
    expect(pty.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-EncodedCommand'])
    // 第一个提示符：没跑过命令
    pty.data(`banner${prompt}PS> `)
    // 命令结束 + 提示符，标记被切在两个数据块之间
    const second = `output${end(2)}${prompt}PS> `
    pty.data(second.slice(0, 9))
    pty.data(second.slice(9))
    await flushed()
    expect(text()).toBe('bannerPS> outputPS> ')
    expect(text()).not.toContain('633')
    expect(prompts().map(({ type: _t, terminalId: _i, generation: _g, ...rest }) => rest)).toEqual([
      { ran: false, exitCode: null },
      { ran: true, exitCode: 2 },
    ])
  })

  it('cmd：只报提示符开始（ran 为 null），PROMPT 里带标记', async () => {
    const pty = await open(profile('cmd', 'cmd.exe', ['/d']))
    expect(pty.env.PROMPT).toContain('633;A')
    pty.data(`C:\\>${prompt}`)
    await flushed()
    expect(prompts()).toHaveLength(1)
    expect(prompts()[0]).toMatchObject({ ran: null, exitCode: null })
  })

  it('没注入的 shell（自定义 / fish）：输出原样，不解析标记，没有 prompt 事件', async () => {
    const pty = await open(profile('custom-1', 'pwsh.exe', ['-NoProfile'], true))
    expect(pty.args).toEqual(['-NoProfile'])
    const raw = `x${end(1)}${prompt}y`
    pty.data(raw)
    await flushed()
    expect(text()).toBe(raw)
    expect(prompts()).toEqual([])
  })
})
