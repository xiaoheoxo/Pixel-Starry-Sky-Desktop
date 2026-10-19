import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, access, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tasks } from './tasks'
import { Copies } from './copies'
import { Services, redact, childEnvironment, portStatus } from './services'
import { directory, git, JsonStore, type ToolsHost } from './common'
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
    const services = new Services(root, host, () => {})
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
    await expect(services.save({ projectId: 'p' }, { name: 'escape', command: 'node', cwd: '..' })).rejects.toThrow()
    const restored = new Services(root, host, () => {})
    managers.push(restored)
    await restored.init()
    expect(restored.list({ projectId: 'p' })[0]).toMatchObject({ name: 'test', status: 'stopped' })
  }, 30_000)
})
