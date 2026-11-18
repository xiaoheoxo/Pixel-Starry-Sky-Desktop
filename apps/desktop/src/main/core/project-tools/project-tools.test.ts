import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, access, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tasks } from './tasks'
import { Copies, busyMessage } from './copies'
import { parseHolders, shallowFiles } from './holders'
import { Services, redact, childEnvironment, portStatus } from './services'
import { directory, git, JsonStore, type ToolsHost } from './common'
import { issueJustDone } from '../../../shared/channels/wakeup'
let root: string, project: string, host: ToolsHost
const managers: Services[] = []
beforeEach(async () => {
  const scratch = resolve('../../scratch')
  await mkdir(scratch, { recursive: true })
  root = await mkdtemp(join(scratch, 'tools-unit-'))
  project = join(root, 'project')
  await mkdir(project)
  host = {
    resolve(ref) {
      if (ref.projectId !== 'p') throw new Error('unknown')
      return { projectId: 'p', name: 'test', path: project }
    },
    plans: () => [],
    sessions: () => [],
    create: (id, cwd) => ({ id: 's', projectId: id, cwd }) as ReturnType<ToolsHost['create']>,
    withStopped: async (_path, action) => action(),
  }
})
afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map(m => m.shutdown()))
  await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
})
describe('project tools storage and task operations', () => {
  it('serializes task writes, editing/reorder persist and unknown projects are rejected', async () => {
    const tasks = new Tasks(root, host, () => {})
    await tasks.init()
    const [a, b] = await Promise.all([tasks.create('p', { title: 'A' }), tasks.create('p', { title: 'B' })])
    await tasks.update(a.id, { status: 'in_progress', note: 'note', due: '2026-10-09', tags: ['tag'] })
    await tasks.reorder('p', [b.id, a.id])
    const restored = new Tasks(root, host, () => {})
    await restored.init()
    expect((await restored.state('p')).tasks.map(t => t.id)).toEqual([b.id, a.id])
    expect((await restored.state('p')).tasks[1]).toMatchObject({ status: 'in_progress', tags: ['tag'] })
    await expect(tasks.create('not-p', { title: 'bad' })).rejects.toThrow('unknown')
    await expect(tasks.reorder('p', [a.id, a.id])).rejects.toThrow()
  })
  it('pins tasks to the sidebar, keeps pins across edits and restarts, lists only known projects', async () => {
    const tasks = new Tasks(root, host, () => {})
    await tasks.init()
    const a = await tasks.create('p', { title: 'A' }),
      b = await tasks.create('p', { title: 'B' })
    // 把时钟停住：两个固定落在同一毫秒时（GitHub 的机器上出现过）也要按固定先后排
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    await tasks.pin(b.id, true)
    await tasks.pin(a.id, true)
    now.mockRestore()
    const first = tasks.pinned()
    expect(first.map(t => t.id)).toEqual([b.id, a.id])
    // 再固定一次不改固定时间（顺序不变），编辑不丢固定
    await tasks.pin(b.id, true)
    await tasks.update(b.id, { title: 'B2' })
    expect(tasks.pinned().map(t => [t.id, t.title])).toEqual([
      [b.id, 'B2'],
      [a.id, 'A'],
    ])
    await tasks.pin(a.id, false)
    const restored = new Tasks(root, host, () => {})
    await restored.init()
    expect(restored.pinned().map(t => t.id)).toEqual([b.id])
    await expect(tasks.pin('missing', true)).rejects.toThrow('tasks.notFound')
    // 项目被移除后不再列出
    restored.store.data.tasks[1].projectId = 'gone'
    expect(restored.pinned()).toEqual([])
  })
  it('lists every task for the board and records when a task was completed', async () => {
    const tasks = new Tasks(root, host, () => {})
    await tasks.init()
    const a = await tasks.create('p', { title: 'A' }),
      b = await tasks.create('p', { title: 'B', status: 'completed' })
    expect(a.completedAt).toBeNull()
    expect(b.completedAt).toBeGreaterThan(0)
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000)
    await tasks.update(a.id, { status: 'completed' })
    now.mockReturnValue(6_000)
    // 已完成的再编辑不改完成时间；改回未完成清掉
    await tasks.update(a.id, { title: 'A2' })
    expect(tasks.all().find(t => t.id === a.id)).toMatchObject({ title: 'A2', completedAt: 5_000 })
    await tasks.update(b.id, { status: 'in_progress' })
    now.mockRestore()
    expect(tasks.all().map(t => [t.id, t.completedAt])).toEqual([
      [a.id, 5_000],
      [b.id, null],
    ])
    tasks.store.data.tasks[1].projectId = 'gone'
    expect(tasks.all().map(t => t.id)).toEqual([a.id])
  })
  it('事项：负责人、验收标准校验后存下；派出的卡片写回状态，验收完成的不再改，重新派过后旧卡不管', async () => {
    const tasks = new Tasks(root, host, () => {})
    await tasks.init()
    const assignee = { channelId: 'c1', memberId: 'm1', name: '前端' }
    const a = await tasks.create('p', {
      title: 'A',
      assignee,
      acceptance: [
        { text: ' 能登录 ', done: false },
        { text: '', done: true },
      ],
    })
    expect(a).toMatchObject({ assignee, acceptance: [{ text: '能登录', done: false }], link: null })
    await expect(tasks.update(a.id, { status: 'nope' as never })).rejects.toThrow('参数不正确')
    await expect(tasks.update(a.id, { assignee: { channelId: 'c1' } as never })).rejects.toThrow()
    const link = (taskId: string, state: string) => ({ channelId: 'c1', taskId, state, round: 1, checks: null, at: 1 })
    await tasks.syncIssue(a.id, { link: link('k1', 'running'), status: 'in_progress', fresh: true })
    expect(tasks.all()[0]).toMatchObject({ status: 'in_progress', link: { taskId: 'k1', state: 'running' } })
    await tasks.syncIssue(a.id, {
      link: { ...link('k1', 'done'), checks: { status: 'fail', problems: 2 } },
      status: 'review',
    })
    expect(tasks.all()[0]).toMatchObject({ status: 'review', link: { checks: { status: 'fail', problems: 2 } } })
    // 别的卡（不是刚派的）不认
    expect(await tasks.syncIssue(a.id, { link: link('old', 'failed') })).toBeNull()
    await tasks.update(a.id, { status: 'completed' })
    await tasks.syncIssue(a.id, { link: link('k1', 'running'), status: 'in_progress' })
    expect(tasks.all()[0]).toMatchObject({ status: 'completed', link: { state: 'running' } })
    // 编辑别的字段不丢事项的字段
    await tasks.update(a.id, { title: 'A2' })
    expect(tasks.all()[0]).toMatchObject({ title: 'A2', assignee, link: { taskId: 'k1' } })
    expect(await tasks.syncIssue('missing', { link: link('k1', 'done') })).toBeNull()
  })
  it('事项刚改成完成：认出派出去的那张卡（挂在上面的唤醒一起取消，docs/multica-learn.md §11.6）；本来就完成的、没派过的不认', async () => {
    const tasks = new Tasks(root, host, () => {})
    await tasks.init()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const a = await tasks.create('p', { title: 'A' })
    const plain = await tasks.create('p', { title: 'B' })
    const link = { channelId: 'c1', taskId: 'k1', state: 'done', round: 1, checks: null, at: 1 }
    await tasks.syncIssue(a.id, { link, status: 'review', fresh: true })
    now.mockReturnValue(2_000)
    expect(issueJustDone(await tasks.update(a.id, { status: 'completed' }))).toEqual({ channelId: 'c1', taskId: 'k1' })
    expect(issueJustDone(await tasks.update(plain.id, { status: 'completed' }))).toBeNull()
    now.mockReturnValue(3_000)
    expect(issueJustDone(await tasks.update(a.id, { title: 'A2', status: 'completed' }))).toBeNull()
    now.mockRestore()
  })
  it('failed snapshots restore state and keep live object references', async () => {
    const store = new JsonStore(join(root, 'data.json'), { tasks: [{ id: 'a', title: 'before' }] })
    await store.init()
    const ref = store.data.tasks[0]
    await expect(
      store.transaction(() => {
        ref.title = 'bad'
        throw Error('fail')
      }),
    ).rejects.toThrow()
    expect(store.data.tasks[0]).toBe(ref)
    expect(ref.title).toBe('before')
  })
  it('resolves real directories and blocks a junction outside the project', async () => {
    const outside = join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, join(project, 'link'), 'junction')
    await expect(directory(project, '../outside')).rejects.toThrow()
    await expect(directory(project, 'link')).rejects.toThrow()
    expect(await directory(project, '')).toBe(project)
  })
})
describe('real git worktrees', () => {
  async function setup() {
    await git(project, ['init', '-b', 'main'])
    await git(project, ['config', 'user.email', 'tools@example.invalid'])
    await git(project, ['config', 'user.name', 'Tools test'])
    await writeFile(join(project, 'tracked.txt'), 'base')
    await git(project, ['add', '.'])
    await git(project, ['commit', '-m', 'fixture'])
    const copies = new Copies(
      root,
      host,
      () => {},
      async () => {},
    )
    await copies.init()
    return copies
  }
  it('creates isolated worktree, binds session cwd, detects dirty state and protects deletion', async () => {
    const copies = await setup()
    const input = {
      name: 'copy',
      branch: 'pixelsky/copy',
      existingBranch: false,
      base: 'HEAD',
      directory: join(root, 'copy'),
    }
    const preview = await copies.preview('p', input)
    expect(preview.commit).toMatch(/^[a-f0-9]{40}$/)
    const copy = await copies.create('p', input)
    expect(await readFile(join(copy.path, 'tracked.txt'), 'utf8')).toBe('base')
    expect((await copies.open(copy.id)).cwd).toBe(copy.path)
    await writeFile(join(copy.path, 'tracked.txt'), 'changed')
    expect((await copies.list('p'))[0].dirty).toBe(true)
    expect(await readFile(join(project, 'tracked.txt'), 'utf8')).toBe('base')
    await expect(copies.remove(copy.id)).rejects.toThrow('未提交')
    await copies.remove(copy.id, true)
    expect(await copies.list('p')).toEqual([])
    expect(await readFile(join(project, 'tracked.txt'), 'utf8')).toBe('base')
  })
  it('rejects Git option injection and existing destination without overwriting it', async () => {
    const copies = await setup(),
      path = join(root, 'existing')
    await mkdir(path)
    await writeFile(join(path, 'keep'), 'safe')
    await expect(
      copies.create('p', { name: 'bad', branch: '--force', existingBranch: false, base: 'HEAD' }),
    ).rejects.toThrow()
    await expect(
      copies.create('p', { name: 'bad', branch: 'new', existingBranch: false, base: 'HEAD', directory: path }),
    ).rejects.toThrow('已经存在')
    expect(await readFile(join(path, 'keep'), 'utf8')).toBe('safe')
  })
})
describe('leftover worktree directories (GitHub #37)', () => {
  async function setup() {
    await git(project, ['init', '-b', 'main'])
    await git(project, ['config', 'user.email', 'tools@example.invalid'])
    await git(project, ['config', 'user.name', 'Tools test'])
    await writeFile(join(project, 'tracked.txt'), 'base')
    await git(project, ['add', '.'])
    await git(project, ['commit', '-m', 'fixture'])
    const copies = new Copies(
      root,
      host,
      () => {},
      async () => {},
    )
    await copies.init()
    return copies
  }
  const input = (name: string) => ({
    name,
    branch: 'pixelsky/' + name,
    existingBranch: false,
    base: 'HEAD',
    directory: join(root, name),
  })
  const exists = (path: string) =>
    access(path).then(
      () => true,
      () => false,
    )
  // 把工作树从 Git 里注销但留下目录，就是「目录被占用，git 只删了一半」之后的状态
  async function unregister(copies: Copies, id: string) {
    const path = copies.get(id).path
    await git(project, ['worktree', 'remove', '--force', '--', path])
    return path
  }
  it('removes an unregistered copy whose directory is gone or empty, then recreates it', async () => {
    const copies = await setup()
    const copy = await copies.create('p', input('a'))
    const path = await unregister(copies, copy.id)
    await mkdir(path, { recursive: true })
    expect((await copies.list('p'))[0].error).toBeTruthy()
    await copies.remove(copy.id)
    expect(copies.store.data.copies).toEqual([])
    expect(await exists(path)).toBe(false)
    const again = await copies.create('p', { ...input('a'), branch: 'pixelsky/a2' })
    expect(await readFile(join(again.path, 'tracked.txt'), 'utf8')).toBe('base')
    // directory already missing
    const gone = await unregister(copies, again.id)
    expect(await exists(gone)).toBe(false)
    await copies.remove(again.id)
    expect(copies.store.data.copies).toEqual([])
  })
  it('asks for a second confirmation before deleting a non-empty leftover directory', async () => {
    const copies = await setup()
    const copy = await copies.create('p', input('b'))
    const path = await unregister(copies, copy.id)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'mine.txt'), 'keep me')
    await expect(copies.remove(copy.id)).rejects.toThrow('残留目录不是空的')
    expect(copies.store.data.copies).toHaveLength(1)
    expect(await readFile(join(path, 'mine.txt'), 'utf8')).toBe('keep me')
    await copies.remove(copy.id, true)
    expect(copies.store.data.copies).toEqual([])
    expect(await exists(path)).toBe(false)
    expect(await readFile(join(project, 'tracked.txt'), 'utf8')).toBe('base')
  })
  it('creates a copy into an existing empty directory but not a non-empty one', async () => {
    const copies = await setup()
    const empty = join(root, 'empty')
    await mkdir(empty)
    const copy = await copies.create('p', input('empty'))
    expect(await readFile(join(copy.path, 'tracked.txt'), 'utf8')).toBe('base')
    const full = join(root, 'full')
    await mkdir(full)
    await writeFile(join(full, 'x'), 'x')
    await expect(copies.create('p', input('full'))).rejects.toThrow('可能是上次删除没清干净')
    expect(await readdir(full)).toEqual(['x'])
  })
  it.runIf(process.platform === 'win32')(
    'reports a held directory, then removes it once released',
    async () => {
      const copies = await setup()
      const copy = await copies.create('p', input('held'))
      const holder = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: copy.path, windowsHide: true })
      await new Promise(r => setTimeout(r, 500))
      try {
        await expect(copies.remove(copy.id, true)).rejects.toThrow(/被占用|failed to delete|Permission/)
      } finally {
        holder.kill()
        await new Promise(r => holder.once('exit', r))
      }
      await copies.remove(copy.id, true)
      expect(copies.store.data.copies).toEqual([])
      expect(await exists(copy.path)).toBe(false)
      const again = await copies.create('p', { ...input('held'), branch: 'pixelsky/held2' })
      expect(await readFile(join(again.path, 'tracked.txt'), 'utf8')).toBe('base')
    },
    60_000,
  )
  // 另开进程开着深层的一个文件，不允许别人删除（Java 在 Windows 上打开文件就是这样，Gradle 守护进程开着 build 里的文件）。
  // Node 自己打开文件时允许删除，挡不住删除，模拟不出来
  async function holdFile(file: string) {
    const holder = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$h = [IO.File]::Open('${file.replaceAll("'", "''")}', 'Open', 'Read', 'Read'); 'ready'; Start-Sleep 600`,
      ],
      { windowsHide: true },
    )
    await new Promise(r => holder.stdout.once('data', r))
    return {
      pid: holder.pid!,
      release: async () => {
        holder.kill()
        await new Promise(r => holder.once('exit', r))
      },
    }
  }
  const deep = (base: string) => join(base, 'build', 'classes', 'java', 'main', 'com', 'example', 'deep')
  it.runIf(process.platform === 'win32')(
    'refuses quickly before deleting anything when a deep file is held, and names the holder',
    async () => {
      const copies = await setup()
      const copy = await copies.create('p', input('locked'))
      // 像 runClient 的游戏开着 run/logs 的日志：前面有几百个 .class，查占用时也要找得到它
      await mkdir(deep(copy.path), { recursive: true })
      await Promise.all(Array.from({ length: 300 }, (_, i) => writeFile(join(deep(copy.path), `C${i}.class`), 'x')))
      await mkdir(join(copy.path, 'run', 'logs'), { recursive: true })
      const file = join(copy.path, 'run', 'logs', 'latest.log')
      await writeFile(file, 'x')
      const held = await holdFile(file)
      try {
        const started = Date.now()
        const error = await copies.remove(copy.id, true).then(
          () => null,
          (e: Error) => e,
        )
        expect(error?.message).toContain('被占用')
        expect(error?.message).toContain(`PID ${held.pid}`)
        expect(Date.now() - started).toBeLessThan(15_000)
        // 一个文件都没删，副本仍然有效
        expect(await readFile(join(copy.path, 'tracked.txt'), 'utf8')).toBe('base')
        expect((await copies.list('p'))[0].error).toBeNull()
      } finally {
        await held.release()
      }
      await copies.remove(copy.id, true)
      expect(await exists(copy.path)).toBe(false)
    },
    60_000,
  )
  it.runIf(process.platform === 'win32')(
    'gives up on a held leftover directory within the time limit instead of hanging',
    async () => {
      const copies = await setup()
      const copy = await copies.create('p', input('stuck'))
      const path = await unregister(copies, copy.id)
      await mkdir(deep(path), { recursive: true })
      const file = join(deep(path), 'A.class')
      await writeFile(file, 'x')
      const held = await holdFile(file)
      try {
        const started = Date.now()
        await expect(copies.remove(copy.id, true)).rejects.toThrow('被占用')
        expect(Date.now() - started).toBeLessThan(15_000)
        expect(await exists(file)).toBe(true)
        expect(copies.store.data.copies).toHaveLength(1)
      } finally {
        await held.release()
      }
      await copies.remove(copy.id, true)
      expect(copies.store.data.copies).toEqual([])
      expect(await exists(path)).toBe(false)
    },
    60_000,
  )
  it('lists shallow files first and stops at the limit', async () => {
    const base = join(root, 'tree')
    await mkdir(join(base, 'a', 'b', 'c'), { recursive: true })
    await writeFile(join(base, 'a', 'b', 'c', 'deep.txt'), 'x')
    await writeFile(join(base, 'a', 'mid.txt'), 'x')
    await writeFile(join(base, 'z.txt'), 'x')
    expect(await shallowFiles(base)).toEqual([
      join(base, 'z.txt'),
      join(base, 'a', 'mid.txt'),
      join(base, 'a', 'b', 'c', 'deep.txt'),
    ])
    expect(await shallowFiles(base, 2)).toHaveLength(2)
    expect(await shallowFiles(join(root, 'missing'))).toEqual([])
  })
  it('names the holding programs and hints at the Gradle daemon only for java with .gradle', () => {
    const java = [{ pid: 12, name: 'java.exe' }]
    expect(busyMessage('C:\\w', java, true)).toContain('java.exe（PID 12）')
    expect(busyMessage('C:\\w', java, true)).toContain('gradlew --stop')
    expect(busyMessage('C:\\w', java, false)).not.toContain('gradlew')
    expect(busyMessage('C:\\w', [{ pid: 3, name: 'code.exe' }], true)).not.toContain('gradlew')
    expect(busyMessage('C:\\w')).toContain('关掉在这个目录里打开的终端或程序')
    expect(parseHolders('12\tjava.exe\r\n12\tjava.exe\r\nbad\n0\tx\n7\t?\n')).toEqual([
      { pid: 12, name: 'java.exe' },
      { pid: 7, name: '?' },
    ])
  })
})
describe('local services', () => {
  it('detects occupied ports, suggests a free port and validates env names', async () => {
    const server = createServer()
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      const status = await portStatus(port)
      expect(status.occupied).toBe(true)
      expect(status.suggested).not.toBe(port)
    } finally {
      await new Promise<void>(r => server.close(() => r()))
    }
    expect(() => childEnvironment(['NODE_OPTIONS'], null)).toThrow()
    expect(redact('Bearer abcdsecret password=private secret-value', ['secret-value'])).not.toContain('secret-value')
  })
  it('persists definitions, runs a real process, reports exit and excludes secrets', async () => {
    // 输出只走 outputChanged（只有显示输出的地方重取），状态变化（启动、退出）才走 changed
    const calls: string[] = []
    const services = new Services(
      root,
      host,
      () => calls.push('state'),
      async () => {},
      () => calls.push('output'),
    )
    managers.push(services)
    await services.init()
    await writeFile(join(project, 'service.cjs'), "console.log('service-ready');setTimeout(()=>process.exit(0),200)")
    const service = await services.save({ projectId: 'p' }, { name: 'test', command: 'node service.cjs' })
    const started = await services.start(service.id)
    expect(started.status).toBe('running')
    // GitHub 的 Windows 机器上启动 node 偶尔要好几秒（0.1.5-beta 发版时 6 秒内还没退出），多等一会儿
    const until = Date.now() + 20_000
    while (services.get(service.id).status === 'running' && Date.now() < until)
      await new Promise(r => setTimeout(r, 50))
    expect(services.get(service.id)).toMatchObject({ status: 'stopped', exitCode: 0, pid: null })
    expect(services.get(service.id).output).toContain('service-ready')
    expect(calls).toContain('output')
    expect(calls.filter(c => c === 'state').length).toBeGreaterThan(0)
    await expect(services.save({ projectId: 'p' }, { name: 'escape', command: 'node', cwd: '..' })).rejects.toThrow()
    const restored = new Services(root, host, () => {})
    managers.push(restored)
    await restored.init()
    expect(restored.list({ projectId: 'p' })[0]).toMatchObject({ name: 'test', status: 'stopped' })
  }, 30_000)
})
