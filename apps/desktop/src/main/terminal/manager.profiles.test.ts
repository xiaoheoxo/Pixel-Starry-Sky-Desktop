// 终端管理器的 Shell 列表：启动不等检测、先用 terminals.json 里的缓存、检测完通知并重算默认值
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TerminalProfile } from '../../shared/types/terminal'

vi.mock('node-pty', () => ({ spawn: () => ({}) }))
const detect = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
  result: [] as unknown[],
  calls: 0,
}))
vi.mock('./profiles', async importOriginal => ({
  ...(await importOriginal<typeof import('./profiles')>()),
  detectBuiltin: async () => {
    detect.calls++
    await detect.gate
    return detect.result
  },
  probeCustom: async (list: TerminalProfile[]) => list.map(p => ({ ...p, available: p.command === 'ok.exe' })),
}))

const { TerminalManager } = await import('./manager')

const shell = (id: string, available: boolean): TerminalProfile => ({
  id,
  label: id,
  command: id + '.exe',
  args: ['-NoLogo'],
  available,
})

describe('TerminalManager 的 Shell 检测', () => {
  let dir = ''
  let release: () => void = () => {}
  let current: InstanceType<typeof TerminalManager> | null = null
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pixelsky-term-'))
    detect.calls = 0
    detect.result = [shell('pwsh', true), shell('powershell', true), shell('cmd', true)]
    detect.gate = new Promise<void>(resolve => {
      release = resolve
    })
  })
  afterEach(async () => {
    release()
    // 后台检测完会写盘：等写完再删目录
    await current?.profilesReady()
    await current?.shutdown()
    current = null
    await rm(dir, { recursive: true, force: true })
  })
  const make = (): InstanceType<typeof TerminalManager> =>
    (current = new TerminalManager(
      dir,
      () => ({ projectId: 'p', projectName: 'p', cwd: dir }),
      () => {},
    ))
  const writeState = async (data: unknown): Promise<void> => {
    await mkdir(join(dir, 'terminal'), { recursive: true })
    await writeFile(join(dir, 'terminal', 'terminals.json'), JSON.stringify(data), 'utf8')
  }
  const readState = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(join(dir, 'terminal', 'terminals.json'), 'utf8'))

  it('init 不等检测：检测没完成 init 也返回，没有缓存时列表为空', async () => {
    const manager = make()
    await manager.init()
    expect(detect.calls).toBe(1)
    expect(manager.state(1).profiles).toEqual([])
    release()
    await manager.profilesReady()
    expect(manager.state(1).profiles.map(p => p.id)).toEqual(['pwsh', 'powershell', 'cmd'])
    expect(manager.state(1).defaultProfileId).toBe('pwsh')
  })

  it('检测完通知一次，并把结果缓存进 terminals.json', async () => {
    const manager = make()
    const changed = vi.fn()
    manager.onProfilesChanged(changed)
    await manager.init()
    release()
    await manager.profilesReady()
    expect(changed).toHaveBeenCalledTimes(1)
    await manager.shutdown() // 等排队的写盘完成
    const saved = (await readState()) as { profileCache: TerminalProfile[]; defaultProfileId?: string }
    expect(saved.profileCache.map(p => p.id)).toEqual(['pwsh', 'powershell', 'cmd'])
    // 没存过用户的选择，不把算出来的默认值写进去
    expect(saved.defaultProfileId).toBeUndefined()
  })

  it('有缓存就先用缓存，检测结果一样时不通知', async () => {
    await writeState({ version: 1, profileCache: detect.result, terminals: [] })
    const manager = make()
    const changed = vi.fn()
    manager.onProfilesChanged(changed)
    await manager.init()
    expect(manager.state(1).profiles.map(p => p.id)).toEqual(['pwsh', 'powershell', 'cmd'])
    expect(manager.state(1).defaultProfileId).toBe('pwsh')
    release()
    await manager.profilesReady()
    expect(changed).not.toHaveBeenCalled()
  })

  it('检测发现缓存过期（pwsh 被卸载）：更新列表、重算默认值并通知', async () => {
    await writeState({ version: 1, profileCache: detect.result, terminals: [] })
    detect.result = [shell('pwsh', false), shell('powershell', true), shell('cmd', true)]
    const manager = make()
    const changed = vi.fn()
    manager.onProfilesChanged(changed)
    await manager.init()
    expect(manager.state(1).defaultProfileId).toBe('pwsh')
    release()
    await manager.profilesReady()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(manager.state(1).profiles[0].available).toBe(false)
    expect(manager.state(1).defaultProfileId).toBe('powershell')
  })

  it('terminals.json 里用户存的默认 Shell 优先，检测前后都不被占位结果覆盖', async () => {
    await writeState({ version: 1, defaultProfileId: 'cmd', terminals: [] })
    const manager = make()
    await manager.init()
    release()
    await manager.profilesReady()
    expect(manager.state(1).defaultProfileId).toBe('cmd')
    // 保存别的东西（比如改名）时不丢掉用户的选择
    await manager.shutdown()
    expect((await readState()).defaultProfileId).toBe('cmd')
  })

  it('存的默认 Shell 已不在列表里：回到第一个可用的', async () => {
    await writeState({ version: 1, defaultProfileId: 'git-bash', terminals: [] })
    const manager = make()
    await manager.init()
    release()
    await manager.profilesReady()
    expect(manager.state(1).defaultProfileId).toBe('pwsh')
  })

  it('自定义 Shell 沿用缓存里的可用性，检测后重新探测', async () => {
    await writeState({
      version: 1,
      profileCache: [...detect.result, { id: 'custom-1', label: 'x', command: 'gone.exe', args: [], available: true }],
      profiles: [{ id: 'custom-1', label: 'x', command: 'ok.exe', args: [] }],
      terminals: [],
    })
    const manager = make()
    await manager.init()
    expect(manager.state(1).profiles.find(p => p.id === 'custom-1')).toMatchObject({ available: true, custom: true })
    release()
    await manager.profilesReady()
    expect(manager.state(1).profiles.find(p => p.id === 'custom-1')).toMatchObject({ available: true, custom: true })
  })

  it('refresh 重新检测一次，已经在检测就并进去', async () => {
    const manager = make()
    await manager.init()
    const again = manager.refresh()
    release()
    await again
    expect(detect.calls).toBe(1)
    await manager.refresh()
    expect(detect.calls).toBe(2)
  })

  it('创建终端时请求的 Shell 还没检测出来：等检测完再判断', async () => {
    const manager = make()
    await manager.init()
    const created = manager.create(1, { projectId: 'p' }, 'cmd', 'req-1')
    const outcome = created.then(
      () => 'created',
      (e: Error) => e.message,
    )
    release()
    // node-pty 被换成空壳：能走到启动这一步就说明没有在「所选 Shell 不可用」处被拒
    expect(await outcome).not.toBe('所选 Shell 不可用')
  })
})
