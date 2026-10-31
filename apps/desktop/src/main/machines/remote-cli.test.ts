import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  REMOTE_CLI_KEEP_MS,
  isRemoteCliEntry,
  packRemoteCli,
  remoteCliCheckScript,
  remoteCliInstallScript,
  remoteCliSupported,
  unpackRemoteCli,
} from './remote-cli'
import { createRemoteCliCache } from './remote-cli-source'

const root = mkdtempSync(join(tmpdir(), 'remote-cli-test-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const posix = process.platform !== 'win32'
const itPosix = posix ? it : it.skip

let seq = 0
const fresh = (name: string) => {
  const dir = join(root, name + ++seq)
  mkdirSync(dir, { recursive: true })
  return dir
}
const put = (base: string, rel: string, text: string) => {
  const file = join(base, ...rel.split('/'))
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}

/** 造一份假的 pixel-cli 目录（含宿主平台的 bin/，要被排除）和一份 Linux 工具目录 */
function fixture() {
  const cli = fresh('cli')
  put(cli, 'pixel.mjs', 'console.log(1)')
  put(cli, 'package.json', '{}')
  put(cli, 'dist/themes/dark.json', '{"a":1}')
  put(cli, 'node_modules/quickjs-wasi/quickjs.wasm', 'wasm')
  put(cli, 'bin/rg.exe', 'host binary')
  const tools = fresh('tools')
  put(tools, 'rg', 'rg-linux')
  put(tools, 'fd', 'fd-linux')
  put(tools, 'licenses/rg-LICENSE.txt', 'MIT')
  return { cli, tools }
}

/** 在临时 HOME 里跑远程脚本，和 os.homedir() 对应 */
function run(script: string, home: string, input: Buffer = Buffer.alloc(0)) {
  const result = spawnSync(process.execPath, ['-e', script], {
    input,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    maxBuffer: 64 * 1024 * 1024,
  })
  return { code: result.status, out: result.stdout.toString('utf8'), err: result.stderr.toString('utf8') }
}
const installed = (home: string, hash: string) => join(home, '.local', 'share', 'pixelsky', 'remote', 'cli-' + hash)

/** 手工拼一个包（用来造恶意条目） */
function craft(files: Array<{ path: string; size?: number; mode?: number; body?: string }>) {
  const bodies = files.map(f => Buffer.from(f.body ?? 'x'))
  const head = Buffer.from(
    JSON.stringify({
      files: files.map((f, i) => ({ path: f.path, size: f.size ?? bodies[i].length, mode: f.mode ?? 0o644 })),
    }),
  )
  const length = Buffer.alloc(4)
  length.writeUInt32BE(head.length)
  const data = gzipSync(Buffer.concat([length, head, ...bodies]))
  return { data, hash: createHash('sha256').update(data).digest('hex') }
}

describe('packRemoteCli', () => {
  it('打包 JS 树 + Linux 工具，排除宿主平台的 bin/，路径有序', async () => {
    const { cli, tools } = fixture()
    const archive = await packRemoteCli(cli, tools)
    expect(archive.hash).toBe(createHash('sha256').update(archive.data).digest('hex'))
    const entries = await unpackRemoteCli(archive.data)
    expect(entries.map(e => e.path)).toEqual([
      'dist/themes/dark.json',
      'node_modules/quickjs-wasi/quickjs.wasm',
      'package.json',
      'pixel.mjs',
      'bin/fd',
      'bin/licenses/rg-LICENSE.txt',
      'bin/rg',
    ])
    const mode = (path: string) => entries.find(e => e.path === path)!.mode
    expect(mode('bin/rg')).toBe(0o755)
    expect(mode('bin/fd')).toBe(0o755)
    expect(mode('bin/licenses/rg-LICENSE.txt')).toBe(0o644)
    expect(mode('pixel.mjs')).toBe(0o644)
    expect(entries.find(e => e.path === 'bin/rg')!.body.toString()).toBe('rg-linux')
    expect(entries.some(e => e.path.endsWith('rg.exe'))).toBe(false)
  })
  it('没有工具目录时只打 JS 树；同样的输入哈希一样', async () => {
    const { cli } = fixture()
    const a = await packRemoteCli(cli, null)
    expect((await unpackRemoteCli(a.data)).some(e => e.path.startsWith('bin/'))).toBe(false)
    expect((await packRemoteCli(cli, null)).hash).toBe(a.hash)
  })
  it('没有 pixel.mjs 时拒绝', async () => {
    await expect(packRemoteCli(fresh('empty'), null)).rejects.toThrow('REMOTE_CLI_MISSING')
  })
})

describe('远程脚本', () => {
  const hash = createHash('sha256').update('x').digest('hex')
  it('脚本不含 Windows / wsl.exe 命令行会弄坏的字符', () => {
    for (const script of [remoteCliCheckScript(hash), remoteCliInstallScript(hash)]) {
      for (const bad of ['"', '$', '`', '%', '\n', '\r', '\\']) expect(script).not.toContain(bad)
      expect(script).toContain(hash)
    }
  })
  it('拒绝不是哈希的输入', () => {
    expect(() => remoteCliInstallScript("x'+process.exit()+'")).toThrow('REMOTE_CLI_INVALID_HASH')
    expect(() => remoteCliCheckScript('abc')).toThrow('REMOTE_CLI_INVALID_HASH')
  })

  it('安装前检查脚本没输出，安装后输出入口路径；已装好时再装不报错', async () => {
    const { cli, tools } = fixture()
    const { data, hash } = await packRemoteCli(cli, tools)
    const home = fresh('home')
    expect(run(remoteCliCheckScript(hash), home)).toMatchObject({ code: 0, out: '' })
    const dir = installed(home, hash)
    const first = run(remoteCliInstallScript(hash), home, data)
    expect(first).toMatchObject({ code: 0, out: join(dir, 'pixel.mjs') })
    expect(run(remoteCliCheckScript(hash), home)).toMatchObject({ code: 0, out: join(dir, 'pixel.mjs') })
    expect(readFileSync(join(dir, 'pixel.mjs'), 'utf8')).toBe('console.log(1)')
    expect(readFileSync(join(dir, 'dist', 'themes', 'dark.json'), 'utf8')).toBe('{"a":1}')
    expect(readFileSync(join(dir, 'bin', 'rg'), 'utf8')).toBe('rg-linux')
    expect(existsSync(join(dir, '.complete'))).toBe(true)
    expect(existsSync(join(dir, 'bin', 'rg.exe'))).toBe(false)
    // 临时目录不留下
    expect(readdirSync(join(dir, '..'))).toEqual(['cli-' + hash])
    const second = run(remoteCliInstallScript(hash), home, data)
    expect(second).toMatchObject({ code: 0, out: join(dir, 'pixel.mjs') })
  })
  itPosix('文件权限按包里写的来：rg / fd 可执行，其他不可执行', async () => {
    const { cli, tools } = fixture()
    const { data, hash } = await packRemoteCli(cli, tools)
    const home = fresh('home')
    run(remoteCliInstallScript(hash), home, data)
    const dir = installed(home, hash)
    expect(statSync(join(dir, 'bin', 'rg')).mode & 0o777).toBe(0o755)
    expect(statSync(join(dir, 'bin', 'fd')).mode & 0o777).toBe(0o755)
    expect(statSync(join(dir, 'pixel.mjs')).mode & 0o777).toBe(0o644)
  })
  it('安装后删掉 7 天没用过的旧版本目录；最近用过的（别的桌面版本）留着', async () => {
    const { cli } = fixture()
    const { data, hash } = await packRemoteCli(cli, null)
    const home = fresh('home')
    const stale = installed(home, 'a'.repeat(64))
    const recent = installed(home, 'b'.repeat(64))
    for (const dir of [stale, recent]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'pixel.mjs'), 'old')
      writeFileSync(join(dir, '.complete'), '')
    }
    const long = new Date(Date.now() - REMOTE_CLI_KEEP_MS - 60_000)
    utimesSync(join(stale, '.complete'), long, long)
    utimesSync(stale, long, long)
    // 检查脚本会把用到的目录标成刚用过
    utimesSync(join(recent, '.complete'), long, long)
    expect(run(remoteCliCheckScript('b'.repeat(64)), home, Buffer.alloc(0)).out).toContain('pixel.mjs')
    const other = join(home, '.local', 'share', 'pixelsky', 'remote', 'v9')
    mkdirSync(other, { recursive: true })
    expect(run(remoteCliInstallScript(hash), home, data).code).toBe(0)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(installed(home, hash))).toBe(true)
  })
  it('残留的没装完的目录（没有 .complete）会被换掉', async () => {
    const { cli } = fixture()
    const { data, hash } = await packRemoteCli(cli, null)
    const home = fresh('home')
    const dir = installed(home, hash)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'junk'), 'junk')
    expect(run(remoteCliInstallScript(hash), home, data)).toMatchObject({ code: 0, out: join(dir, 'pixel.mjs') })
    expect(existsSync(join(dir, 'junk'))).toBe(false)
    expect(existsSync(join(dir, '.complete'))).toBe(true)
  })
  it('并发安装同一个版本都成功，结果只有一份', async () => {
    const { cli } = fixture()
    const { data, hash } = await packRemoteCli(cli, null)
    const home = fresh('home')
    const one = () =>
      new Promise<{ code: number | null; out: string }>(resolve => {
        const child = spawn(process.execPath, ['-e', remoteCliInstallScript(hash)], {
          env: { ...process.env, HOME: home, USERPROFILE: home },
        })
        let out = ''
        child.stdout.on('data', (d: Buffer) => (out += d))
        child.on('close', code => resolve({ code, out }))
        child.stdin.end(data)
      })
    const results = await Promise.all([one(), one(), one(), one()])
    const main = join(installed(home, hash), 'pixel.mjs')
    for (const r of results) expect(r).toEqual({ code: 0, out: main })
    expect(readdirSync(join(installed(home, hash), '..'))).toEqual(['cli-' + hash])
  })
  it('哈希不符退出码 2，什么都不写', async () => {
    const { cli } = fixture()
    const { data } = await packRemoteCli(cli, null)
    const home = fresh('home')
    const wrong = createHash('sha256').update('other').digest('hex')
    expect(run(remoteCliInstallScript(wrong), home, data).code).toBe(2)
    expect(existsSync(join(home, '.local'))).toBe(false)
  })
  it.each([
    ['上级目录', '../evil.txt'],
    ['中间的 ..', 'a/../../evil.txt'],
    ['绝对路径', '/tmp/evil.txt'],
    ['反斜杠', 'a\\evil.txt'],
    ['空段', 'a//b'],
    ['当前目录段', './a'],
    ['空路径', ''],
  ])('拒绝危险路径：%s', (_name, path) => {
    const { data, hash } = craft([{ path: 'pixel.mjs' }, { path }])
    const home = fresh('home')
    const result = run(remoteCliInstallScript(hash), home, data)
    expect(result.code).toBe(3)
    expect(existsSync(installed(home, hash))).toBe(false)
    expect(existsSync(join(home, '.local', 'share', 'pixelsky', 'remote', 'evil.txt'))).toBe(false)
    expect(existsSync(join(home, '.local', 'share', 'pixelsky', 'evil.txt'))).toBe(false)
    expect(existsSync(join(home, 'evil.txt'))).toBe(false)
    // 失败后临时目录也清掉
    expect(readdirSync(join(installed(home, hash), '..'))).toEqual([])
  })
  it('头里的大小超出实际数据时拒绝', () => {
    const { data, hash } = craft([{ path: 'pixel.mjs', size: 9999, body: 'short' }])
    const home = fresh('home')
    expect(run(remoteCliInstallScript(hash), home, data).code).toBe(1)
    expect(existsSync(installed(home, hash))).toBe(false)
  })
  it('不是 gzip 的数据（哈希对）也失败，不写目录', () => {
    const data = Buffer.from('not gzip')
    const hash = createHash('sha256').update(data).digest('hex')
    const home = fresh('home')
    expect(run(remoteCliInstallScript(hash), home, data).code).toBe(1)
    expect(existsSync(installed(home, hash))).toBe(false)
  })
})

describe('版本与路径校验', () => {
  it('Node 22.19 起才下发，架构只认 x64 / arm64', () => {
    expect(remoteCliSupported('22.19.0', 'x64')).toBe(true)
    expect(remoteCliSupported('22.18.9', 'x64')).toBe(false)
    expect(remoteCliSupported('22.0.0', 'arm64')).toBe(false)
    expect(remoteCliSupported('23.0.0', 'arm64')).toBe(true)
    expect(remoteCliSupported('24.10.1', 'x64')).toBe(true)
    expect(remoteCliSupported('24.0.0', 'arm')).toBe(false)
    expect(remoteCliSupported(null, 'x64')).toBe(false)
    expect(remoteCliSupported('bad', 'x64')).toBe(false)
  })
  const hash = 'ab'.repeat(32)
  const entry = (home: string, h = hash) => home + '/.local/share/pixelsky/remote/cli-' + h + '/pixel.mjs'
  it('入口路径必须是 <home>/.local/share/pixelsky/remote/cli-<64 位哈希>/pixel.mjs', () => {
    expect(isRemoteCliEntry(entry('/home/x'), '/home/x')).toBe(true)
    expect(isRemoteCliEntry(entry('/home/x'), '/home/x', hash)).toBe(true)
    expect(isRemoteCliEntry(entry('/home/x'), '/home/x', 'cd'.repeat(32))).toBe(false)
    expect(isRemoteCliEntry(entry('/home/x y'), '/home/x y')).toBe(true)
    expect(isRemoteCliEntry(entry('/home/x'), '/home/y')).toBe(false)
    expect(isRemoteCliEntry(entry('/home/x', 'ab'), '/home/x')).toBe(false)
    expect(isRemoteCliEntry(entry('/home/x', 'AB'.repeat(32)), '/home/x')).toBe(false)
    expect(isRemoteCliEntry(entry('/home/x', '../../..'), '/home/x')).toBe(false)
    expect(isRemoteCliEntry(entry('/home/x').replace('pixel.mjs', 'evil.mjs'), '/home/x')).toBe(false)
    expect(isRemoteCliEntry(entry('/home/x') + '/../../x/pixel.mjs', '/home/x')).toBe(false)
    expect(isRemoteCliEntry('', '/home/x')).toBe(false)
  })
  it('Windows 远端：反斜杠当分隔符；其他系统上反斜杠不算', () => {
    const win = 'C:\\Users\\x\\.local\\share\\pixelsky\\remote\\cli-' + hash + '\\pixel.mjs'
    expect(isRemoteCliEntry(win, 'C:\\Users\\x', hash, true)).toBe(true)
    expect(isRemoteCliEntry(win, 'C:\\Users\\y', hash, true)).toBe(false)
    expect(
      isRemoteCliEntry(win.replace('cli-' + hash, 'cli-' + hash + '\\..\\..'), 'C:\\Users\\x', undefined, true),
    ).toBe(false)
    expect(isRemoteCliEntry(win, 'C:\\Users\\x', hash)).toBe(false)
  })
})

describe('createRemoteCliCache', () => {
  it('每个架构只打一次包；缺文件返回 null；失败不缓存', async () => {
    const { cli, tools } = fixture()
    const sources = vi.fn(async () => ({ cliDir: cli, toolsDir: () => tools }))
    const get = createRemoteCliCache(sources)
    const [a, b] = await Promise.all([get('x64'), get('x64')])
    expect(a).not.toBeNull()
    expect(b).toBe(a)
    expect(await get('x64')).toBe(a)
    // arm64 的工具目录不存在：照样打包，只是没有 bin/
    const noTools = createRemoteCliCache(async () => ({ cliDir: cli, toolsDir: () => join(root, 'nope') }))
    const bare = await noTools('arm64')
    expect((await unpackRemoteCli(bare!.data)).some(e => e.path.startsWith('bin/'))).toBe(false)
    // Windows / macOS 远端不带 Linux 版 rg / fd，和 Linux 的包分开缓存
    expect((await unpackRemoteCli(a!.data)).some(e => e.path.startsWith('bin/'))).toBe(true)
    const windows = await get('x64', 'win32')
    expect(windows).not.toBe(a)
    expect((await unpackRemoteCli(windows!.data)).some(e => e.path.startsWith('bin/'))).toBe(false)
    const missing = createRemoteCliCache(async () => ({ cliDir: join(root, 'nope'), toolsDir: () => tools }))
    expect(await missing('x64')).toBeNull()
    const broken = createRemoteCliCache(async () => {
      throw new Error('no electron')
    })
    expect(await broken('x64')).toBeNull()
  })
})
