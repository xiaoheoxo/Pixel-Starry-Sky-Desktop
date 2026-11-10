// 影子 Git 仓库（docs/ui/undo-changes.md §2），用真实 git
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LARGE_FILE, ShadowRepo, workPath } from '../src/checkpoints'
import { makeTmp, removeTmp } from './helpers/tmp'

let root: string
let work: string
let repo: ShadowRepo

beforeEach(() => {
  root = makeTmp('checkpoints')
  work = join(root, 'work')
  mkdirSync(work)
  repo = new ShadowRepo(join(root, 'shadow'), work)
})
afterEach(() => removeTmp(root))

const write = (path: string, text: string): void => {
  mkdirSync(join(work, path, '..'), { recursive: true })
  writeFileSync(join(work, path), text)
}

describe('ShadowRepo', () => {
  it('拍快照、比较、取回内容', async () => {
    write('a.txt', 'one\n')
    write('src/b.ts', 'export {}\n')
    const before = await repo.capture()
    write('a.txt', 'one\ntwo\n')
    write('new.txt', 'hi\n')
    const after = await repo.capture()
    const changes = await repo.diff(before, after)
    expect(changes).toEqual([
      { path: 'a.txt', status: 'modified', insertions: 1, deletions: 0 },
      { path: 'new.txt', status: 'added', insertions: 1, deletions: 0 },
    ])
    expect((await repo.blob(before, 'a.txt'))?.toString()).toBe('one\n')
    expect(await repo.blob(before, 'new.txt')).toBeNull()
    // 没有变化时树 id 相同
    expect(await repo.capture()).toBe(after)
  })

  it('默认排除依赖目录，也跟着项目的 .gitignore', async () => {
    write('.gitignore', 'secret.env\n')
    write('node_modules/x/index.js', 'x\n')
    write('secret.env', 'k=v\n')
    write('keep.txt', 'k\n')
    const tree = await repo.capture()
    expect(await repo.blob(tree, 'keep.txt')).not.toBeNull()
    expect(await repo.blob(tree, 'secret.env')).toBeNull()
    expect(await repo.ignored(['secret.env', 'node_modules/x/index.js', 'keep.txt'])).toEqual(
      new Set(['secret.env', 'node_modules/x/index.js']),
    )
  })

  it('项目是 Git 仓库时借它的对象库，不碰项目自己的索引和提交', async () => {
    write('a.txt', 'committed\n')
    const git = (...args: string[]): string =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: work, encoding: 'utf8' })
    git('init', '--quiet')
    git('add', '.')
    git('commit', '--quiet', '-m', 'init')
    const head = git('rev-parse', 'HEAD')
    write('b.txt', 'untracked\n')
    const tree = await repo.capture()
    expect(readFileSync(join(root, 'shadow', 'objects', 'info', 'alternates'), 'utf8')).toContain('objects')
    expect((await repo.blob(tree, 'b.txt'))?.toString()).toBe('untracked\n')
    expect((await repo.blob(tree, 'a.txt'))?.toString()).toBe('committed\n')
    // 项目的状态不变：b.txt 仍是未跟踪，HEAD 没动
    expect(git('status', '--porcelain')).toBe('?? b.txt\n')
    expect(git('rev-parse', 'HEAD')).toBe(head)
  })

  it('大小和删除', async () => {
    write('a.txt', randomBytes(20_000).toString('hex'))
    await repo.capture()
    expect(await repo.size()).toBeGreaterThan(0)
    await repo.destroy()
    expect(existsSync(join(root, 'shadow'))).toBe(false)
  })

  it('不按项目的 .gitattributes 转换换行、不跑过滤器：取回的内容和磁盘上一字不差', async () => {
    write('.gitattributes', '* text=auto eol=lf\n*.bin filter=lfs diff=lfs merge=lfs -text\n')
    write('crlf.txt', 'a\r\nb\r\n')
    write('data.bin', 'raw\n')
    const tree = await repo.capture()
    expect((await repo.blob(tree, 'crlf.txt'))?.toString()).toBe('a\r\nb\r\n')
    expect((await repo.blob(tree, 'data.bin'))?.toString()).toBe('raw\n')
  })

  it('上次超时留下的索引锁不挡下一次快照', async () => {
    write('a.txt', 'a\n')
    await repo.capture()
    writeFileSync(join(root, 'shadow', 'index.lock'), '')
    write('a.txt', 'b\n')
    const tree = await repo.capture()
    expect((await repo.blob(tree, 'a.txt'))?.toString()).toBe('b\n')
  })

  it('空的 refs/ 被复制、同步工具丢掉（git 报 not a git repository）：自动补上，原来的快照照样能用', async () => {
    write('a.txt', 'one\n')
    const before = await repo.capture()
    write('a.txt', 'two\n')
    // 运行中被删（ready 已经是 true）
    rmSync(join(root, 'shadow', 'refs'), { recursive: true })
    const after = await repo.capture()
    expect(await repo.diff(before, after)).toEqual([{ path: 'a.txt', status: 'modified', insertions: 1, deletions: 1 }])
    // 重新打开软件后（新的 ShadowRepo）
    rmSync(join(root, 'shadow', 'refs'), { recursive: true })
    const reopened = new ShadowRepo(join(root, 'shadow'), work)
    expect((await reopened.blob(before, 'a.txt'))?.toString()).toBe('one\n')
    // HEAD 也没了：重新初始化，对象还在
    rmSync(join(root, 'shadow', 'HEAD'))
    const again = new ShadowRepo(join(root, 'shadow'), work)
    expect((await again.blob(after, 'a.txt'))?.toString()).toBe('two\n')
  })

  it('借来的项目对象被项目的 git 清理掉（改写历史后 gc）：查得出快照缺了内容', async () => {
    const g = (...args: string[]): string =>
      execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=a', ...args], { cwd: work }).toString()
    g('init', '-q')
    write('a.txt', 'v1\n')
    write('src/b.txt', 'b\n')
    g('add', '.')
    g('commit', '-qm', 'one')
    // 没提交的文件让根树存在影子仓库里，src/ 的树和 a.txt 的内容是借来的
    write('extra.txt', 'x\n')
    const before = await repo.capture()
    expect(existsSync(join(root, 'shadow', 'objects', before.slice(0, 2), before.slice(2)))).toBe(true)
    expect(await repo.incomplete(before)).toBe(false)
    write('a.txt', 'v2\n')
    write('src/b.txt', 'b2\n')
    g('add', 'a.txt', 'src')
    g('commit', '-q', '--amend', '-m', 'one')
    g('reflog', 'expire', '--expire=now', '--all')
    g('gc', '-q', '--prune=now')
    const after = await repo.capture()
    expect(await repo.incomplete(before)).toBe(true)
    expect(await repo.incomplete(after)).toBe(false)
    // 整个影子仓库被删过：重建后旧的树不在
    rmSync(join(root, 'shadow'), { recursive: true })
    expect(await new ShadowRepo(join(root, 'shadow'), work).incomplete(after)).toBe(true)
  })

  // docs/ui/checkpoint-disk.md
  it('被结束的 git 留下的半截文件：算进大小，下次拍快照前清掉', async () => {
    write('a.txt', 'one\n')
    await repo.capture()
    const pack = join(root, 'shadow', 'objects', 'pack', 'tmp_pack_AbCdEf')
    const loose = join(root, 'shadow', 'objects', 'ab', 'tmp_obj_XyZ123')
    mkdirSync(join(pack, '..'), { recursive: true })
    mkdirSync(join(loose, '..'), { recursive: true })
    writeFileSync(pack, randomBytes(2_000_000))
    writeFileSync(loose, randomBytes(1_000_000))
    // 以前只算 size + size-pack：残留再大也不到上限
    expect(await repo.size()).toBeGreaterThan(2_900_000)
    write('a.txt', 'two\n')
    const tree = await repo.capture()
    expect(existsSync(pack)).toBe(false)
    expect(existsSync(loose)).toBe(false)
    expect((await repo.blob(tree, 'a.txt'))?.toString()).toBe('two\n')
    expect(await repo.size()).toBeLessThan(1_000_000)
    // 定时清理走 sweep：返回删掉的字节数
    writeFileSync(pack, randomBytes(500_000))
    expect(await repo.sweep()).toBe(500_000)
    // 用户的 git 开了 core.fsyncMethod=batch：半截文件在 objects/tmp_objdir-* 里，count-objects 不算它
    const bulk = join(root, 'shadow', 'objects', 'tmp_objdir-bulk-fsync-AbC123')
    mkdirSync(join(bulk, 'ab'), { recursive: true })
    writeFileSync(join(bulk, 'ab', 'tmp_obj_1'), randomBytes(300_000))
    expect(await repo.sweep()).toBe(300_000)
    expect(existsSync(bulk)).toBe(false)
  })

  // 时限放宽：要真的结束一个 git、等它退出，机器忙时超过默认的 5 秒
  it('拍到一半超时被结束：等 git 真正退出，不留索引锁和半截文件，下一次照样能拍', { timeout: 30_000 }, async () => {
    for (let i = 0; i < 3; i++) writeFileSync(join(work, `data${i}.bin`), randomBytes(20_000_000))
    // 300 毫秒：git 已经在写对象了（20 MB 的随机内容一个要压 0.4 秒左右）
    await expect(repo.capture(300)).rejects.toThrow('超时')
    const shadow = join(root, 'shadow')
    expect(existsSync(join(shadow, 'index.lock'))).toBe(false)
    const leftovers = readdirSync(join(shadow, 'objects'), { recursive: true }).filter(name =>
      /(^|[\\/])tmp_/.test(String(name)),
    )
    expect(leftovers).toEqual([])
    // 下一次换成小文件：只看还能不能拍，不用再把大文件算一遍
    for (let i = 0; i < 3; i++) rmSync(join(work, `data${i}.bin`))
    write('a.txt', 'one\n')
    const tree = await repo.capture()
    expect((await repo.blob(tree, 'a.txt'))?.toString()).toBe('one\n')
  })

  it('默认不存视频、压缩包、模型权重这类大文件（不分大小写）', async () => {
    write('src/a.ts', 'export {}\n')
    write('media/clip.mp4', 'video')
    write('media/CLIP.MOV', 'video')
    write('weights/model.safetensors', 'weights')
    write('notes.zip.txt', 'text')
    const tree = await repo.capture()
    expect(await repo.blob(tree, 'src/a.ts')).not.toBeNull()
    expect(await repo.blob(tree, 'notes.zip.txt')).not.toBeNull()
    for (const path of ['media/clip.mp4', 'media/CLIP.MOV', 'weights/model.safetensors'])
      expect(await repo.blob(tree, path)).toBeNull()
    expect([...(await repo.ignored(['media/clip.mp4', 'src/a.ts']))]).toEqual(['media/clip.mp4'])
  })

  it('旧版本建的影子仓库也用上新的默认排除', async () => {
    write('a.txt', 'one\n')
    await repo.capture()
    writeFileSync(join(root, 'shadow', 'info', 'exclude'), 'node_modules/\n')
    write('clip.mp4', 'video')
    const tree = await new ShadowRepo(join(root, 'shadow'), work).capture()
    expect(await repo.blob(tree, 'clip.mp4')).toBeNull()
  })

  it('单个文件超过 50 MB 不存：新文件不进快照；存过的小文件变大后从快照里拿掉，不算成被删', async () => {
    write('small.bin', 'v1')
    write('data [1].bin', 'v1')
    const first = await repo.capture()
    truncateSync(join(work, 'small.bin'), LARGE_FILE + 1)
    writeFileSync(join(work, 'huge.dat'), '')
    truncateSync(join(work, 'huge.dat'), LARGE_FILE + 1)
    write('data [1].bin', 'v2')
    const second = await repo.capture()
    expect(await repo.blob(second, 'huge.dat')).toBeNull()
    expect(await repo.blob(second, 'small.bin')).toBeNull()
    // 旧快照里的版本还在
    expect((await repo.blob(first, 'small.bin'))?.toString()).toBe('v1')
    expect((await repo.diff(first, second)).map(c => c.path)).toEqual(['data [1].bin'])
    expect((await repo.ignored(['huge.dat', 'small.bin', 'data [1].bin'])).size).toBe(2)
    // 换一个实例（重启）还记得
    const again = new ShadowRepo(join(root, 'shadow'), work)
    const third = await again.capture()
    expect((await again.diff(first, third)).map(c => c.path)).toEqual(['data [1].bin'])
    expect(await repo.size()).toBeLessThan(1_000_000)
  })

  it('工作目录外的路径', () => {
    expect(workPath(work, join(work, 'src', 'a.ts'))).toBe('src/a.ts')
    expect(workPath(work, 'src/a.ts')).toBe('src/a.ts')
    expect(workPath(work, join(root, 'other.txt'))).toBeNull()
  })
})
