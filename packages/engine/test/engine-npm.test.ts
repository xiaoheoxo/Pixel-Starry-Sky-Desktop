// 用 npm 装引擎（docs/ui/engine-update.md §7）：PATH 末尾补私有 Node.js、先用户的源后国内镜像、
// 没装 Node.js 时让桌面端装私有的、Claude Code 官方安装器装不上时改用 npm
import { readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src'
import { installCodexWithNpm } from '../src/codex/update'
import { NPM_MIRROR, npmForInstall, npmInstallGlobal, withPath, type NodeRuntime, type NpmTool } from '../src/npm'
import { makeTmp, removeTmp } from './helpers/tmp'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(removeTmp))
const tmp = (): string => {
  const d = makeTmp('engine-npm')
  roots.push(d)
  return d
}

/** 假的 npm-cli.js：把参数记进 log；FAIL_DEFAULT=1 时没带 --registry 的那次失败 */
function fakeNpm(dir: string, failDefault = false): { tool: NpmTool; calls: () => string[][] } {
  const log = join(dir, 'npm-calls.jsonl')
  const cli = join(dir, 'npm-cli.js')
  writeFileSync(log, '')
  writeFileSync(
    cli,
    `const fs = require('fs'); const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
console.log('added 1 package');
process.exit(${failDefault ? "args.includes('--registry') ? 0 : 1" : '0'});`,
  )
  return {
    tool: { node: process.execPath, cli, prefix: join(dir, 'npm-global') },
    calls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l) as string[]),
  }
}

const fakeRuntime = (tool: NpmTool, dirs: string[] = []) => {
  let ensured = 0
  const runtime: NodeRuntime = {
    paths: () => dirs,
    ensure: async onLine => {
      ensured++
      onLine('正在下载 Node.js v24.9.0（官方源）')
      return tool
    },
  }
  return { runtime, ensured: () => ensured }
}

describe('PATH 末尾补目录', () => {
  it('补在最后、不重复、沿用原来的键名', () => {
    const env = withPath({ Path: ['/a', '/b'].join(delimiter) }, ['/c', '/a'])
    expect(env.Path).toBe(['/a', '/b', '/c'].join(delimiter))
    expect(env.PATH).toBeUndefined()
    const same = { PATH: '/a' }
    expect(withPath(same, [])).toBe(same)
  })
})

describe('npm install -g', () => {
  it('第一次按用户自己的源装，失败换国内镜像再试', async () => {
    const npm = fakeNpm(tmp(), true)
    const lines: string[] = []
    const r = await npmInstallGlobal(npm.tool, '@openai/codex', {}, l => lines.push(l), 30_000)
    expect(r.ok).toBe(true)
    const [first, second] = npm.calls()
    expect(first).toEqual([
      'install',
      '-g',
      '--prefix',
      npm.tool.prefix,
      '@openai/codex@latest',
      '--no-fund',
      '--no-audit',
    ])
    expect(second).toContain('--registry')
    expect(second[second.indexOf('--registry') + 1]).toBe(NPM_MIRROR)
    expect(lines.some(l => l.includes('国内镜像'))).toBe(true)
  })
  it('第一次就装好：不换镜像', async () => {
    const npm = fakeNpm(tmp())
    expect((await npmInstallGlobal(npm.tool, 'x', {}, () => undefined, 30_000)).ok).toBe(true)
    expect(npm.calls()).toHaveLength(1)
  })
})

describe('装新引擎用哪份 npm', () => {
  it('PATH 上没有 node：让桌面端装私有的', async () => {
    const npm = fakeNpm(tmp())
    const { runtime, ensured } = fakeRuntime(npm.tool)
    expect(await npmForInstall({ PATH: tmp() }, runtime, () => undefined)).toEqual(npm.tool)
    expect(ensured()).toBe(1)
    expect(await npmForInstall({ PATH: tmp() }, undefined, () => undefined)).toBeNull()
  })
  it('PATH 上只有私有的那份（补在末尾的）：照样用私有的、装到私有目录', async () => {
    const npm = fakeNpm(tmp())
    // 用正在跑测试的 node 当作「PATH 上找到的 node」，并说它在私有目录里
    const nodeDir = join(process.execPath, '..')
    const { runtime, ensured } = fakeRuntime(npm.tool, [nodeDir])
    const found = await npmForInstall({ PATH: nodeDir }, runtime, () => undefined)
    // 这台机器的 node 旁边没有 npm-cli.js 时 globalNpm 本来就是 null，结论一样
    expect(found).toEqual(npm.tool)
    expect(ensured()).toBe(1)
  })
})

describe('一键安装', () => {
  it('Codex：没有 Node.js 时先装私有的，再装到私有目录', async () => {
    const npm = fakeNpm(tmp())
    const { runtime, ensured } = fakeRuntime(npm.tool)
    const lines: string[] = []
    const r = await installCodexWithNpm({ PATH: tmp() }, l => lines.push(l), runtime)
    expect(r.ok).toBe(true)
    expect(ensured()).toBe(1)
    expect(npm.calls()[0]).toEqual(expect.arrayContaining(['--prefix', npm.tool.prefix, '@openai/codex@latest']))
    expect(lines[0]).toContain('下载 Node.js')
    await expect(installCodexWithNpm({ PATH: tmp() }, () => undefined)).rejects.toThrow('先安装 Node.js')
  })

  it('Claude Code：官方安装器装不上时改用 npm，两次输出都留着', async () => {
    const dir = tmp()
    const windows = process.platform === 'win32'
    const installer = join(dir, windows ? 'install.ps1' : 'install.sh')
    writeFileSync(
      installer,
      windows ? "Write-Output 'cannot reach claude.ai'; exit 3" : "echo 'cannot reach claude.ai'; exit 3",
    )
    const npm = fakeNpm(dir)
    const { runtime, ensured } = fakeRuntime(npm.tool)
    const adapter = new ClaudeAdapter({
      env: {
        PATH: tmp(),
        SystemRoot: process.env.SystemRoot,
        PIXELSKY_CLAUDE_INSTALLER: installer,
        ...(windows ? {} : { HOME: dir }),
      },
      nodeRuntime: runtime,
    })
    const lines: string[] = []
    const r = await adapter.install(l => lines.push(l))
    expect(r.ok).toBe(true)
    expect(ensured()).toBe(1)
    expect(lines).toContain('官方安装器没装成，改用 npm 安装 Claude Code')
    expect(npm.calls()[0]).toEqual(expect.arrayContaining(['@anthropic-ai/claude-code@latest']))
  })
})
