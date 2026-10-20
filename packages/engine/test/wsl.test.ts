import { mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { codexVersionStatus, discoverCodex } from '../src/codex/discover'
import { discoverClaude, findClaude } from '../src/claude/discover'
import { makeTmp, removeTmp } from './helpers/tmp'
import {
  allOnPath,
  hasPeHeader,
  inWsl,
  isWindowsMount,
  keepInWsl,
  skipInWsl,
  windowsOnlyNote,
  type WslDeps,
} from '../src/wsl'

const wsl = { WSL_DISTRO_NAME: 'Ubuntu' }
const deps = (heads: Record<string, number[]> = {}, links: Record<string, string> = {}): WslDeps => ({
  readHead: p => (heads[p] ? Uint8Array.from(heads[p]) : null),
  realpath: p => links[p] ?? p,
})
const MZ = [0x4d, 0x5a, 0x90]
const ELF = [0x7f, 0x45, 0x4c, 0x46]

describe('WSL 里认准 Linux 程序', () => {
  it('只在 Linux 且有 WSL_DISTRO_NAME 时生效', () => {
    expect(inWsl(wsl, 'linux')).toBe(true)
    expect(inWsl({}, 'linux')).toBe(false)
    expect(inWsl(wsl, 'win32')).toBe(false)
    expect(inWsl(wsl, 'darwin')).toBe(false)
  })

  it('认出 /mnt/<盘符>/ 下的路径', () => {
    expect(isWindowsMount('/mnt/c/Users/a/npm/claude')).toBe(true)
    expect(isWindowsMount('/mnt/D')).toBe(true)
    expect(isWindowsMount('/mnt/wsl/x')).toBe(false)
    expect(isWindowsMount('/home/a/mnt/c/x')).toBe(false)
  })

  it('按文件头 MZ 判断 Windows 程序', () => {
    expect(hasPeHeader(Uint8Array.from(MZ))).toBe(true)
    expect(hasPeHeader(Uint8Array.from(ELF))).toBe(false)
    expect(hasPeHeader(Uint8Array.from([0x4d]))).toBe(false)
    expect(hasPeHeader(null)).toBe(false)
  })

  it('跳过 /mnt 下的候选', () => {
    expect(skipInWsl('/mnt/c/x/claude', wsl, 'linux', deps())).toBe(true)
  })

  it('链接解析后在 /mnt 下的也跳过', () => {
    const d = deps({}, { '/usr/local/bin/claude': '/mnt/c/npm/claude.exe' })
    expect(skipInWsl('/usr/local/bin/claude', wsl, 'linux', d)).toBe(true)
  })

  it('跳过 MZ 头的 claude.exe，保留 ELF 头的同名文件', () => {
    const d = deps({ '/home/a/win/bin/claude.exe': MZ, '/home/a/npm/bin/claude.exe': ELF })
    expect(skipInWsl('/home/a/win/bin/claude.exe', wsl, 'linux', d)).toBe(true)
    expect(skipInWsl('/home/a/npm/bin/claude.exe', wsl, 'linux', d)).toBe(false)
  })

  it('不在 WSL 里一律不跳过', () => {
    const d = deps({ '/mnt/c/x/claude.exe': MZ })
    expect(skipInWsl('/mnt/c/x/claude.exe', {}, 'linux', d)).toBe(false)
    expect(skipInWsl('C:/x/claude.exe', wsl, 'win32', d)).toBe(false)
  })

  it('读不到文件头时不跳过', () => {
    expect(skipInWsl('/home/a/claude', wsl, 'linux', deps())).toBe(false)
  })

  it('详情写出找到的 Windows 程序', () => {
    expect(windowsOnlyNote(['/mnt/c/a', '/mnt/c/b'])).toBe('只找到 Windows 程序：/mnt/c/a')
    expect(windowsOnlyNote([])).toBe('')
  })
})

let root: string
beforeEach(() => {
  root = makeTmp('wsl-')
})
afterEach(() => removeTmp(root))

const put = (dir: string, name: string): string => {
  const p = join(root, dir, name)
  mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(p, Buffer.alloc(200 * 1024, 1))
  return p
}
// 目录名带 win 的当 Windows 程序（MZ 头）
const byDir: WslDeps = {
  readHead: p => (/win/.test(p.replace(root, '')) ? Uint8Array.from(MZ) : Uint8Array.from(ELF)),
  realpath: p => p,
}
const allWin: WslDeps = { readHead: () => Uint8Array.from(MZ), realpath: p => p }
const pathOf = (...dirs: string[]) => ({ ...wsl, PATH: dirs.map(d => join(root, d)).join(delimiter) })
const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'

describe('WSL 里的候选顺序', () => {
  it('PATH 上同名文件全部列出，顺序不变', () => {
    const a = put('a', exe)
    const b = put('b', exe)
    expect(allOnPath(exe, pathOf('a', 'b'))).toEqual([a, b])
  })

  it('跳过的路径只记存在的文件，且不重复', () => {
    const win = put('win', exe)
    const skipped: string[] = []
    const opts = { platform: 'linux' as const, deps: allWin }
    expect(keepInWsl(win, wsl, skipped, opts)).toBe(false)
    expect(keepInWsl(win, wsl, skipped, opts)).toBe(false)
    expect(keepInWsl(join(root, 'none', exe), wsl, skipped, opts)).toBe(false)
    expect(skipped).toEqual([win])
  })

  it('Claude：PATH 第一个是 Windows 版、第二个是 Linux 版，选后者', () => {
    put('win', exe)
    const linux = put('lin', exe)
    const skipped: string[] = []
    const found = findClaude(pathOf('win', 'lin'), skipped, { platform: 'linux', deps: byDir })
    expect(found).toEqual({ command: linux, args: [] })
    expect(skipped).toHaveLength(1)
  })

  it('Claude：只有 Windows 版时状态仍是未安装，详情写出路径', async () => {
    const win = put('win', exe)
    const r = await discoverClaude(null, pathOf('win'), { platform: 'linux', deps: allWin })
    expect(r.info.status).toBe('missing')
    expect(r.info.message).toContain(`（只找到 Windows 程序：${win}）`)
  })

  it('Claude：PIXELSKY_CLAUDE_BIN 是用户明确指定的，不跳过', () => {
    const win = put('win', exe)
    const found = findClaude({ ...wsl, PIXELSKY_CLAUDE_BIN: win }, [], { platform: 'linux', deps: allWin })
    expect(found).toEqual({ command: win, args: [] })
  })

  it('Codex：只有 Windows 版时详情写出路径', async () => {
    const win = put('win', process.platform === 'win32' ? 'codex.exe' : 'codex')
    const r = await discoverCodex(null, pathOf('win'), { platform: 'linux', deps: allWin })
    expect(r.info.status).toBe('missing')
    expect(r.info.message).toContain(`（只找到 Windows 程序：${win}）`)
    expect(codexVersionStatus(null).status).toBe('error')
  })
})
