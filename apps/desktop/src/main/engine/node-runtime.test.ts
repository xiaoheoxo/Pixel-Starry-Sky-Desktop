// 私有 Node.js（docs/ui/engine-update.md §7）：选版本、校验、先官方后镜像、解压到 runtime/node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNodeRuntime, nodeTarget, pickRelease, runtimeLayout, shasumOf } from './node-runtime'

/** 打开后写盘失败（模拟磁盘满）：只在 failWrites 为真时换掉 createWriteStream */
const disk = vi.hoisted(() => ({ failWrites: false }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    createWriteStream: ((...args: Parameters<typeof fs.createWriteStream>) =>
      disk.failWrites
        ? new Writable({
            write: (_chunk, _encoding, callback) => callback(new Error('ENOSPC: no space left on device')),
          })
        : fs.createWriteStream(...args)) as typeof fs.createWriteStream,
  }
})

describe('选哪个包', () => {
  it('各平台的包名', () => {
    expect(nodeTarget('win32', 'x64')!.name('v24.1.0')).toBe('node-v24.1.0-win-x64')
    expect(nodeTarget('win32', 'x64')!.key).toBe('win-x64-zip')
    expect(nodeTarget('darwin', 'arm64')).toMatchObject({ key: 'osx-arm64-tar', ext: 'tar.gz' })
    expect(nodeTarget('linux', 'x64')!.name('v24.1.0')).toBe('node-v24.1.0-linux-x64')
    expect(nodeTarget('linux', 'ia32')).toBeNull()
    expect(nodeTarget('freebsd', 'x64')).toBeNull()
  })
  it('index.json 里第一个有这个平台包的 LTS', () => {
    const index = [
      { version: 'v26.1.0', lts: false, files: ['win-x64-zip'] },
      { version: 'v24.22.0', lts: 'Krypton', files: ['linux-x64'] },
      { version: 'v24.21.0', lts: 'Krypton', files: ['win-x64-zip', 'linux-x64'] },
    ]
    expect(pickRelease(index, 'win-x64-zip')).toBe('v24.21.0')
    expect(pickRelease(index, 'linux-x64')).toBe('v24.22.0')
    expect(pickRelease(index, 'osx-arm64-tar')).toBeNull()
    expect(pickRelease({}, 'win-x64-zip')).toBeNull()
  })
  it('SHASUMS256.txt', () => {
    const a = 'a'.repeat(64),
      b = 'B'.repeat(64)
    const text = `${a}  node-v24.1.0-win-x64.zip\n${b}  node-v24.1.0-linux-x64.tar.gz\n`
    expect(shasumOf(text, 'node-v24.1.0-linux-x64.tar.gz')).toBe('b'.repeat(64))
    expect(shasumOf(text, 'node-v24.1.0-win-x64.7z')).toBeNull()
  })
})

// 临时目录放仓库根目录的 scratch/（AGENTS.md §2）
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })))
const temp = (): string => {
  const d = mkdtempSync(fileURLToPath(new URL('../../../../../scratch/node-runtime-', import.meta.url)))
  dirs.push(d)
  return d
}

/** 用系统 tar 打一个和官方结构一样的小包（只有 node 程序和 npm-cli.js 两个文件） */
function fakeRelease(version: string) {
  const target = nodeTarget()!
  const work = temp()
  const name = target.name(version)
  const unpacked = runtimeLayout(join(work, 'x')).exe.replace(join(work, 'x', 'node'), join(work, name))
  const cli = runtimeLayout(join(work, 'x')).cli.replace(join(work, 'x', 'node'), join(work, name))
  for (const f of [unpacked, cli]) {
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, 'fake')
  }
  const file = `${name}.${target.ext}`
  const tar =
    process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  execFileSync(tar, target.ext === 'zip' ? ['-a', '-cf', file, name] : ['-czf', file, name], { cwd: work })
  const archive = readFileSync(join(work, file))
  return {
    archive,
    file,
    index: [{ version, lts: 'Krypton', files: [target.key] }],
    sums: `${createHash('sha256').update(archive).digest('hex')}  ${file}\n`,
  }
}

describe.skipIf(!nodeTarget())('下载、校验、解压', () => {
  it('官方源连不上：换国内镜像，装到 runtime/node，临时文件清掉', async () => {
    const release = fakeRelease('v24.9.0')
    const root = temp()
    const asked: string[] = []
    const runtime = createNodeRuntime({
      root,
      fetch: async url => {
        asked.push(url)
        if (url.startsWith('https://nodejs.org')) throw new TypeError('fetch failed')
        if (url.endsWith('/index.json')) return Response.json(release.index)
        if (url.endsWith('/SHASUMS256.txt')) return new Response(release.sums)
        if (url.endsWith(release.file)) return new Response(release.archive)
        return new Response('', { status: 404 })
      },
    })
    expect(runtime.paths()).toEqual([])
    const lines: string[] = []
    const tool = await runtime.ensure(line => lines.push(line))
    const layout = runtimeLayout(root)
    expect(tool).toEqual({ node: layout.exe, cli: layout.cli, prefix: layout.prefix })
    expect(existsSync(layout.exe) && existsSync(layout.cli) && existsSync(layout.prefix)).toBe(true)
    expect(runtime.paths()).toEqual(layout.paths)
    expect(asked[0]).toBe('https://nodejs.org/dist/index.json')
    expect(asked.at(-1)).toBe(`https://cdn.npmmirror.com/binaries/node/v24.9.0/${release.file}`)
    expect(lines.some(l => l.includes('官方源') && l.includes('没成功'))).toBe(true)
    expect(lines.some(l => l.includes('国内镜像'))).toBe(true)
    expect(readdirSync(root).sort()).toEqual(['node', 'npm-global'])
    // 装好了就不再下载
    asked.length = 0
    await runtime.ensure(() => undefined)
    expect(asked).toEqual([])
  })

  it('校验不对：不装，两处都失败时报错带上原因', async () => {
    const release = fakeRelease('v24.9.0')
    const root = temp()
    const runtime = createNodeRuntime({
      root,
      fetch: async url => {
        if (url.endsWith('/index.json')) return Response.json(release.index)
        if (url.endsWith('/SHASUMS256.txt')) return new Response(`${'0'.repeat(64)}  ${release.file}\n`)
        return new Response(release.archive)
      },
    })
    await expect(runtime.ensure(() => undefined)).rejects.toThrow(/官方源：.*校验不对.*国内镜像：.*校验不对/)
    expect(existsSync(runtimeLayout(root).node)).toBe(false)
    expect(readdirSync(root)).toEqual([])
  })

  it('上次留下的下载临时目录：下载前清掉，别的目录不动', async () => {
    const release = fakeRelease('v24.9.0')
    const root = temp()
    mkdirSync(join(root, '.download-1700000000000', 'half'), { recursive: true })
    mkdirSync(join(root, '.download-mine'))
    const runtime = createNodeRuntime({
      root,
      fetch: async url => {
        if (url.endsWith('/index.json')) return Response.json(release.index)
        if (url.endsWith('/SHASUMS256.txt')) return new Response(release.sums)
        return new Response(release.archive)
      },
    })
    await runtime.ensure(() => undefined)
    expect(readdirSync(root).sort()).toEqual(['.download-mine', 'node', 'npm-global'])
  })

  it('写盘出错（磁盘满）：网络流跟着关掉，不挂到超时', async () => {
    const release = fakeRelease('v24.9.0')
    const root = temp()
    let cancelled = 0
    const runtime = createNodeRuntime({
      root,
      fetch: async url => {
        if (url.endsWith('/index.json')) return Response.json(release.index)
        if (url.endsWith('/SHASUMS256.txt')) return new Response(release.sums)
        // 一直有数据、永远不结束的下载
        const body = new ReadableStream<Uint8Array>({
          pull: controller => controller.enqueue(new Uint8Array(1024)),
          cancel: () => {
            cancelled++
          },
        })
        return new Response(body)
      },
    })
    disk.failWrites = true
    try {
      await expect(runtime.ensure(() => undefined)).rejects.toThrow(/ENOSPC/)
    } finally {
      disk.failWrites = false
    }
    expect(cancelled).toBe(2)
    expect(readdirSync(root)).toEqual([])
  })
})
