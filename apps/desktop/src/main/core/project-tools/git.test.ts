// Git 面板的真实 git 测试（docs/ui/git-panel.md §7）：在 scratch 下建仓库和裸远端，不访问网络。
import { mkdtemp, mkdir, readFile, writeFile, rm, access, symlink } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitResult, GitStatus } from '../../../shared/types/project-tools'
import { git, type ToolsHost } from './common'
import { DIFF_LIMIT, GitTools, pathBatches } from './git'
import { IMAGE_LIMIT } from '../../../shared/imageFiles'

// 数 git 进程：真起进程，只是记下调用
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})
/** 到目前为止起过几个带这个参数的 git 进程 */
const spawned = (arg: string): number =>
  vi.mocked(spawn).mock.calls.filter(([cmd, args]) => cmd === 'git' && (args as string[]).includes(arg)).length

let root: string,
  project: string,
  remote: string,
  host: ToolsHost,
  busy = 0
const ref = { projectId: 'p' }
const trashed: string[] = []
beforeEach(async () => {
  const scratch = resolve('../../scratch')
  await mkdir(scratch, { recursive: true })
  root = await mkdtemp(join(scratch, 'git-unit-'))
  project = join(root, 'project')
  remote = join(root, 'remote.git')
  await mkdir(project)
  busy = 0
  trashed.length = 0
  // scratch 在本项目的仓库里面：不让 git 往上找到它
  process.env.GIT_CEILING_DIRECTORIES = root
  host = {
    resolve: r => {
      if (r.projectId !== 'p') throw new Error('unknown')
      return { projectId: 'p', name: 'test', path: project }
    },
    plans: () => [],
    create: () => {
      throw new Error('no')
    },
    withStopped: async (_p, action) => action(),
    sessions: () => Array.from({ length: busy }, (_, i) => ({ id: 's' + i, title: 't', state: 'running' })),
  }
})
afterEach(async () => {
  // 卡住的 hook 被结束后，Git 自带 sh 起的子进程（sleep）在有的机器上不会一起结束，会短暂占着目录：多等一会儿再删
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })
})

async function init(dir = project): Promise<void> {
  await git(dir, ['init', '-b', 'main'])
  for (const [k, v] of [
    ['user.email', 'git@example.invalid'],
    ['user.name', 'Git test'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
    ['core.hooksPath', '.git/hooks'],
  ])
    await git(dir, ['config', k, v])
}
async function commitAll(message: string, dir = project): Promise<void> {
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', message])
}
async function withRemote(): Promise<void> {
  await init()
  await writeFile(join(project, 'a.txt'), 'one\n')
  await commitAll('base')
  await git(root, ['init', '--bare', '-b', 'main', remote])
  await git(project, ['remote', 'add', 'origin', remote])
  await git(project, ['push', '-q', '-u', 'origin', 'main'])
}
async function otherClone(): Promise<string> {
  const other = join(root, 'other')
  await git(root, ['clone', '-q', remote, other])
  for (const [k, v] of [
    ['user.email', 'o@example.invalid'],
    ['user.name', 'Other'],
    ['commit.gpgsign', 'false'],
  ])
    await git(other, ['config', k, v])
  return other
}
const ok = (r: GitResult): GitStatus => {
  if (!r.ok) throw new Error(`${r.failure.kind}: ${r.failure.detail}`)
  return r.status
}
const fail = (r: GitResult) => {
  if (r.ok) throw new Error('expected failure')
  return r.failure
}
const tools = (
  opts: ConstructorParameters<typeof GitTools>[2] = {
    trash: async files => {
      for (const { absolute } of files) {
        trashed.push(absolute)
        await rm(absolute)
      }
    },
  },
) => new GitTools(host, () => {}, { statusReuseMs: 0, ...opts })

describe('Git 面板：状态与差异', () => {
  it('不是仓库、首次提交前的暂存 / 取消暂存', async () => {
    const g = tools()
    expect(await g.status(ref)).toMatchObject({ repo: false, missing: false })
    expect(fail(await g.stage(ref, 'all')).kind).toBe('notRepo')
    await init()
    await writeFile(join(project, '中文 文件.txt'), 'x')
    expect((await g.status(ref)).untracked.map(f => f.path)).toEqual(['中文 文件.txt'])
    const staged = ok(await g.stage(ref, ['中文 文件.txt']))
    expect(staged).toMatchObject({ initial: true, branch: 'main' })
    expect(staged.staged).toMatchObject([{ path: '中文 文件.txt', code: 'A' }])
    expect(ok(await g.unstage(ref, 'all')).untracked).toHaveLength(1)
  })
  it('暂存和更改分开；改名；工作区是子目录时给出本地路径；差异按 LF 比较、二进制不比较', async () => {
    await init()
    await mkdir(join(project, 'web'))
    await writeFile(join(project, 'web', 'a.txt'), 'one\r\ntwo\r\n')
    await writeFile(join(project, 'old.txt'), 'rename me')
    await writeFile(join(project, 'bin.dat'), Buffer.from([0, 1, 2]))
    await commitAll('base')
    await writeFile(join(project, 'web', 'a.txt'), 'one\r\nTWO\r\n')
    await git(project, ['add', 'web/a.txt'])
    await writeFile(join(project, 'web', 'a.txt'), 'one\r\nTWO\r\nthree\r\n')
    await git(project, ['mv', 'old.txt', 'new.txt'])
    await writeFile(join(project, 'bin.dat'), Buffer.from([0, 9]))
    const g = tools(),
      s = await g.status(ref)
    expect(s.staged.map(f => [f.path, f.code, f.origPath])).toEqual([
      ['new.txt', 'R', 'old.txt'],
      ['web/a.txt', 'M', null],
    ])
    expect(s.unstaged.map(f => f.path).sort()).toEqual(['bin.dat', 'web/a.txt'])
    expect(await g.diff(ref, { path: 'web/a.txt', area: 'staged' })).toMatchObject({
      original: 'one\ntwo\n',
      modified: 'one\nTWO\n',
    })
    expect(await g.diff(ref, { path: 'web/a.txt', area: 'unstaged' })).toMatchObject({
      original: 'one\nTWO\n',
      modified: 'one\nTWO\nthree\n',
    })
    expect(await g.diff(ref, { path: 'new.txt', area: 'staged', origPath: 'old.txt' })).toMatchObject({
      original: 'rename me',
      modified: 'rename me',
    })
    expect(await g.diff(ref, { path: 'bin.dat', area: 'unstaged' })).toMatchObject({ binary: true, original: null })
    const sub = new GitTools(
      { ...host, resolve: () => ({ projectId: 'p', name: 'web', path: join(project, 'web') }) },
      () => {},
    )
    const subStatus = await sub.status(ref)
    expect(subStatus.staged.find(f => f.path === 'web/a.txt')?.local).toBe('a.txt')
    expect(subStatus.staged.find(f => f.path === 'new.txt')?.local).toBeNull()
  })
})

describe('Git 面板：增删行数（手机）', () => {
  it('stats：暂存、更改各自的行数，改名取新路径，二进制是 null，未跟踪不带；默认不带也不起 diff；同一份状态只数一次', async () => {
    await init()
    await writeFile(join(project, 'a.txt'), 'one\ntwo\n')
    await writeFile(join(project, 'old.txt'), 'rename me\n')
    await writeFile(join(project, 'bin.dat'), Buffer.from([0, 1, 2]))
    await commitAll('base')
    await writeFile(join(project, 'a.txt'), 'one\nTWO\n')
    await git(project, ['add', 'a.txt'])
    await writeFile(join(project, 'a.txt'), 'one\nTWO\nthree\nfour\n')
    await git(project, ['mv', 'old.txt', 'new.txt'])
    await writeFile(join(project, 'bin.dat'), Buffer.from([0, 9]))
    await writeFile(join(project, 'fresh.txt'), 'x\n')
    const g = tools({ statusReuseMs: 500 })
    vi.mocked(spawn).mockClear()
    const plain = await g.status(ref)
    expect(spawned('--numstat')).toBe(0)
    expect(plain.staged.every(f => !('insertions' in f))).toBe(true)
    const s = await g.status(ref, false, false, true)
    const counts = (rows: GitStatus['staged']) => rows.map(f => [f.path, f.insertions, f.deletions])
    expect(counts(s.staged)).toEqual([
      ['a.txt', 1, 1],
      ['new.txt', 0, 0],
    ])
    expect(counts(s.unstaged).sort()).toEqual([
      ['a.txt', 2, 0],
      ['bin.dat', null, null],
    ])
    expect(s.untracked[0]).not.toHaveProperty('insertions')
    expect(spawned('--numstat')).toBe(2)
    await g.status(ref, false, false, true)
    expect(spawned('--numstat')).toBe(2)
  })
})

describe('Git 图片版本', { timeout: 30_000 }, () => {
  // PNG 文件头加几个字节：格式按内容认
  const png = (...rest: number[]) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...rest])
  const base = png(0, 255, 1)
  const staged = png(0, 254, 2)
  const work = png(0, 253, 3)
  const preview = (b: Buffer) => ({ dataUrl: `data:image/png;base64,${b.toString('base64')}`, bytes: b.length })

  it('暂存比较 HEAD 与 index，未暂存比较 index 与工作区；历史不读取当前文件', async () => {
    await init()
    await writeFile(join(project, '贴图 空格.PNG'), base)
    await commitAll('base image')
    const from = await git(project, ['rev-parse', 'HEAD'])
    await writeFile(join(project, '贴图 空格.PNG'), staged)
    await commitAll('second image')
    const to = await git(project, ['rev-parse', 'HEAD'])
    await writeFile(join(project, '贴图 空格.PNG'), work)
    const g = tools()
    const historical = await g.diff(ref, { path: '贴图 空格.PNG', area: 'commit', from: from.trim(), to: to.trim() })
    expect(historical).toMatchObject({
      binary: true,
      original: null,
      modified: null,
      images: { original: preview(base), modified: preview(staged) },
    })
    await git(project, ['add', '贴图 空格.PNG'])
    await writeFile(join(project, '贴图 空格.PNG'), base)
    expect((await g.diff(ref, { path: '贴图 空格.PNG', area: 'staged' })).images).toEqual({
      original: preview(staged),
      modified: preview(work),
    })
    expect((await g.diff(ref, { path: '贴图 空格.PNG', area: 'unstaged' })).images).toEqual({
      original: preview(work),
      modified: preview(base),
    })
  })

  it('新增、删除、改名、根提交都保留正确的缺失一端', async () => {
    await init()
    await writeFile(join(project, 'old.png'), base)
    const g = tools()
    expect((await g.diff(ref, { path: 'old.png', area: 'untracked' })).images).toEqual({
      original: null,
      modified: preview(base),
    })
    await git(project, ['add', 'old.png'])
    expect((await g.diff(ref, { path: 'old.png', area: 'staged' })).images).toEqual({
      original: null,
      modified: preview(base),
    })
    await commitAll('root image')
    const to = (await git(project, ['rev-parse', 'HEAD'])).trim()
    expect((await g.diff(ref, { path: 'old.png', area: 'commit', from: null, to })).images).toEqual({
      original: null,
      modified: preview(base),
    })
    await git(project, ['mv', 'old.png', 'new.png'])
    expect((await g.diff(ref, { path: 'new.png', origPath: 'old.png', area: 'staged' })).images).toEqual({
      original: preview(base),
      modified: preview(base),
    })
    await rm(join(project, 'new.png'))
    expect((await g.diff(ref, { path: 'new.png', area: 'unstaged' })).images).toEqual({
      original: preview(base),
      modified: null,
    })
    await git(project, ['add', '-A'])
    expect((await g.diff(ref, { path: 'old.png', area: 'staged' })).images).toEqual({
      original: preview(base),
      modified: null,
    })
  })

  it('图片可以超过文本的 2MB 上限，但超过 8MB 不传输预览', async () => {
    await init()
    const large = Buffer.concat([png(), Buffer.alloc(DIFF_LIMIT + 1, 7)])
    await writeFile(join(project, 'large.png'), large)
    const g = tools()
    expect((await g.diff(ref, { path: 'large.png', area: 'untracked' })).images?.modified).toMatchObject({
      bytes: large.length,
    })
    await git(project, ['add', 'large.png'])
    expect((await g.diff(ref, { path: 'large.png', area: 'staged' })).images?.modified).toMatchObject({
      dataUrl: preview(large).dataUrl,
    })
    await writeFile(join(project, 'large.png'), Buffer.alloc(IMAGE_LIMIT + 1))
    expect(await g.diff(ref, { path: 'large.png', area: 'unstaged' })).toMatchObject({
      tooLarge: true,
      image: true,
      original: null,
      modified: null,
    })
    expect((await g.diff(ref, { path: 'large.png', area: 'unstaged' })).images).toBeUndefined()
  })

  it('两端没变时带上次的 version 只回 unchanged，不再读图片；变了照常返回', async () => {
    await init()
    await writeFile(join(project, 'a.png'), base)
    await commitAll('base image')
    await writeFile(join(project, 'a.png'), work)
    const g = tools()
    const first = await g.diff(ref, { path: 'a.png', area: 'unstaged' })
    expect(first.version).toMatch(/^[0-9a-f]{40}$/)
    const blobs = spawned('blob')
    expect(await g.diff(ref, { path: 'a.png', area: 'unstaged', known: first.version })).toEqual({
      path: 'a.png',
      original: null,
      modified: null,
      binary: true,
      tooLarge: false,
      version: first.version,
      unchanged: true,
    })
    expect(spawned('blob')).toBe(blobs)
    await writeFile(join(project, 'a.png'), staged)
    const next = await g.diff(ref, { path: 'a.png', area: 'unstaged', known: first.version })
    expect(next.unchanged).toBeUndefined()
    expect(next.version).not.toBe(first.version)
    expect(next.images).toEqual({ original: preview(base), modified: preview(staged) })
  })

  it('读不出来时报错，不当成新增或删除（图片和文字都是）', async () => {
    await init()
    await writeFile(join(project, 'a.png'), base)
    await writeFile(join(project, 'a.txt'), 'hello\n')
    await commitAll('base')
    const slow = tools({ timeouts: { diff: 1 } })
    await expect(slow.diff(ref, { path: 'a.png', area: 'unstaged' })).rejects.toThrow('git.diffTimeout')
    await expect(slow.diff(ref, { path: 'a.txt', area: 'staged' })).rejects.toThrow('git.diffTimeout')
  })

  it('工作区的符号链接比链接写的路径，不跟到目标（指向项目外也能比）', async () => {
    await init()
    await writeFile(join(root, 'outside.txt'), 'secret')
    try {
      await symlink('../outside.txt', join(project, 'out'), 'file')
    } catch {
      return // Windows 没开开发者模式不能建符号链接
    }
    expect(await tools().diff(ref, { path: 'out', area: 'untracked' })).toMatchObject({
      original: '',
      modified: '../outside.txt',
    })
  })

  it('文字对比也按 version 跳过重读；手机（images: false）不读图片', async () => {
    await init()
    await writeFile(join(project, 'a.txt'), 'one\n')
    await writeFile(join(project, 'a.png'), base)
    await commitAll('base')
    await writeFile(join(project, 'a.txt'), 'two\n')
    await writeFile(join(project, 'a.png'), work)
    const g = tools()
    const first = await g.diff(ref, { path: 'a.txt', area: 'unstaged' })
    expect(first).toMatchObject({ original: 'one\n', modified: 'two\n', binary: false })
    const blobs = spawned('blob')
    expect(await g.diff(ref, { path: 'a.txt', area: 'unstaged', known: first.version })).toMatchObject({
      unchanged: true,
      original: null,
    })
    expect(await g.diff(ref, { path: 'a.png', area: 'unstaged', images: false })).toMatchObject({
      binary: true,
      tooLarge: false,
    })
    expect(spawned('blob')).toBe(blobs)
    await writeFile(join(project, 'a.txt'), 'three\n')
    expect(await g.diff(ref, { path: 'a.txt', area: 'unstaged', known: first.version })).toMatchObject({
      modified: 'three\n',
    })
  })

  it('文字文件是 Git LFS 指针时按 .gitattributes 换成真正的内容再比', async () => {
    await init()
    // 用一个假的过滤器代替 git-lfs（测试机不一定装了）：clean 原样存，smudge 输出真正的内容
    await git(project, ['config', 'filter.fake.clean', 'cat'])
    await git(project, ['config', 'filter.fake.smudge', 'echo smudged'])
    const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + '0'.repeat(64) + '\nsize 5\n'
    await writeFile(join(project, '.gitattributes'), 'data.txt filter=fake\n')
    await writeFile(join(project, 'data.txt'), pointer)
    await commitAll('pointer')
    await writeFile(join(project, 'data.txt'), 'smudged\nmore\n')
    expect(await tools().diff(ref, { path: 'data.txt', area: 'unstaged' })).toMatchObject({
      original: 'smudged\n',
      modified: 'smudged\nmore\n',
    })
  })

  it('Git LFS 指针写明的真实大小超过上限：直接按文件太大返回，不去换（文字、图片都一样）', async () => {
    await init()
    // 假过滤器：被调用就会换出小内容、不再是 tooLarge，以此证明没调用
    await git(project, ['config', 'filter.fake.clean', 'cat'])
    await git(project, ['config', 'filter.fake.smudge', 'echo smudged'])
    const pointer = (size: number): string =>
      'version https://git-lfs.github.com/spec/v1\noid sha256:' + '0'.repeat(64) + `\nsize ${size}\n`
    await writeFile(join(project, '.gitattributes'), '*.txt filter=fake\n*.png filter=fake\n')
    await writeFile(join(project, 'big.txt'), pointer(3 * 1024 * 1024))
    await writeFile(join(project, 'big.png'), pointer(9 * 1024 * 1024))
    await writeFile(join(project, 'mid.png'), pointer(3 * 1024 * 1024))
    await commitAll('big pointers')
    await writeFile(join(project, 'big.txt'), 'small\n')
    await writeFile(join(project, 'big.png'), base)
    await writeFile(join(project, 'mid.png'), base)
    const g = tools()
    expect(await g.diff(ref, { path: 'big.txt', area: 'unstaged' })).toMatchObject({ tooLarge: true, original: null })
    expect(await g.diff(ref, { path: 'big.png', area: 'unstaged' })).toMatchObject({ tooLarge: true, image: true })
    // 图片上限更大：3MB 的指针对图片不算太大，照常去换
    expect(await g.diff(ref, { path: 'mid.png', area: 'unstaged' })).toMatchObject({ tooLarge: false })
  })

  it('Git LFS 指针：换不成图片时标成 lfs；格式按内容认，改名前后不是图片的一端写明', async () => {
    await init()
    const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + '0'.repeat(64) + '\nsize 12345\n'
    await writeFile(join(project, 'lfs.png'), pointer)
    await commitAll('lfs pointer')
    const g = tools()
    expect(
      (
        await g.diff(ref, {
          path: 'lfs.png',
          area: 'commit',
          from: null,
          to: (await git(project, ['rev-parse', 'HEAD'])).trim(),
        })
      ).images,
    ).toEqual({
      original: null,
      modified: { unavailable: 'lfs' },
    })
    await writeFile(join(project, 'lfs.png'), base)
    expect((await g.diff(ref, { path: 'lfs.png', area: 'unstaged' })).images).toEqual({
      original: { unavailable: 'lfs' },
      modified: preview(base),
    })
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1])
    await writeFile(join(project, 'note.txt'), 'hello')
    await commitAll('text')
    await git(project, ['mv', 'note.txt', 'photo.png'])
    await writeFile(join(project, 'photo.png'), jpeg)
    await git(project, ['add', 'photo.png'])
    expect((await g.diff(ref, { path: 'photo.png', origPath: 'note.txt', area: 'staged' })).images).toEqual({
      original: { unavailable: 'notImage' },
      modified: { dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`, bytes: jpeg.length },
    })
  })
})

describe('Git 面板：状态缓存与合并', { timeout: 30_000 }, () => {
  it('同一仓库同时到的状态请求只跑一轮；窗口内复用，写操作后作废', async () => {
    await withRemote()
    const g = tools({ statusReuseMs: 500 })
    vi.mocked(spawn).mockClear()
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => g.status(ref)))
    expect(all.every(s => s.branch === 'main' && s.remotes[0] === 'origin')).toBe(true)
    expect(spawned('--show-toplevel')).toBe(1)
    expect(spawned('status')).toBe(1)
    // 首次：remote 和 git 内部路径各问一次
    expect(spawned('remote')).toBe(1)
    expect(spawned('--git-path')).toBe(1)
    // 窗口内再读：不起进程，看不到刚写的文件（外部改动最多晚半秒）
    await writeFile(join(project, 'late.txt'), 'x')
    expect((await g.status(ref)).untracked).toHaveLength(0)
    expect(spawned('status')).toBe(1)
    // 写操作之后作废：返回的状态和接下来的读取都带上新文件
    const staged = ok(await g.stage(ref, ['late.txt']))
    expect(staged.staged.map(f => f.path)).toEqual(['late.txt'])
    expect((await g.status(ref)).staged.map(f => f.path)).toEqual(['late.txt'])
  })

  it('读到一半有写操作：先开始的那一轮不记下，后到的请求拿到新结果', async () => {
    await withRemote()
    const g = tools({ statusReuseMs: 500 })
    const early = g.status(ref)
    await writeFile(join(project, 'b.txt'), 'x')
    ok(await g.stage(ref, ['b.txt']))
    await early
    expect((await g.status(ref)).staged.map(f => f.path)).toEqual(['b.txt'])
  })

  it('稳定后每次只起一个 git status；config 变了才重读 remote；会话数不受缓存影响', async () => {
    await withRemote()
    const g = tools()
    await g.status(ref)
    vi.mocked(spawn).mockClear()
    expect((await g.status(ref)).remotes).toEqual(['origin'])
    expect(vi.mocked(spawn).mock.calls).toHaveLength(1)
    expect(spawned('status')).toBe(1)
    await git(project, ['remote', 'add', 'backup', remote])
    expect((await g.status(ref)).remotes).toEqual(['backup', 'origin'])
    expect(spawned('remote')).toBe(1)
    busy = 2
    expect((await g.status(ref)).busySessions).toBe(2)
    expect(spawned('remote')).toBe(1)
  })

  it('工作区在子目录、.git 是文件的 worktree 里也能读；仓库根不会被缓存住', async () => {
    await withRemote()
    const linked = join(root, 'linked')
    await git(project, ['worktree', 'add', '-q', '-b', 'side', linked])
    const there = new GitTools({ ...host, resolve: () => ({ projectId: 'p', name: 'w', path: linked }) }, () => {}, {
      statusReuseMs: 0,
    })
    const first = await there.status(ref)
    expect(first).toMatchObject({ repo: true, branch: 'side', remotes: ['origin'], operation: null })
    // 第二次从缓存的 git 内部路径读（路径指向 worktree 自己的目录，不是工作区下的 .git/）
    await writeFile(join(linked, 'w.txt'), 'x')
    vi.mocked(spawn).mockClear()
    expect((await there.status(ref)).untracked.map(f => f.path)).toEqual(['w.txt'])
    expect(vi.mocked(spawn).mock.calls).toHaveLength(1)
    // 工作区里新建了自己的仓库：仓库根要跟着变
    const g = tools()
    await mkdir(join(project, 'web'))
    const inner = new GitTools(
      { ...host, resolve: () => ({ projectId: 'p', name: 'web', path: join(project, 'web') }) },
      () => {},
      { statusReuseMs: 0 },
    )
    expect((await inner.status(ref)).root).toBe(resolve(project))
    await init(join(project, 'web'))
    expect((await inner.status(ref)).root).toBe(resolve(project, 'web'))
    expect(await g.status(ref)).toMatchObject({ repo: true })
  })

  it('工作区和仓库根之间的目录新建了仓库：刷新、提交都换到新仓库，外层不动', async () => {
    await init()
    await git(project, ['switch', '-q', '-c', 'outer-review'])
    const workspace = join(project, 'middle', 'app')
    await mkdir(workspace, { recursive: true })
    await writeFile(join(project, 'outer.txt'), 'outer')
    await commitAll('outer base')
    await writeFile(join(project, 'outer.txt'), 'outer changed')
    await git(project, ['add', 'outer.txt'])
    const outerHead = (await git(project, ['rev-parse', 'HEAD'])).trim()
    const g = new GitTools({ ...host, resolve: () => ({ projectId: 'p', name: 'app', path: workspace }) }, () => {}, {
      statusReuseMs: 0,
    })
    expect(await g.status(ref)).toMatchObject({ root: resolve(project), branch: 'outer-review' })

    await init(join(project, 'middle'))
    await writeFile(join(workspace, 'inner.txt'), 'inner')
    await git(join(project, 'middle'), ['add', '-A'])
    const now = await g.status(ref)
    expect(now).toMatchObject({ root: resolve(project, 'middle'), branch: 'main' })
    expect(now.staged.map(f => f.path)).toEqual(['app/inner.txt'])
    expect(await g.commit(ref, { message: 'inner' })).toMatchObject({ ok: true })
    expect((await git(project, ['rev-parse', 'HEAD'])).trim()).toBe(outerHead)
    expect((await git(join(project, 'middle'), ['log', '-1', '--format=%s'])).trim()).toBe('inner')
  })

  it('写操作前、手动刷新时重新确认仓库根，平时的读状态用缓存', async () => {
    await init()
    await writeFile(join(project, 'a.txt'), 'x')
    const g = tools()
    await g.status(ref)
    vi.mocked(spawn).mockClear()
    await g.status(ref)
    expect(spawned('--show-toplevel')).toBe(0)
    await g.status(ref, false, true)
    expect(spawned('--show-toplevel')).toBe(1)
    await g.stage(ref, ['a.txt'])
    expect(spawned('--show-toplevel')).toBe(2)
  })
})

describe('Git 面板：撤销', () => {
  it('还原已跟踪文件；未跟踪文件只删列出的，名为 -rf 的也安全；本机移到回收站', async () => {
    await init()
    await writeFile(join(project, 'a.txt'), 'base')
    await commitAll('base')
    await writeFile(join(project, 'a.txt'), 'changed')
    await writeFile(join(project, '-rf'), 'x')
    await writeFile(join(project, 'keep.txt'), 'x')
    const g = tools()
    await expect(g.discard(ref, { paths: [], untracked: ['../outside.txt'] })).resolves.toMatchObject({ ok: false })
    const s = ok(await g.discard(ref, { paths: ['a.txt'], untracked: ['-rf'] }))
    expect(await readFile(join(project, 'a.txt'), 'utf8')).toBe('base')
    expect(trashed).toEqual([join(project, '-rf')])
    expect(s.untracked.map(f => f.path)).toEqual(['keep.txt'])
  })
  it('未跟踪的符号链接：放弃的是链接本身，指向的已跟踪文件不动', async () => {
    await init()
    await writeFile(join(project, 'main.ts'), 'source')
    await commitAll('base')
    try {
      await symlink(join(project, 'main.ts'), join(project, 'link'), 'file')
    } catch {
      return // Windows 没开开发者模式不能建符号链接
    }
    const s = ok(await tools().discard(ref, { paths: [], untracked: ['link'] }))
    expect(trashed).toEqual([join(project, 'link')])
    expect(await readFile(join(project, 'main.ts'), 'utf8')).toBe('source')
    expect(s.untracked).toEqual([])
  })
  it('没有回收站时（SSH 机器）用 git clean', async () => {
    await init()
    await writeFile(join(project, 'a.txt'), 'base')
    await commitAll('base')
    await writeFile(join(project, 'tmp.txt'), 'x')
    ok(await tools({}).discard(ref, 'all'))
    await expect(access(join(project, 'tmp.txt'))).rejects.toThrow()
  })
  it('放弃全部的文件很多（路径合起来超过 Windows 命令行上限）：分批还原、分批 git clean', async () => {
    await init()
    const names = Array.from({ length: 400 }, (_, i) => `${String(i).padStart(4, '0')}-${'x'.repeat(96)}.txt`)
    for (const n of names) await writeFile(join(project, n), 'base')
    await commitAll('base')
    for (const n of names) await writeFile(join(project, n), 'changed')
    for (const n of names) await writeFile(join(project, 'new-' + n), 'x')
    const checkouts = spawned('checkout'),
      cleans = spawned('clean')
    const s = ok(await tools({}).discard(ref, 'all'))
    expect(s.unstaged).toEqual([])
    expect(s.untracked).toEqual([])
    expect(await readFile(join(project, names[399]), 'utf8')).toBe('base')
    expect(spawned('checkout') - checkouts).toBeGreaterThan(1)
    expect(spawned('clean') - cleans).toBeGreaterThan(1)
  }, 30_000)
  it('pathBatches：每批总长不超过上限，顺序不变，单个超长的自成一批', () => {
    expect(pathBatches([], 10)).toEqual([])
    expect(pathBatches(['aa', 'bb', 'cc'], 10)).toEqual([['aa', 'bb'], ['cc']])
    expect(pathBatches(['a'.repeat(20), 'b'], 10)).toEqual([['a'.repeat(20)], ['b']])
  })
})

describe('Git 面板：提交与远端', () => {
  it('多行提交信息；提交全部包含未跟踪；没有暂存时提示', async () => {
    await init()
    await writeFile(join(project, 'a.txt'), 'base')
    await commitAll('base')
    const g = tools()
    await writeFile(join(project, 'b.txt'), 'new')
    expect(fail(await g.commit(ref, { message: 'x', all: false, push: false })).kind).toBe('nothing')
    ok(await g.commit(ref, { message: '第一行\n\n第二段 "引号" $HOME', all: true, push: false }))
    expect(await git(project, ['log', '-1', '--format=%B'])).toBe('第一行\n\n第二段 "引号" $HOME')
    expect(await git(project, ['show', '--name-only', '--format=', 'HEAD'])).toBe('b.txt')
  })
  it('发布分支设置上游；推送被拒；只快进时分叉；变基冲突后中止；暂存后拉取', async () => {
    await withRemote()
    const g = tools()
    await git(project, ['switch', '-q', '-c', 'topic'])
    await writeFile(join(project, 't.txt'), 't')
    await commitAll('topic')
    // 没有上游、只有一个远端时直接发布
    expect(ok(await g.push(ref, { publish: false })).upstream).toBe('origin/topic')
    await git(project, ['switch', '-q', 'main'])
    const other = await otherClone()
    await writeFile(join(other, 'a.txt'), 'other\n')
    await commitAll('other', other)
    await git(other, ['push', '-q'])
    await writeFile(join(project, 'a.txt'), 'mine\n')
    await commitAll('mine')
    const rejected = fail(await g.push(ref, { publish: false }))
    expect(rejected).toMatchObject({ kind: 'rejected', remedies: ['pullRebase', 'retry'] })
    expect(ok(await g.fetch(ref))).toMatchObject({ ahead: 1, behind: 1 })
    expect((await g.status(ref)).fetchedAt).toBeGreaterThan(0)
    expect(fail(await g.pull(ref, 'ff-only')).kind).toBe('diverged')
    const conflict = await g.pull(ref, 'rebase')
    expect(conflict.ok).toBe(false)
    expect(conflict.status).toMatchObject({ operation: 'rebase', conflicted: [{ path: 'a.txt' }] })
    expect(fail(await g.operation(ref, 'continue')).kind).toBe('conflict')
    expect(ok(await g.operation(ref, 'abort')).operation).toBeNull()
    // 本地有改动时只快进拉取被拒，暂存后拉取可以完成
    await git(project, ['reset', '-q', '--hard', 'origin/main'])
    await writeFile(join(other, 'c.txt'), 'c')
    await commitAll('c', other)
    await git(other, ['push', '-q'])
    await writeFile(join(project, 'a.txt'), 'dirty\n')
    const pulled = ok(await g.pull(ref, 'stash'))
    expect(pulled.behind).toBe(0)
    expect(await readFile(join(project, 'a.txt'), 'utf8')).toBe('dirty\n')
  }, 60_000)
  it('切换到远程分支会建立跟踪；非法分支名；运行中的会话阻止切换', async () => {
    await withRemote()
    const other = await otherClone()
    await git(other, ['switch', '-q', '-c', 'feature'])
    await writeFile(join(other, 'f.txt'), 'f')
    await commitAll('f', other)
    await git(other, ['push', '-q', '-u', 'origin', 'feature'])
    const g = tools()
    ok(await g.fetch(ref))
    expect((await g.branches(ref)).map(b => [b.name, b.remote, b.current])).toEqual(
      expect.arrayContaining([
        ['main', false, true],
        ['origin/feature', true, false],
      ]),
    )
    expect(ok(await g.switchBranch(ref, { branch: 'origin/feature', remote: true }))).toMatchObject({
      branch: 'feature',
      upstream: 'origin/feature',
    })
    expect(fail(await g.createBranch(ref, { name: 'bad..name' })).kind).toBe('invalid')
    expect(fail(await g.createBranch(ref, { name: '--force' })).kind).toBe('invalid')
    expect(ok(await g.createBranch(ref, { name: '新分支' })).branch).toBe('新分支')
    busy = 1
    expect(fail(await g.switchBranch(ref, { branch: 'main', remote: false })).kind).toBe('busy')
  }, 60_000)
})

describe('Git 面板：失败分类', () => {
  it('hook 拒绝；hook 卡住时超时并结束进程；index.lock 被占用', async () => {
    await init()
    await writeFile(join(project, 'a.txt'), 'base')
    await commitAll('base')
    await writeFile(join(project, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', {
      mode: 0o755,
    })
    await writeFile(join(project, 'a.txt'), 'x')
    const hooked = fail(await tools().commit(ref, { message: 'm', all: true, push: false }))
    expect(hooked.kind).toBe('hook')
    expect(hooked.detail).toContain('hook says no')
    await writeFile(join(project, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nsleep 5\n', { mode: 0o755 })
    const started = Date.now()
    expect(
      fail(await tools({ timeouts: { commit: 1500 } }).commit(ref, { message: 'm', all: true, push: false })).kind,
    ).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(15_000)
    await rm(join(project, '.git', 'hooks', 'pre-commit'))
    await rm(join(project, '.git', 'index.lock'), { force: true })
    await writeFile(join(project, '.git', 'index.lock'), '')
    expect(fail(await tools().stage(ref, 'all')).kind).toBe('locked')
  }, 60_000)
  it('连不上远端是 network；401 是 auth 且不会卡在凭据输入', async () => {
    await init()
    await writeFile(join(project, 'a.txt'), 'base')
    await commitAll('base')
    await git(project, ['remote', 'add', 'origin', 'http://127.0.0.1:9/x.git'])
    expect(fail(await tools().fetch(ref)).kind).toBe('network')
    const server: Server = createServer((_req, res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' })
      res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    try {
      const port = (server.address() as { port: number }).port
      await git(project, ['remote', 'set-url', 'origin', `http://127.0.0.1:${port}/x.git`])
      await git(project, ['config', 'credential.helper', ''])
      const started = Date.now()
      expect(fail(await tools().fetch(ref)).kind).toBe('auth')
      expect(Date.now() - started).toBeLessThan(20_000)
    } finally {
      server.close()
    }
  }, 60_000)
})

describe('压成一个提交合并（docs/ui/channels-local-rest.md §3.1）', () => {
  async function branchWith(files: Record<string, string>): Promise<void> {
    await init()
    await writeFile(join(project, 'a.txt'), 'one\n')
    await commitAll('base')
    await git(project, ['switch', '-q', '-c', 'task'])
    for (const [f, v] of Object.entries(files)) await writeFile(join(project, f), v)
    await commitAll('task 1')
    await commitAll('task 2').catch(() => {})
    await git(project, ['switch', '-q', 'main'])
  }
  const log1 = async () => (await git(project, ['log', '-1', '--format=%s'])).trim()

  it('干净合并：一个新提交，信息是给的；再合一次没有新提交', async () => {
    await branchWith({ 'b.txt': 'new\n' })
    const t = tools()
    const r = await t.squashMerge(ref, { branch: 'task', message: '改登录页' })
    expect(r).toMatchObject({ ok: true, merged: true })
    expect(await log1()).toBe('改登录页')
    expect(await readFile(join(project, 'b.txt'), 'utf8')).toBe('new\n')
    const again = await t.squashMerge(ref, { branch: 'task', message: 'x' })
    expect(again).toMatchObject({ ok: true, merged: false })
    expect(await log1()).toBe('改登录页')
  })

  it('冲突：列出文件，工作区不动', async () => {
    await branchWith({ 'a.txt': 'task\n' })
    await writeFile(join(project, 'a.txt'), 'main\n')
    await commitAll('main change')
    const r = await tools().squashMerge(ref, { branch: 'task', message: 'm' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure).toMatchObject({ kind: 'conflict', files: ['a.txt'] })
    expect(await readFile(join(project, 'a.txt'), 'utf8')).toBe('main\n')
    expect(await log1()).toBe('main change')
  })

  it('主目录有改动拒绝；没跟踪的文件撞名报出文件', async () => {
    await branchWith({ 'b.txt': 'new\n' })
    await writeFile(join(project, 'a.txt'), 'dirty\n')
    const dirty = await tools().squashMerge(ref, { branch: 'task', message: 'm' })
    expect(!dirty.ok && dirty.failure.kind).toBe('dirty')
    await git(project, ['checkout', '--', 'a.txt'])
    await writeFile(join(project, 'b.txt'), 'mine\n')
    const clash = await tools().squashMerge(ref, { branch: 'task', message: 'm' })
    expect(clash.ok).toBe(false)
    if (!clash.ok) expect(clash.failure).toMatchObject({ kind: 'dirty', files: ['b.txt'] })
    expect(await readFile(join(project, 'b.txt'), 'utf8')).toBe('mine\n')
  })

  it('配了 merge.ff=false 也能合并；主目录有会话在跑时拒绝', async () => {
    await branchWith({ 'b.txt': 'new\n' })
    await git(project, ['config', 'merge.ff', 'false'])
    busy = 1
    const blocked = await tools().squashMerge(ref, { branch: 'task', message: 'm' })
    expect(!blocked.ok && blocked.failure.kind).toBe('busy')
    busy = 0
    expect(await tools().squashMerge(ref, { branch: 'task', message: 'm' })).toMatchObject({ ok: true, merged: true })
  })

  it('提交钩子失败：撤回，主目录和合并前一样', async () => {
    await branchWith({ 'b.txt': 'new\n' })
    await mkdir(join(project, '.git', 'hooks'), { recursive: true })
    await writeFile(join(project, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const r = await tools().squashMerge(ref, { branch: 'task', message: 'm' })
    expect(!r.ok && r.failure.kind).toBe('hook')
    expect(await log1()).toBe('base')
    expect((await git(project, ['status', '--porcelain'])).trim()).toBe('')
  })
})
