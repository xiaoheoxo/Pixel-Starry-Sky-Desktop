import { describe, expect, it, vi } from 'vitest'
import { resolve, join } from 'node:path'
import { TerminalManager, commandEnvironment } from './manager'

describe('TerminalManager.stopUnder', () => {
  it('stops only running terminals whose cwd is the path or inside it', async () => {
    const manager = new TerminalManager(
      resolve('scratch-none'),
      () => ({ projectId: 'p', projectName: 'p', cwd: '.' }),
      () => {},
    )
    const base = resolve('copy-root')
    const make = (cwd: string) => ({ record: { cwd }, closing: false, timer: undefined, paused: false })
    const kills: string[] = []
    const stop = vi.fn(async (run: { record: { cwd: string } }) => {
      kills.push(run.record.cwd)
    })
    const internals = manager as unknown as { running: Map<string, unknown>; stop: typeof stop }
    internals.stop = stop
    internals.running.set('a', make(base))
    internals.running.set('b', make(join(base, 'sub')))
    internals.running.set('c', make(base + '-other'))
    internals.running.set('d', make(resolve('elsewhere')))
    await manager.stopUnder(process.platform === 'win32' ? base.toUpperCase() : base)
    expect(kills.sort()).toEqual([base, join(base, 'sub')].sort())
  })
})

describe('TerminalManager.create', () => {
  it('保存记录期间窗口关了（shutdown(owner) 已执行）：不再启动进程', async () => {
    const manager = new TerminalManager(
      resolve('scratch-none'),
      () => ({ projectId: 'p', projectName: 'p', cwd: process.cwd() }),
      () => {},
    )
    let release!: () => void
    const saving = new Promise<void>(r => {
      release = r
    })
    const internals = manager as unknown as {
      settle: () => Promise<void>
      save: () => Promise<void>
      start: (owner: number, record: unknown) => unknown
      profiles: Array<{ id: string; label: string; available: boolean }>
    }
    internals.settle = async () => {}
    internals.profiles = [{ id: 'sh', label: 'Shell', available: true }]
    internals.save = vi.fn().mockReturnValueOnce(saving).mockResolvedValue(undefined)
    const start = vi.fn()
    internals.start = start
    const created = manager.create(1, { projectId: 'p' }, 'sh', 'req-1')
    await new Promise(r => setTimeout(r, 0))
    await manager.shutdown(1)
    release()
    await expect(created).resolves.toMatchObject({ status: 'stopped' })
    expect(start).not.toHaveBeenCalled()
  })
})

describe('TerminalManager.spawnCommand', () => {
  it('does not persist session terminals or count toward the 12 limit', () => {
    const manager = new TerminalManager(
      resolve('scratch-tui-none'),
      () => ({ projectId: 'p', projectName: 'p', cwd: process.cwd() }),
      () => {},
    )
    const internals = manager as unknown as {
      startCommand: (...args: unknown[]) => { id: string; sessionId?: string }
      save: () => Promise<void>
      records: Array<{ sessionId?: string }>
    }
    const save = vi.fn()
    internals.save = save
    internals.startCommand = (_owner, record) => ({ ...(record as object), status: 'running' }) as never
    const record = manager.spawnCommand({
      owner: 1,
      cwd: process.cwd(),
      command: 'claude',
      args: ['--resume', 'x'],
      label: 'Claude Code',
      sessionId: 'sess-1',
      projectId: 'p',
      projectName: 'p',
    })
    expect(record.sessionId).toBe('sess-1')
    expect(save).not.toHaveBeenCalled()
    expect(internals.records.filter(r => r.sessionId).length).toBe(1)
    const state = manager.state(1)
    expect(state.terminals.every(t => !t.sessionId)).toBe(true)
  })
})

describe('commandEnvironment', () => {
  it('以引擎给的 env 为底：本进程里的 Claude 子会话标记不带进去，引擎的 PIXELSKY_* 保留', () => {
    const source = { PATH: '/bin', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDECODE: '1' }
    const engine = {
      PATH: '/bin:/extra',
      CLAUDE_CONFIG_DIR: '/acct',
      PIXELSKY_GATEWAY_SETTINGS: '{}',
      NODE_OPTIONS: '--x',
    }
    const env = commandEnvironment(engine, source)
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined()
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.PATH).toBe('/bin:/extra')
    expect(env.CLAUDE_CONFIG_DIR).toBe('/acct')
    expect(env.PIXELSKY_GATEWAY_SETTINGS).toBe('{}')
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.TERM).toBe('xterm-256color')
  })
})

describe('TerminalManager 终端名额（只算在跑的）', () => {
  const setup = (dir = resolve('scratch-limit-none')) => {
    const manager = new TerminalManager(
      dir,
      () => ({ projectId: 'p', projectName: 'p', cwd: process.cwd() }),
      () => {},
    )
    const internals = manager as unknown as {
      settle: () => Promise<void>
      save: () => Promise<void>
      start: (owner: number, record: { id: string }) => unknown
      profiles: Array<{ id: string; label: string; available: boolean }>
      records: Array<{ id: string; projectId: string; cwd: string; sessionId?: string; status: string }>
      running: Map<string, { record: { projectId: string; cwd: string; sessionId?: string } }>
    }
    internals.settle = async () => {}
    internals.profiles = [{ id: 'sh', label: 'Shell', available: true }]
    internals.save = vi.fn().mockResolvedValue(undefined)
    internals.start = (_owner, record) => ({ ...record, status: 'running' })
    return { manager, internals }
  }
  const stored = (i: number, projectId = 'other', cwd = process.cwd()) => ({
    id: 't' + i,
    projectId,
    projectName: projectId,
    cwd,
    profileId: 'sh',
    profileLabel: 'Shell',
    title: 'Shell',
    titleEdited: false,
    status: 'stopped',
    generation: 0,
    createdAt: 0,
  })

  it('别的项目里停着的 12 个标签不占名额', async () => {
    const { manager, internals } = setup()
    for (let i = 0; i < 12; i++) internals.records.push(stored(i))
    await expect(manager.create(1, { projectId: 'p' }, 'sh', 'req-a')).resolves.toMatchObject({ status: 'running' })
  })

  it('在跑的满 12 个才拦住，提示里说有几个在其他项目或副本里', async () => {
    const { manager, internals } = setup()
    for (let i = 0; i < 12; i++) {
      const r = stored(i, i < 5 ? 'p' : 'other', i < 5 ? process.cwd() : resolve('elsewhere'))
      internals.records.push(r)
      internals.running.set(r.id, { record: r })
    }
    await expect(manager.create(1, { projectId: 'p' }, 'sh', 'req-b')).rejects.toThrow(
      '最多同时运行 12 个终端，请先关闭部分标签（其中 7 个在其他项目或副本里）',
    )
  })

  it('并发新建：还在保存、没启动的也算名额', async () => {
    const { manager, internals } = setup()
    for (let i = 0; i < 11; i++) {
      const r = stored(i)
      internals.records.push(r)
      internals.running.set(r.id, { record: r })
    }
    let release!: () => void
    internals.save = vi.fn().mockReturnValueOnce(new Promise<void>(r => (release = r)))
    const first = manager.create(1, { projectId: 'p' }, 'sh', 'req-c')
    await new Promise(r => setTimeout(r, 0))
    await expect(manager.create(1, { projectId: 'p' }, 'sh', 'req-d')).rejects.toThrow('最多同时运行 12 个终端')
    release()
    await expect(first).resolves.toMatchObject({ status: 'running' })
  })

  it('启动时丢掉工作目录已经不在的标签（删掉的副本），并写回存档', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'term-prune-'))
    try {
      mkdirSync(join(dir, 'terminal'), { recursive: true })
      const file = join(dir, 'terminal', 'terminals.json')
      writeFileSync(
        file,
        JSON.stringify({ version: 1, terminals: [stored(1, 'p', dir), stored(2, 'p', join(dir, 'gone-worktree'))] }),
      )
      const manager = new TerminalManager(
        dir,
        () => ({ projectId: 'p', projectName: 'p', cwd: dir }),
        () => {},
      )
      ;(manager as unknown as { detect: () => Promise<void> }).detect = async () => {}
      await manager.init()
      expect(manager.state(1).terminals.map(t => t.id)).toEqual(['t1'])
      await vi.waitFor(() => {
        const saved = JSON.parse(readFileSync(file, 'utf8')) as { terminals: { id: string }[] }
        expect(saved.terminals.map(t => t.id)).toEqual(['t1'])
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('goneDirectory（启动清理只删确定不在的）', () => {
  it('网络路径、WSL 不查，盘符整个不在（外接盘没插）也留着；本机确实删掉的才算', async () => {
    const { goneDirectory } = await import('./manager')
    expect(await goneDirectory(String.raw`\\wsl.localhost\Ubuntu\home\me\proj`)).toBe(false)
    expect(await goneDirectory('//server/share/proj')).toBe(false)
    expect(await goneDirectory(process.cwd())).toBe(false)
    expect(await goneDirectory(join(process.cwd(), 'definitely-not-here-' + Date.now()))).toBe(true)
    if (process.platform === 'win32') expect(await goneDirectory(String.raw`Q:\unplugged\proj`)).toBe(false)
  })
})

describe('TerminalManager 重新启动停着的标签也占名额', () => {
  it('在跑的满 12 个时，点「重启」停着的标签会被拦住', async () => {
    const manager = new TerminalManager(
      resolve('scratch-restart-none'),
      () => ({ projectId: 'p', projectName: 'p', cwd: process.cwd() }),
      () => {},
    )
    const internals = manager as unknown as {
      settle: () => Promise<void>
      start: () => unknown
      records: Array<Record<string, unknown>>
      owners: Map<string, number>
      running: Map<string, { record: { projectId: string; cwd: string } }>
    }
    internals.settle = async () => {}
    const start = vi.fn()
    internals.start = start
    for (let i = 0; i < 12; i++) internals.running.set('r' + i, { record: { projectId: 'p', cwd: process.cwd() } })
    internals.records.push({ id: 'idle', projectId: 'p', cwd: process.cwd(), profileId: 'sh', status: 'stopped' })
    internals.owners.set('idle', 1)
    await expect(manager.change(1, 'idle', true)).rejects.toThrow('最多同时运行 12 个终端')
    expect(start).not.toHaveBeenCalled()
  })
})

describe('TerminalManager 重启时不把自己算进名额', () => {
  it('在跑的 12 个里有它自己（进程已经没了、还留在 running 里）：照样能重启', async () => {
    const manager = new TerminalManager(
      resolve('scratch-restart-self'),
      () => ({ projectId: 'p', projectName: 'p', cwd: process.cwd() }),
      () => {},
    )
    const internals = manager as unknown as {
      settle: () => Promise<void>
      start: () => unknown
      stop: () => Promise<void>
      records: Array<Record<string, unknown>>
      owners: Map<string, number>
      running: Map<string, { record: { id: string; projectId: string; cwd: string }; owner: number }>
    }
    internals.settle = async () => {}
    internals.stop = async () => {}
    const start = vi.fn(() => ({ status: 'running' }))
    internals.start = start
    for (let i = 0; i < 11; i++)
      internals.running.set('r' + i, { record: { id: 'r' + i, projectId: 'p', cwd: process.cwd() }, owner: 1 })
    const self = { id: 'self', projectId: 'p', cwd: process.cwd(), profileId: 'sh', status: 'running' }
    internals.records.push(self)
    internals.owners.set('self', 1)
    internals.running.set('self', { record: self, owner: 1 })
    await manager.change(1, 'self', true, true)
    expect(start).toHaveBeenCalled()
  })
})
