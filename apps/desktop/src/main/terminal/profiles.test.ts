import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const disk = vi.hoisted(() => ({
  files: new Set<string>(),
  installed: '[]',
  calls: [] as string[][],
  stats: [] as string[],
}))
vi.mock('node:fs/promises', () => ({
  stat: async (path: string) => {
    disk.stats.push(path)
    if (!disk.files.has(path)) throw Object.assign(new Error('Cannot stat'), { code: 'EACCES' })
    return { isFile: () => true }
  },
  access: async () => {},
}))
vi.mock('node:child_process', () => ({
  execFile: (
    command: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    disk.calls.push([command, ...args])
    setTimeout(() => callback(null, disk.installed), 0)
  },
}))
import { detectBuiltin, detectProfiles, executable, powerShell7, probeCustom } from './profiles'

beforeEach(() => {
  disk.files.clear()
  disk.installed = '[]'
  disk.calls = []
  disk.stats = []
  vi.stubEnv('SystemRoot', 'C:\\Windows')
  vi.stubEnv('ProgramFiles', 'C:\\Program Files')
  vi.stubEnv('ProgramW6432', 'C:\\Program Files')
  vi.stubEnv('ProgramFiles(x86)', 'C:\\Program Files (x86)')
  vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\tester\\AppData\\Local')
  vi.stubEnv('PATH', '')
  vi.stubEnv('PATHEXT', '.COM;.EXE;.BAT;.CMD')
})
const nativeShell = join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
afterEach(() => vi.unstubAllEnvs())

describe('PowerShell installation discovery', () => {
  it('skips an inaccessible WindowsApps alias ahead of a usable executable', async () => {
    const real = join('D:\\tools', 'pwsh.exe')
    vi.stubEnv('PATH', ['C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps', 'D:\\tools'].join(';'))
    disk.files.add(real)
    expect(await executable('pwsh.exe')).toBe(real)
    expect(await powerShell7()).toBe(real)
    // 不起任何进程：靠 PATH 逐目录 stat
    expect(disk.calls).toEqual([])
  })
  it('appends PATHEXT when the name has no extension', async () => {
    const real = join('D:\\tools', 'nu.exe')
    vi.stubEnv('PATH', 'D:\\tools')
    vi.stubEnv('PATHEXT', '.com;.exe')
    disk.files.add(real)
    expect(await executable('nu')).toBe(real)
  })
  it('finds the standard installation when Explorer inherited an old PATH', async () => {
    const real = join('C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
    disk.files.add(real)
    expect(await powerShell7()).toBe(real)
    expect(disk.calls).toEqual([])
  })
  it('resolves Store or registered custom locations, including Unicode, to the real exe', async () => {
    const real = join('D:\\应用程序', 'PowerShell', 'pwsh.exe')
    disk.files.add(nativeShell)
    disk.files.add(real)
    disk.installed = JSON.stringify([real])
    expect((await detectProfiles()).find(p => p.id === 'pwsh')).toMatchObject({ available: true, command: real })
    const probe = disk.calls.find(call => call[0] === nativeShell)!
    expect(probe).toContain('-NoProfile')
    expect(probe).toContain('-NonInteractive')
  })
  it('does not enable a missing installation just because metadata lists it', async () => {
    disk.files.add(nativeShell)
    disk.installed = JSON.stringify(['C:\\deleted\\pwsh.exe', 'relative.exe'])
    expect((await detectProfiles()).find(p => p.id === 'pwsh')?.available).toBe(false)
  })
  it('keeps Windows PowerShell available when PowerShell 7 metadata cannot be read', async () => {
    disk.files.add(nativeShell)
    disk.installed = 'invalid output'
    const profiles = await detectProfiles()
    expect(profiles.find(p => p.id === 'pwsh')?.available).toBe(false)
    expect(profiles.find(p => p.id === 'powershell')).toMatchObject({ available: true, command: nativeShell })
  })
  it('does not start powershell.exe when pwsh is found on disk', async () => {
    disk.files.add(nativeShell)
    disk.files.add(join('C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'))
    await detectBuiltin()
    expect(disk.calls).toEqual([])
  })
  it('probes custom profiles without re-detecting the built-in ones', async () => {
    const tool = join('D:\\tools', 'nu.exe')
    disk.files.add(tool)
    const [found, missing] = await probeCustom([
      { id: 'custom-a', label: 'nu', command: tool, args: [], available: false, custom: true },
      { id: 'custom-b', label: 'gone', command: 'D:\\gone.exe', args: [], available: true, custom: true },
    ])
    expect(found).toMatchObject({ available: true, command: tool })
    expect(missing).toMatchObject({ available: false, command: 'D:\\gone.exe' })
    expect(disk.calls).toEqual([])
  })
})
