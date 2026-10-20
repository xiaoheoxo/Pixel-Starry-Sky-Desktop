// 私有 Node.js（docs/ui/engine-update.md §7）：没装 Node.js 的电脑上，一键安装 Codex（和 Claude Code 官方安装器装不上时的 npm 安装）
// 先下载一份只给像素星空用的 Node.js，放在应用数据目录 runtime/ 下，不弹管理员确认、不改系统 PATH。
// 版本取官方 index.json 里最新的 LTS；先官方源，失败换国内镜像；按 SHASUMS256.txt 校验；用系统自带的 tar 解压（Windows 10 起自带，认 zip）
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import type { NodeRuntime, NpmTool } from '@pixelsky/engine'

export const NODE_SOURCES = [
  { name: '官方源', url: 'https://nodejs.org/dist' },
  { name: '国内镜像', url: 'https://cdn.npmmirror.com/binaries/node' },
] as const

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>

/** 这台电脑要下载哪个包：index.json 里 files 的键、文件名和解压出来的目录名 */
export interface NodeTarget {
  key: string
  name: (version: string) => string
  ext: 'zip' | 'tar.gz'
}

export function nodeTarget(platform: NodeJS.Platform = process.platform, arch = process.arch): NodeTarget | null {
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null
  if (!cpu) return null
  if (platform === 'win32') return { key: `win-${cpu}-zip`, name: v => `node-${v}-win-${cpu}`, ext: 'zip' }
  if (platform === 'darwin') return { key: `osx-${cpu}-tar`, name: v => `node-${v}-darwin-${cpu}`, ext: 'tar.gz' }
  if (platform === 'linux') return { key: `linux-${cpu}`, name: v => `node-${v}-linux-${cpu}`, ext: 'tar.gz' }
  return null
}

/** index.json（新的在前）里第一个有这个平台包的 LTS 版本 */
export function pickRelease(index: unknown, key: string): string | null {
  if (!Array.isArray(index)) return null
  for (const entry of index) {
    const e = entry as { version?: unknown; lts?: unknown; files?: unknown }
    if (
      e.lts &&
      typeof e.version === 'string' &&
      /^v\d+\.\d+\.\d+$/.test(e.version) &&
      Array.isArray(e.files) &&
      e.files.includes(key)
    )
      return e.version
  }
  return null
}

/** SHASUMS256.txt 里这个文件的 sha256 */
export function shasumOf(text: string, file: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim())
    if (m && m[2] === file) return m[1].toLowerCase()
  }
  return null
}

/** 解压出来的 Node.js 目录里 node 程序的位置 */
const exeIn = (dir: string, windows: boolean): string => (windows ? join(dir, 'node.exe') : join(dir, 'bin', 'node'))

/** 私有 Node.js 的位置：root/node 是解压出来的那份，root/npm-global 是 npm -g 装到的地方 */
export function runtimeLayout(root: string, windows = process.platform === 'win32') {
  const node = join(root, 'node'),
    prefix = join(root, 'npm-global')
  return windows
    ? {
        node,
        prefix,
        exe: exeIn(node, true),
        cli: join(node, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        paths: [node, prefix],
      }
    : {
        node,
        prefix,
        exe: exeIn(node, false),
        cli: join(node, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        paths: [join(node, 'bin'), join(prefix, 'bin')],
      }
}

const MB = 1024 * 1024

function tar(archive: string, into: string, ext: NodeTarget['ext']): Promise<void> {
  const command =
    process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  return new Promise((resolve, reject) => {
    const child = spawn(command, [ext === 'zip' ? '-xf' : '-xzf', archive, '-C', into], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)))
    child.on('error', reject)
    child.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`解压失败（tar 退出码 ${code}）${err.trim()}`)),
    )
  })
}

export function createNodeRuntime(opts: { root: string; fetch: Fetch; target?: NodeTarget | null }): NodeRuntime {
  const layout = runtimeLayout(opts.root)
  const target = opts.target === undefined ? nodeTarget() : opts.target
  const ready = (): boolean => existsSync(layout.exe) && existsSync(layout.cli)
  const tool = (): NpmTool => ({ node: layout.exe, cli: layout.cli, prefix: layout.prefix })
  let installing: Promise<NpmTool> | null = null

  const get = async (url: string, ms: number): Promise<Response> => {
    const r = await opts.fetch(url, { signal: AbortSignal.timeout(ms) })
    if (!r.ok) {
      await r.body?.cancel().catch(() => undefined)
      throw new Error(`${url} 返回 ${r.status}`)
    }
    return r
  }

  const installFrom = async (source: (typeof NODE_SOURCES)[number], onLine: (line: string) => void) => {
    if (!target) throw new Error('这台电脑的系统或处理器没有官方的 Node.js 包')
    const version = pickRelease(await (await get(`${source.url}/index.json`, 20_000)).json(), target.key)
    if (!version) throw new Error('没找到可用的 Node.js 版本')
    const name = target.name(version),
      file = `${name}.${target.ext}`
    const expected = shasumOf(await (await get(`${source.url}/${version}/SHASUMS256.txt`, 20_000)).text(), file)
    if (!expected) throw new Error(`校验文件里没有 ${file}`)
    const tmp = join(opts.root, `.download-${Date.now()}`)
    await mkdir(tmp, { recursive: true })
    try {
      onLine(`正在下载 Node.js ${version}（${source.name}）`)
      const response = await get(`${source.url}/${version}/${file}`, 15 * 60_000)
      const total = Number(response.headers.get('content-length')) || 0
      const hash = createHash('sha256')
      const archive = join(tmp, file)
      const out = createWriteStream(archive)
      let got = 0,
        shown = 0
      const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
      body.on('data', (chunk: Buffer) => {
        hash.update(chunk)
        got += chunk.length
        if (Date.now() - shown < 1000) return
        shown = Date.now()
        onLine(
          total
            ? `下载 Node.js ${Math.floor((got / total) * 100)}%（${(got / MB).toFixed(1)} / ${(total / MB).toFixed(1)} MB）`
            : `下载 Node.js ${(got / MB).toFixed(1)} MB`,
        )
      })
      await finished(body.pipe(out))
      if (hash.digest('hex') !== expected) throw new Error('下载的 Node.js 校验不对（可能下载不完整），请重试')
      onLine(`正在解压 Node.js ${version}`)
      await tar(archive, tmp, target.ext)
      const unpacked = join(tmp, name)
      if (!existsSync(exeIn(unpacked, process.platform === 'win32'))) throw new Error('解压出来的 Node.js 不完整')
      await rm(layout.node, { recursive: true, force: true })
      await rename(unpacked, layout.node)
      await mkdir(layout.prefix, { recursive: true })
      onLine(`Node.js ${version} 已安装（只给像素星空用，不影响系统）`)
    } finally {
      await rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
    }
  }

  return {
    paths: () => (ready() ? layout.paths : []),
    ensure(onLine) {
      if (ready()) return Promise.resolve(tool())
      installing ??= (async () => {
        const errors: string[] = []
        for (const source of NODE_SOURCES) {
          try {
            await installFrom(source, onLine)
            return tool()
          } catch (e) {
            const message = (e as Error).name === 'TimeoutError' ? '超时' : (e as Error).message
            errors.push(`${source.name}：${message}`)
            onLine(`从${source.name}下载 Node.js 没成功：${message}`)
          }
        }
        throw new Error(`Node.js 下载失败（${errors.join('；')}）。可以自己安装 Node.js 后再试`)
      })().finally(() => {
        installing = null
      })
      return installing
    },
  }
}
