import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineInfo, SessionSettings } from '@pixelsky/protocol'
import type { EngineAdapter, EngineSession, SessionContext } from '../src/adapter'
import { EngineHost } from '../src/host'
import { ENGINES } from '../src/registry'
import { makeTmp, removeTmp } from './helpers/tmp'
let root: string, hosts: EngineHost[]
beforeEach(() => {
  root = makeTmp('session-lifecycle')
  hosts = []
})
afterEach(async () => {
  await Promise.all(hosts.map(h => h.shutdown()))
  removeTmp(root)
})
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (fn()) return
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('lifecycle timeout')
}
class Session implements EngineSession {
  active: string | null = null
  inputs: string[] = []
  closed = false
  stopping: (() => Promise<void>) | null = null
  failSend: string | null = null
  constructor(readonly ctx: SessionContext) {}
  send(text: string, turnId: string): void {
    if (this.failSend) {
      const message = this.failSend
      this.failSend = null
      throw new Error(message)
    }
    this.active = turnId
    this.inputs.push(text)
  }
  finish(): void {
    const turn = this.active
    this.active = null
    if (turn) this.ctx.emit({ type: 'turn_completed', turnId: turn, outcome: 'completed', error: null })
  }
  async interrupt(): Promise<void> {
    await this.stopping?.()
    const turn = this.active
    this.active = null
    if (turn) this.ctx.emit({ type: 'turn_completed', turnId: turn, outcome: 'interrupted', error: null })
  }
  async close(): Promise<void> {
    this.closed = true
    await this.interrupt()
  }
  async update(_patch: Partial<SessionSettings>): Promise<void> {}
  answer(): void {}
  async stopTask(): Promise<void> {}
  async taskOutput() {
    return { output: '', truncated: false }
  }
}
class Adapter implements EngineAdapter {
  sessions: Session[] = []
  delayed: (() => Promise<void>) | null = null
  async info(): Promise<EngineInfo> {
    await this.delayed?.()
    return { ...ENGINES.claude, status: 'ready', version: 'test', path: 'test', message: null }
  }
  createSession(ctx: SessionContext): Session {
    const s = new Session(ctx)
    this.sessions.push(s)
    return s
  }
}
function setup() {
  const adapter = new Adapter(),
    dataDir = join(root, 'engine'),
    host = new EngineHost({ dataDir, adapters: { claude: adapter }, emit: () => {} })
  hosts.push(host)
  const record = host.createSession({ projectId: host.addProject(root).id })
  return { host, adapter, record, dataDir }
}
describe('归档与删除生命周期', () => {
  it('显式名称和置底偏好持久化，不修改会话最近时间；普通旧记录兼容', async () => {
    const { host, record, dataDir } = setup(),
      updatedAt = record.updatedAt
    const renamed = host.renameSession(record.id, '  项目检查  ')
    expect(renamed).toMatchObject({ title: '项目检查', titleEdited: true, updatedAt })
    const bottomed = host.setSessionBottom(record.id, true)
    expect(bottomed.bottomedAt).toBeGreaterThan(0)
    expect(bottomed.updatedAt).toBe(updatedAt)
    expect(host.setSessionBottom(record.id, true).bottomedAt).toBe(bottomed.bottomedAt)
    const reopened = new EngineHost({ dataDir, adapters: { claude: new Adapter() }, emit: () => {} })
    hosts.push(reopened)
    expect(reopened.record(record.id)).toMatchObject({
      title: '项目检查',
      titleEdited: true,
      bottomedAt: bottomed.bottomedAt,
    })
    reopened.setSessionBottom(record.id, false)
    expect(reopened.record(record.id)?.bottomedAt).toBeNull()
    const file = join(dataDir, 'sessions', record.id, 'record.json'),
      old = JSON.parse(readFileSync(file, 'utf8'))
    delete old.bottomedAt
    delete old.titleEdited
    writeFileSync(file, JSON.stringify(old))
    const legacy = new EngineHost({ dataDir, adapters: { claude: new Adapter() }, emit: () => {} })
    hosts.push(legacy)
    expect(legacy.record(record.id)).toMatchObject({ bottomedAt: null, titleEdited: false })
  })
  it('运行中重命名和置底不停止，不改队列；默认名字和迟到启动不会覆盖用户名称', async () => {
    const { host, adapter, record } = setup()
    let release!: () => void
    adapter.delayed = () =>
      new Promise<void>(resolve => {
        release = resolve
      })
    await host.send(record.id, '首条消息生成的名称')
    await until(() => !!release)
    host.renameSession(record.id, '新会话')
    release()
    adapter.delayed = null
    await until(() => !!adapter.sessions[0]?.active)
    expect(host.open(record.id).record.title).toBe('新会话')
    await host.send(record.id, '排队消息')
    host.renameSession(record.id, '正在运行的自定义名称')
    host.setSessionBottom(record.id, true)
    expect(adapter.sessions[0].active).toBeTruthy()
    expect(adapter.sessions[0].closed).toBe(false)
    expect(host.open(record.id).queue.map(q => q.text)).toEqual(['首条消息生成的名称', '排队消息'])
    adapter.sessions[0].finish()
    await until(() => adapter.sessions[0].inputs.length === 2)
    expect(host.open(record.id).record.title).toBe('正在运行的自定义名称')
    expect(host.open(record.id).record.bottomedAt).toBeTruthy()
  })
  it('重命名拒绝空值、非法字符及超长名称，保留原记录', () => {
    const { host, record } = setup()
    for (const value of ['', ' ', 'hello\nworld', 'a'.repeat(201), 42])
      expect(() => host.renameSession(record.id, value)).toThrow()
    expect(host.record(record.id)?.title).toBe('新会话')
    expect(host.renameSession(record.id, '星'.repeat(200)).title).toHaveLength(200)
  })
  it('置顶持久化、和置底互斥，后置顶的时间更晚；旧记录为 null', () => {
    const { host, record, dataDir } = setup(),
      second = host.createSession({ projectId: record.projectId }),
      updatedAt = record.updatedAt
    expect(record.pinnedAt).toBeNull()
    host.setSessionBottom(record.id, true)
    const pinned = host.setSessionPinned(record.id, true)
    expect(pinned).toMatchObject({ bottomedAt: null, updatedAt })
    expect(pinned.pinnedAt).toBeGreaterThan(0)
    expect(host.setSessionPinned(record.id, true).pinnedAt).toBe(pinned.pinnedAt)
    expect(host.setSessionPinned(second.id, true).pinnedAt).toBeGreaterThan(pinned.pinnedAt!)
    const reopened = new EngineHost({ dataDir, adapters: { claude: new Adapter() }, emit: () => {} })
    hosts.push(reopened)
    expect(reopened.record(record.id)?.pinnedAt).toBe(pinned.pinnedAt)
    // 置底时取消置顶
    expect(reopened.setSessionBottom(record.id, true)).toMatchObject({ pinnedAt: null })
    expect(reopened.setSessionPinned(second.id, false).pinnedAt).toBeNull()
    const file = join(dataDir, 'sessions', second.id, 'record.json'),
      old = JSON.parse(readFileSync(file, 'utf8'))
    delete old.pinnedAt
    writeFileSync(file, JSON.stringify(old))
    const legacy = new EngineHost({ dataDir, adapters: { claude: new Adapter() }, emit: () => {} })
    hosts.push(legacy)
    expect(legacy.record(second.id)?.pinnedAt).toBeNull()
  })
  it('归档恢复保留置底顺序，后置底的排在前次之后', async () => {
    const { host, record } = setup(),
      second = host.createSession({ projectId: record.projectId })
    const firstStamp = host.setSessionBottom(record.id, true).bottomedAt!,
      secondStamp = host.setSessionBottom(second.id, true).bottomedAt!
    expect(secondStamp).toBeGreaterThan(firstStamp)
    await host.archiveSession(record.id, true)
    host.renameSession(record.id, '归档名称')
    await host.archiveSession(record.id, false)
    expect(host.record(record.id)).toMatchObject({ title: '归档名称', bottomedAt: firstStamp, archivedAt: null })
  })
  it('旧记录标准化为 null；归档保存、重启恢复、取消归档保留对话', async () => {
    const { host, adapter, record, dataDir } = setup()
    await host.send(record.id, '保留的对话')
    await until(() => !!adapter.sessions[0]?.active)
    adapter.sessions[0].finish()
    await host.archiveSession(record.id, true)
    expect(host.record(record.id)?.archivedAt).toBeGreaterThan(0)
    expect(adapter.sessions[0].closed).toBe(true)
    const reopened = new EngineHost({ dataDir, adapters: { claude: new Adapter() }, emit: () => {} })
    hosts.push(reopened)
    expect(reopened.record(record.id)?.archivedAt).toBeGreaterThan(0)
    expect(reopened.open(record.id).items[0]).toMatchObject({ text: '保留的对话' })
    await reopened.archiveSession(record.id, false)
    expect(reopened.record(record.id)?.archivedAt).toBeNull()
    const file = join(dataDir, 'sessions', record.id, 'record.json'),
      old = JSON.parse(readFileSync(file, 'utf8'))
    delete old.archivedAt
    writeFileSync(file, JSON.stringify(old))
    const legacy = new EngineHost({ dataDir, adapters: { claude: new Adapter() }, emit: () => {} })
    hosts.push(legacy)
    expect(legacy.record(record.id)?.archivedAt).toBeNull()
  })
  it('运行中先要求确认；归档停止并暂停队列，恢复不自动执行', async () => {
    const { host, adapter, record } = setup()
    await host.send(record.id, '正在执行')
    await until(() => !!adapter.sessions[0]?.active)
    await host.send(record.id, '排队保留')
    await expect(host.archiveSession(record.id, true)).rejects.toThrow('SESSION_RUNNING')
    await host.archiveSession(record.id, true, true)
    expect(host.open(record.id)).toMatchObject({
      state: 'idle',
      queuePaused: true,
      queue: [{ text: '排队保留', status: 'queued' }],
    })
    expect(adapter.sessions[0].closed).toBe(true)
    await host.archiveSession(record.id, false)
    await new Promise(r => setTimeout(r, 20))
    expect(adapter.sessions).toHaveLength(1)
    host.resumeQueue(record.id)
    await until(() => !!adapter.sessions[1]?.active)
    expect(adapter.sessions[1].inputs).toEqual(['排队保留'])
  })
  it('等待审批也停止并关闭；确认操作进行时拒绝新消息', async () => {
    const { host, adapter, record } = setup()
    await host.send(record.id, '审批测试')
    await until(() => !!adapter.sessions[0]?.active)
    adapter.sessions[0].ctx.emit({
      type: 'approval_request',
      request: {
        requestId: 'approval',
        kind: 'tool',
        tool: 'Bash',
        input: { command: 'test' },
        summary: 'test',
        suggestions: [],
      } as never,
    })
    let release!: () => void
    adapter.sessions[0].stopping = () =>
      new Promise<void>(r => {
        release = r
      })
    const archiving = host.archiveSession(record.id, true, true)
    await until(() => !!release)
    await expect(host.send(record.id, '迟到消息')).rejects.toThrow('正在处理')
    adapter.sessions[0].stopping = null
    release()
    await archiving
    expect(host.open(record.id).pending).toEqual([])
    expect(host.open(record.id).state).toBe('idle')
  })
  it('归档后新发送自动取消归档；空输入不改变归档状态', async () => {
    const { host, adapter, record } = setup()
    await host.archiveSession(record.id, true)
    await expect(host.send(record.id, ' ')).rejects.toThrow()
    expect(host.record(record.id)?.archivedAt).toBeTruthy()
    await host.send(record.id, '继续聊')
    expect(host.record(record.id)?.archivedAt).toBeNull()
    await until(() => !!adapter.sessions[0]?.active)
    expect(adapter.sessions[0].inputs).toEqual(['继续聊'])
  })
  it('删除停止并移除本机记录和队列，保留项目与 Claude 原生记录', async () => {
    const { host, adapter, record, dataDir } = setup(),
      native = join(root, 'native-session.jsonl')
    writeFileSync(native, '原生记录')
    await host.send(record.id, '当前任务')
    await until(() => !!adapter.sessions[0]?.active)
    await host.send(record.id, '不再发出')
    await host.deleteSession(record.id)
    await new Promise(r => setTimeout(r, 20))
    expect(adapter.sessions[0].closed).toBe(true)
    expect(adapter.sessions[0].inputs).toEqual(['当前任务'])
    expect(host.record(record.id)).toBeNull()
    expect(existsSync(join(dataDir, 'sessions', record.id))).toBe(false)
    expect(readFileSync(native, 'utf8')).toBe('原生记录')
    expect(existsSync(root)).toBe(true)
  })
  it('在引擎检测期间归档，迟到的检测结果不能发送排队输入', async () => {
    const { host, adapter, record } = setup()
    let release!: () => void
    adapter.delayed = () =>
      new Promise<void>(r => {
        release = r
      })
    await host.send(record.id, '检测期间的消息')
    await until(() => !!release)
    await host.archiveSession(record.id, true, true)
    release()
    await until(() => host.open(record.id).state === 'idle')
    expect(adapter.sessions).toHaveLength(0)
    expect(host.open(record.id).queuePaused).toBe(true)
  })
  it('新会话刚发第一条就删掉：派发收尾不再按 id 改队列，不重建运行时、没有未处理的拒绝', async () => {
    const { host, adapter, record } = setup()
    let release!: () => void
    adapter.delayed = () =>
      new Promise<void>(r => {
        release = r
      })
    const rejections: unknown[] = []
    const onRejection = (err: unknown) => rejections.push(err)
    process.on('unhandledRejection', onRejection)
    try {
      await host.send(record.id, '第一条')
      await until(() => !!release)
      await host.deleteSession(record.id)
      release()
      await new Promise(r => setTimeout(r, 20))
      expect(rejections).toEqual([])
      expect(host.record(record.id)).toBeNull()
      expect(adapter.sessions).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
  it('发给引擎前抛错：这一轮标失败，会话回到空闲，下一条照常发出', async () => {
    const { host, adapter, record } = setup()
    await host.send(record.id, '第一条')
    await until(() => !!adapter.sessions[0]?.active)
    adapter.sessions[0].finish()
    await until(() => host.open(record.id).state === 'idle' && host.open(record.id).queue.length === 0)
    adapter.sessions[0].failSend = '写入失败'
    await host.send(record.id, '第二条')
    await until(() => host.open(record.id).queue.some(q => q.status === 'failed'))
    expect(host.open(record.id)).toMatchObject({ state: 'idle', queuePaused: true })
    expect(host.open(record.id).queue[0]).toMatchObject({ status: 'failed', error: '写入失败' })
    await host.send(record.id, '第三条')
    // 第二条已写进对话但引擎没收到，第三条前面带着交接材料
    await until(() => adapter.sessions[0].inputs.some(t => t.endsWith('第三条')))
  })
})
