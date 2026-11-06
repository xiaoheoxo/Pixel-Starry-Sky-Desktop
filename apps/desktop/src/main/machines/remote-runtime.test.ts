import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REMOTE_PROTOCOL, parseCodedError, type EngineInfo } from '@pixelsky/protocol'
import { createRemoteRuntime, remotePixelReason, withRemotePixelReason } from './remote-runtime'

// 远端辅助进程的方法表：用假的 RPC 对端直接调用，确认远端行为（docs/restructure.md §8.3 P6）
let root: string, project: string
let runtime: Awaited<ReturnType<typeof createRemoteRuntime>>
const events: [string, unknown][] = []

beforeEach(async () => {
  const scratch = resolve('../../scratch')
  await mkdir(scratch, { recursive: true })
  root = await mkdtemp(join(scratch, 'remote-runtime-'))
  project = join(root, 'project')
  await mkdir(project)
  events.length = 0
  runtime = await createRemoteRuntime(
    {
      call: async () => {
        throw new Error('no desktop in tests')
      },
      event: (channel: string, value: unknown) => events.push([channel, value]),
      handle: () => {},
    },
    join(root, 'data'),
  )
})
afterEach(async () => {
  await runtime.close()
  await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 远端返回的 JSON 结构因接口而异，改成 unknown 要在上百处断言里逐个收窄
const call = <T = any>(method: string, ...args: unknown[]): Promise<T> => runtime.call(method, args) as Promise<T>

describe('remote runtime', () => {
  it('answers the handshake and rejects unknown methods', async () => {
    const hello = await call('hello')
    expect(hello).toMatchObject({ protocol: REMOTE_PROTOCOL, node: process.versions.node })
    await expect(call('engine:nothing')).rejects.toThrow('REMOTE_UNSUPPORTED: engine:nothing')
    await expect(call('toString')).rejects.toThrow('REMOTE_UNSUPPORTED')
  })

  it('stats 返回内存和进程数', async () => {
    const stats = await call('stats')
    expect(stats.rssMb).toBeGreaterThan(0)
    expect(stats.processes).toBeGreaterThanOrEqual(1)
  })

  it('tunnel:listen 经方法表路由，返回可用端口', async () => {
    const port = await call<number>('tunnel:listen')
    expect(port).toBeGreaterThan(0)
  })

  it('lists directories', async () => {
    await mkdir(join(project, 'b'))
    await mkdir(join(project, 'a'))
    await writeFile(join(project, 'file.txt'), '')
    const listing = await call('directories', project)
    expect(listing.directories).toEqual(['a', 'b'])
    expect(listing.parent).toBe(resolve(project, '..'))
  })

  it('manages projects and sessions', async () => {
    const added = await call('engine:addProject', project)
    expect(added).toMatchObject({ name: 'project', path: project })
    expect(await call('engine:addProject', project)).toEqual(added)
    await call('engine:renameProject', added.id, 'Renamed')
    expect((await call('engine:projects'))[0].name).toBe('Renamed')
    const session = await call('engine:createSession', { projectId: added.id })
    expect(session).toMatchObject({ projectId: added.id, cwd: project })
    await call('engine:renameSession', session.id, 'Hello')
    expect((await call('engine:sessions')).map((s: { record: { title: string } }) => s.record.title)).toEqual(['Hello'])
    await expect(call('engine:createSession', { projectId: added.id, workspaceSessionId: 'missing' })).rejects.toThrow(
      '工作区不属于项目',
    )
    await call('engine:deleteSession', session.id)
    expect(await call('engine:sessions')).toEqual([])
    await call('engine:removeProject', added.id)
    expect(await call('engine:projects')).toEqual([])
  })

  it('lists the project workspace and reads files', async () => {
    const added = await call('engine:addProject', project)
    // scratch 在仓库里，分支取决于外层仓库，不断言
    expect(await call('workspaces', added.id)).toMatchObject([
      { projectId: added.id, name: 'project', path: project, copyId: null, error: null },
    ])
    await writeFile(join(project, 'a.txt'), 'hello')
    const ref = { projectId: added.id }
    expect((await call('files:list', ref, '')).entries.map((e: { name: string }) => e.name)).toEqual(['a.txt'])
    const doc = await call('files:read', ref, 'a.txt')
    expect(doc).toMatchObject({ kind: 'text', content: 'hello' })
    await expect(call('files:read', ref, '../outside')).rejects.toThrow()
  })

  it('reads an image from the remote session workspace as image data for the desktop', async () => {
    const added = await call('engine:addProject', project)
    const session = await call('engine:createSession', { projectId: added.id })
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII='
    await writeFile(join(project, 'screen.png'), Buffer.from(data, 'base64'))
    expect(await call('files:read', { sessionId: session.id }, 'screen.png')).toEqual({
      kind: 'image',
      path: 'screen.png',
      dataUrl: `data:image/png;base64,${data}`,
      bytes: Buffer.from(data, 'base64').length,
    })
  })

  it('keeps manual tasks per project', async () => {
    const added = await call('engine:addProject', project)
    const task = await call('projectTools:createTask', added.id, { title: 'Write tests', note: 'remote' })
    await call('projectTools:updateTask', task.id, { status: 'in_progress' })
    const state = await call('projectTools:tasks', added.id)
    expect(state.tasks).toMatchObject([{ id: task.id, title: 'Write tests', status: 'in_progress' }])
    expect((await call('projectTools:searchTasks', 'write', null)).map((t: { id: string }) => t.id)).toEqual([task.id])
    await call('projectTools:deleteTask', task.id)
    expect((await call('projectTools:tasks', added.id)).tasks).toEqual([])
    expect(events.some(([channel]) => channel === 'projectTools:changed')).toBe(true)
  })

  it('only previews files recorded as AI changes', async () => {
    const added = await call('engine:addProject', project)
    const session = await call('engine:createSession', { projectId: added.id })
    await writeFile(join(project, 'a.txt'), 'hello')
    await expect(call('engine:artifactRead', { sessionId: session.id, path: join(project, 'a.txt') })).rejects.toThrow(
      '只能打开 AI 改动记录里的文件',
    )
  })

  it('discards untracked files of a git repository', async () => {
    execFileSync('git', ['init', '-q'], { cwd: project })
    await writeFile(join(project, 'new.txt'), 'draft')
    const added = await call('engine:addProject', project)
    const ref = { projectId: added.id }
    const status = await call('projectTools:gitStatus', ref)
    expect(status.untracked.map((f: { path: string }) => f.path)).toEqual(['new.txt'])
    await call('projectTools:gitDiscard', ref, { paths: [], untracked: ['new.txt'] })
    expect(existsSync(join(project, 'new.txt'))).toBe(false)
    expect(await readFile(join(project, '.git', 'HEAD'), 'utf8')).toMatch(/ref:/)
    // 远端没有回收站：移到数据目录的 trash/<时间戳>/，可以找回（P6 前是 git clean 直接删除）
    const [batch] = await readdir(join(root, 'data', 'trash'))
    expect(await readFile(join(root, 'data', 'trash', batch, 'new.txt'), 'utf8')).toBe('draft')
  })
})

// P6 起远端与本机共用 core 的操作表：下面是 P6 前远端和本机不一致、现在按本机行为的地方（docs/restructure.md §8.5）
describe('remote runtime follows the local behavior', () => {
  it('checks arguments like the desktop does', async () => {
    await expect(call('engine:openSession', '')).rejects.toThrow('参数 id 不对')
    await expect(call('engine:catalog', 'gpt')).rejects.toThrow('未知引擎')
    await expect(call('engine:setConfig', 'gpt', {})).rejects.toThrow('未知引擎')
    await expect(call('engine:archiveSession', 'x', 'yes')).rejects.toThrow('归档值不正确')
    await expect(call('engine:artifactRead', { sessionId: 's', path: 'relative.txt' })).rejects.toThrow(
      '文件路径不正确',
    )
    await expect(call('projectTools:tasks', '')).rejects.toThrow('内容不能为空')
    await expect(call('engine:addProject', '  ')).rejects.toThrow('内容不能为空')
  })

  it('searches tasks by every word, including tags, newest first', async () => {
    const added = await call('engine:addProject', project)
    const a = await call('projectTools:createTask', added.id, { title: 'Write tests', tags: ['remote'] })
    const b = await call('projectTools:createTask', added.id, { title: 'Write docs', note: 'remote helper' })
    await call('projectTools:updateTask', a.id, { note: 'updated later' })
    expect((await call('projectTools:searchTasks', 'write remote', null)).map((t: { id: string }) => t.id)).toEqual([
      a.id,
      b.id,
    ])
    expect(await call('projectTools:searchTasks', '   ', null)).toEqual([])
    expect(await call('projectTools:searchTasks', 'write', 'other-project')).toEqual([])
  })

  it('resolves a session in the project folder to the project', async () => {
    const added = await call('engine:addProject', project)
    const session = await call('engine:createSession', { projectId: added.id })
    expect(await call('files:target', { sessionId: session.id })).toEqual({
      ref: { projectId: added.id },
      path: project,
      name: 'project',
    })
    await expect(call('files:target', { sessionId: 'missing' })).rejects.toThrow('会话已不存在')
  })

  it('checks search queries and supports cancelling', async () => {
    await call('engine:addProject', project)
    await expect(call('engine:search', { requestId: 2, text: 'x' })).rejects.toThrow('搜索参数无效')
    const result = await call('engine:search', { requestId: 2, text: 'nothing here', scope: 'all', projectId: null })
    expect(result).toMatchObject({ requestId: 2 })
    expect(result.cancelled).toBeFalsy()
    // engine:cancelSearch 在 P6 前是空操作，现在按请求号取消（没有进行中的查询时不报错）
    await call('engine:cancelSearch', 2)
  })
})

describe('远程的 Pixel 引擎为什么不可用', () => {
  const pixel = (status: EngineInfo['status'], launch?: 'stock' | 'custom') =>
    ({ id: 'pixel', name: '像素星空', status, message: 'Pixel CLI not found.', launch }) as EngineInfo
  const codeOf = (message: string) => parseCodedError(message)

  it('架构不认识、Node 低于 22.19、否则是没装上', () => {
    expect(codeOf(remotePixelReason('22.19.0', 'ia32'))).toEqual({ code: 'remote.pixelArch', params: { arch: 'ia32' } })
    expect(codeOf(remotePixelReason('22.12.0', 'x64'))).toEqual({
      code: 'remote.pixelNode',
      params: { version: '22.12.0', min: '22.19' },
    })
    expect(codeOf(remotePixelReason('24.1.0', 'arm64'))?.code).toBe('remote.pixelInstall')
  })

  it('只改找不到命令行的 pixel；用户自己设了命令的、别的引擎、装好了的都不动', () => {
    const reason = remotePixelReason('22.12.0', 'x64')
    const list = [pixel('missing'), { id: 'claude', status: 'missing', message: 'x' } as EngineInfo]
    expect(withRemotePixelReason(list, reason).map(e => e.message)).toEqual([reason, 'x'])
    expect(withRemotePixelReason([pixel('missing', 'custom')], reason)[0].message).toBe('Pixel CLI not found.')
    expect(withRemotePixelReason([pixel('ready')], reason)[0].message).toBe('Pixel CLI not found.')
    expect(withRemotePixelReason(list, null)).toBe(list)
  })
})
