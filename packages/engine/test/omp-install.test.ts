import { copyFileSync, linkSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IS_WINDOWS } from '../src/exec'
import { OmpAdapter } from '../src/omp'
import { discoverOmp, ompInstaller } from '../src/omp/discover'
import { makeTmp, removeTmp } from './helpers/tmp'

// oh-my-pi 的一键安装和更新（docs/omp-engine.md §14）

let root: string
let omp: string
let fake: string
beforeAll(() => {
  root = makeTmp('omp-install')
  // 更新只认文件名叫 omp 的：把 node 放成 omp，参数里带假脚本
  const dir = join(root, 'bin')
  mkdirSync(dir)
  omp = join(dir, IS_WINDOWS ? 'omp.exe' : 'omp')
  try {
    linkSync(process.execPath, omp)
  } catch {
    copyFileSync(process.execPath, omp)
  }
  fake = join(root, 'fake.mjs')
  writeFileSync(
    fake,
    `
console.log('args=' + process.argv.slice(2).join(' '))
console.log('path=' + process.env.PATH)
if (process.env.FAKE_SAY) console.log(process.env.FAKE_SAY)
process.exit(Number(process.env.FAKE_EXIT ?? 0))
`,
  )
})
afterAll(() => removeTmp(root))

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  SystemRoot: process.env.SystemRoot,
  ...extra,
})
const adapter = (extra: Record<string, string> = {}, command = omp): OmpAdapter =>
  new OmpAdapter({ env: { ...process.env, ...extra }, launcher: { command, args: [fake] } })

describe('oh-my-pi 安装', () => {
  it('没装：有官方安装器才能一键安装，用户替换了命令的不给', async () => {
    const home = join(root, 'empty')
    const tools = join(root, 'tools')
    mkdirSync(tools)
    for (const f of ['powershell.exe', 'sh', 'curl']) writeFileSync(join(tools, f), '', { mode: 0o755 })
    const e = env({ PATH: tools, USERPROFILE: home, HOME: home, LOCALAPPDATA: home })
    expect(ompInstaller(e)?.command).toBe(join(tools, IS_WINDOWS ? 'powershell.exe' : 'sh'))
    expect(ompInstaller(e)?.args.at(-1)).toContain('https://omp.sh/install')
    const { info } = await discoverOmp(join(root, 'nope', 'omp.exe'), e)
    expect(info).toMatchObject({ status: 'missing' })
    expect(info.installable).toBeFalsy()
    // macOS / Linux 还会找系统里固定的位置，本机真装了 omp 时不算没装
    const stock = (await discoverOmp(null, e)).info
    if (stock.status === 'missing') expect(stock.installable).toBe(true)
  })
  it('没有安装器（找不到 PowerShell / curl）：不给安装', () => {
    expect(ompInstaller({ PATH: '', SystemRoot: join(root, 'none') })).toBeNull()
  })
})

describe('oh-my-pi 更新', () => {
  it('跑 omp update，这份 omp 的目录放在 PATH 最前', async () => {
    const lines: string[] = []
    const r = await adapter().update(l => lines.push(l))
    expect(r.ok).toBe(true)
    expect(lines).toContain('args=update')
    expect(
      lines
        .find(l => l.startsWith('path='))!
        .slice(5)
        .split(delimiter)[0],
    ).toBe(join(root, 'bin'))
  })
  it('失败、Nix 和别的软件管着的：都算没成功，带上原话', async () => {
    expect((await adapter({ FAKE_EXIT: '1', FAKE_SAY: 'Update failed' }).update()).ok).toBe(false)
    for (const say of [
      'This installation is managed by Nix and cannot update itself.',
      '/x/omp is installed and kept up to date by Foo; update it from Foo.',
    ]) {
      const r = await adapter({ FAKE_SAY: say }).update()
      expect(r.ok).toBe(false)
      expect(r.output).toContain(say)
    }
  })
  it('自定义命令不叫 omp：不跑，免得更新了 PATH 上的另一份', async () => {
    await expect(adapter({}, process.execPath).update()).rejects.toThrow('自定义的命令不叫 omp')
  })
})
