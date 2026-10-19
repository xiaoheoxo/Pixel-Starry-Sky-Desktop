// 接着终端里的 Codex 会话：列表和占用、导入（原地 / 复制 / 旧格式）、正开着、记录被删、回退 / 分叉、
// 加载更早的、补上、modelProvider、空闲放开线程（docs/ui/codex-resume.md §8 host 测试），用真的 EngineHost + 假 Codex
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseCodedError,
  type HostEvent,
  type Item,
  type SessionRecord,
  type SessionSettings,
} from '@pixelsky/protocol'
import { CodexAdapter, EngineHost } from '../src'
import { clearCodexCaches } from '../src/codex/native'
import { IS_WINDOWS } from '../src/exec'
import { NATIVE_TEXT } from '../src/native/text'
import { makeTmp, removeTmp } from './helpers/tmp'

const FAKE = fileURLToPath(new URL('./fakes/fake-codex.mjs', import.meta.url))

let root: string
let events: HostEvent[]
let hosts: EngineHost[]

beforeEach(() => {
  root = makeTmp('codex-resume')
  events = []
  hosts = []
  clearCodexCaches()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(hosts.map(h => h.shutdown()))
  removeTmp(root)
})

// ---------- 假 Codex 的数据：threads.json（轮次）、meta.json（线程元数据）----------

/** 线程 id 是 UUIDv7（rollout 按它的时间放目录）；turn id 也是 UUID 形状，宿主按 UUID 正则筛用户条目 */
const tid = (n: number): string => `0199aaaa-0000-7000-8000-${String(n).padStart(12, '0')}`
const turnId = (n: number, k: number): string => `0199bbbb-0000-7000-8000-${String(n * 1000 + k).padStart(12, '0')}`
const T0 = Date.parse('2026-10-01T00:00:00Z') / 1000
const stateDir = (): string => join(root, 'state')
const codexHome = (): string => join(root, 'codex-home')

type FxTurn = {
  id: string
  clientId: string | null
  content: unknown[]
  status?: string
  startedAt?: number
  items: Record<string, unknown>[]
}
const read = <T>(name: string): T => JSON.parse(readFileSync(join(stateDir(), name), 'utf8')) as T
const write = (name: string, value: unknown): void => {
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(join(stateDir(), name), JSON.stringify(value))
}
const threadsOf = (): Record<string, FxTurn[]> =>
  existsSync(join(stateDir(), 'threads.json')) ? read('threads.json') : {}
const metaOf = (): Record<string, Record<string, unknown>> =>
  existsSync(join(stateDir(), 'meta.json')) ? read('meta.json') : {}
const turnIds = (thread: string): string[] => threadsOf()[thread].map(t => t.id)

/** 终端里聊出来的一轮：用户话（clientId 为 null）+ 回复 */
function fxTurn(n: number, k: number, extra: Partial<FxTurn> = {}, reply: string | null = `回答 ${k}`): FxTurn {
  const content = [{ type: 'text', text: `问题 ${k}`, text_elements: [] }]
  return {
    id: turnId(n, k),
    clientId: null,
    content,
    startedAt: T0 + k * 60,
    items: [
      { type: 'userMessage', id: `u-${n}-${k}`, clientId: null, content },
      ...(reply ? [{ type: 'agentMessage', id: `a-${n}-${k}`, text: reply, phase: null }] : []),
    ],
    ...extra,
  }
}

/** 在假 Codex 的状态目录里放一个终端线程（count 轮）。cwd 默认项目目录 */
function addThread(n: number, cwd: string, count = 2, meta: Record<string, unknown> = {}): string {
  const id = tid(n)
  write('threads.json', {
    ...threadsOf(),
    [id]: Array.from({ length: count }, (_, k) => {
      const turn = fxTurn(n, k + 1)
      // 像素星空发的消息带 clientId（终端里发的是 null）
      if (meta.originator !== 'pixelsky') return turn
      const clientId = `00000000-0000-4000-8000-${String(n * 1000 + k + 1).padStart(12, '0')}`
      return { ...turn, clientId, items: turn.items.map(i => (i.type === 'userMessage' ? { ...i, clientId } : i)) }
    }),
  })
  write('meta.json', {
    ...metaOf(),
    [id]: {
      cwd,
      source: 'cli',
      originator: 'codex_cli_rs',
      name: null,
      updatedAt: T0 + 1000 - n,
      model: 'gpt-5.5',
      modelProvider: 'openai',
      gitBranch: 'main',
      historyMode: 'paginated',
      ...meta,
    },
  })
  return id
}

/** 终端里又聊了：往线程末尾追加轮次，并把 updatedAt 往后挪（Codex 每次写入都会更新它） */
function appendTurns(id: string, ...turns: FxTurn[]): void {
  write('threads.json', { ...threadsOf(), [id]: [...threadsOf()[id], ...turns] })
  const meta = metaOf()
  write('meta.json', { ...meta, [id]: { ...meta[id], updatedAt: Number(meta[id].updatedAt) + 10 } })
}

/** 一个 rollout 文件（记录还在不在只看文件名里有没有线程 id）；放在线程创建那天的目录里 */
function writeRollout(id: string): string {
  const at = new Date(parseInt(id.replace(/-/g, '').slice(0, 12), 16))
  const pad = (n: number): string => String(n).padStart(2, '0')
  const dir = join(codexHome(), 'sessions', String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate()))
  mkdirSync(dir, { recursive: true })
  const file = join(
    dir,
    `rollout-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T00-00-00-${id}.jsonl`,
  )
  writeFileSync(file, '{}\n')
  return file
}

// ---------- 宿主 ----------

interface SetupOptions {
  env?: Record<string, string>
  idleMs?: number
}
const rpcLog = (): string => join(root, 'rpc.jsonl')
type Rpc = { method?: string; params?: Record<string, unknown> }
const rpc = (): Rpc[] =>
  existsSync(rpcLog())
    ? readFileSync(rpcLog(), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as Rpc)
    : []
const called = (method: string): Rpc[] => rpc().filter(m => m.method === method)

function setup(opts: SetupOptions = {}) {
  mkdirSync(stateDir(), { recursive: true })
  const adapter = new CodexAdapter({
    launcher: { command: process.execPath, args: [FAKE] },
    env: {
      ...process.env,
      FAKE_CODEX_LOG: rpcLog(),
      FAKE_CODEX_STATE_DIR: stateDir(),
      CODEX_HOME: codexHome(),
      ...opts.env,
    },
    launchOptions: () => ({ askQuestions: true, steeringValidated: true }),
  })
  const host = new EngineHost({
    dataDir: join(root, 'data'),
    emit: e => events.push(e),
    idleMs: opts.idleMs ?? 60_000,
    adapters: { codex: adapter },
  })
  hosts.push(host)
  const dir = join(root, 'proj')
  mkdirSync(dir, { recursive: true })
  const project = host.addProject(dir)
  return { host, adapter, project, cwd: project.path }
}
type T = ReturnType<typeof setup>

const turnsDone = (id: string): number =>
  events.filter(e => e.kind === 'session' && e.sessionId === id && e.event.type === 'turn_completed').length

async function waitFor<T>(pick: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = pick()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, 20))
  }
}

type Imported = { sessionId: string; model: string | null; turns: number; shown: number }
async function importIn(
  t: T,
  nativeId: string,
  mode: 'inplace' | 'copy' = 'inplace',
  settings?: Partial<SessionSettings>,
): Promise<Imported> {
  const res = await t.host.importNativeSession(t.project.id, 'codex', nativeId, { mode, settings })
  if (!('sessionId' in res)) throw new Error(`没有建对话：${JSON.stringify(res)}`)
  return res
}

async function say(host: EngineHost, id: string, text: string, n: number): Promise<void> {
  const before = turnsDone(id)
  await host.send(id, { text, clientMessageId: `msg-${n}` })
  await waitFor(() => turnsDone(id) === before + 1)
}

type Notice = Extract<Item, { kind: 'notice' }>
const notices = (host: EngineHost, id: string): Notice[] =>
  host.open(id).items.filter((i): i is Notice => i.kind === 'notice')
const userIds = (host: EngineHost, id: string): string[] =>
  host.open(id).items.flatMap(i => (i.kind === 'user' ? [i.id] : []))
const patchRecord = (host: EngineHost, id: string, patch: Partial<SessionRecord>): void =>
  (
    host as unknown as { m: { events: { patchRecord(id: string, p: Partial<SessionRecord>): void } } }
  ).m.events.patchRecord(id, patch)

/** 往对话里直接放一条用户消息（模拟「发出去了但没送到 Codex」：启动失败留在对话里的那种） */
const injectUser = (host: EngineHost, id: string, userId: string, text = '没发出去'): void =>
  (host as unknown as { m: { events: { apply(id: string, e: unknown): void } } }).m.events.apply(id, {
    type: 'item_completed',
    item: { kind: 'user', id: userId, text, createdAt: Date.now(), engine: 'codex' },
  })
const UNSENT = '00000000-0000-4000-8000-00000000f001'

// 每条要起几个假 Codex 进程（读取进程、会话、读轮次的临时进程），完整检查并发跑时会超过默认的 5 秒
describe('列表和占用', { timeout: 20_000 }, () => {
  it('列出项目（和子文件夹）里的线程；第二步补最后一句；请求不带 cwd、modelProviders 是 []', async () => {
    const t = setup()
    const sub = join(t.cwd, 'pkg')
    mkdirSync(sub)
    const a = addThread(1, t.cwd, 2)
    const b = addThread(2, sub, 1, { source: 'vscode', modelProvider: 'pixelsky', gitBranch: 'dev' })
    // 不列：别的项目、子智能体、ephemeral、默认来源以外的（modelProviders: [] 才拿得到 openai / pixelsky 的）也都要列出来
    addThread(3, join(root, 'elsewhere'), 1)
    addThread(4, t.cwd, 1, { parentThreadId: a })
    addThread(5, t.cwd, 1, { ephemeral: true })
    addThread(6, t.cwd, 1, { modelProvider: 'fake' })

    const list = await t.host.nativeSessions(t.project.id, 'codex')
    expect(list.map(s => [s.id, s.subdir, s.source])).toEqual([
      [a, null, 'terminal'],
      [b, 'pkg', 'other'],
      [tid(6), null, 'terminal'],
    ])
    expect(list[0]).toMatchObject({
      ownerId: null,
      live: null,
      model: 'gpt-5.5',
      branch: 'main',
      title: '问题 1',
      lastPrompt: null,
    })
    expect(list[1].branch).toBe('dev')
    const lists = called('thread/list')
    expect(lists.length).toBeGreaterThan(0)
    for (const m of lists) {
      expect(m.params?.modelProviders).toEqual([])
      expect(m.params).not.toHaveProperty('cwd')
    }

    const details = await t.host.nativeSessionDetails(t.project.id, 'codex', [a, b, '../x'])
    expect(details.map(d => [d.id, d.lastPrompt, d.skipped])).toEqual([
      [a, '问题 2', false],
      [b, '问题 1', false],
    ])
    await expect(t.host.importNativeSession(t.project.id, 'codex', '../x')).rejects.toThrow('会话 id 不对')
  })

  it('读取进程只发读请求，不 resume', async () => {
    const t = setup()
    const a = addThread(1, t.cwd, 1)
    await t.host.nativeSessions(t.project.id, 'codex')
    await t.host.nativeSessionDetails(t.project.id, 'codex', [a])
    const methods = new Set(rpc().map(m => m.method))
    expect(methods.has('thread/resume')).toBe(false)
    expect(methods.has('thread/start')).toBe(false)
    expect(methods.has('thread/list')).toBe(true)
  })

  it('Codex 没就绪：列表抛「读不到」，不是别的错', async () => {
    const t = setup({ env: { PIXELSKY_NONE: '1' } })
    // 把适配器换成找不到 Codex 的：读取进程起不来
    const missing = new CodexAdapter({ launcher: { command: join(root, 'no-such-codex'), args: [] }, env: process.env })
    const host = new EngineHost({ dataDir: join(root, 'data2'), emit: () => {}, adapters: { codex: missing } })
    hosts.push(host)
    const project = host.addProject(t.cwd)
    await expect(host.nativeSessions(project.id, 'codex')).rejects.toThrow(NATIVE_TEXT.codexUnavailable)
  })
})

describe('导入：原地接着', { timeout: 20_000 }, () => {
  it('建对话、条目、engineSessionId 和 seen、imported.source；发消息 thread/resume X 带 modelProvider，没有交接；再列显示被占用，重复导入返回 ownerId', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 2)
    const before = t.host.sessions().length
    const res = await importIn(t, x)
    expect(res).toMatchObject({ model: 'gpt-5.5', turns: 2, shown: 2 })
    expect(t.host.sessions()).toHaveLength(before + 1)
    const id = res.sessionId
    const snap = t.host.open(id)
    expect(snap.record).toMatchObject({ engine: 'codex', engineSessionId: x, cwd: t.cwd, title: '问题 1' })
    expect(snap.record.imported).toMatchObject({
      engine: 'codex',
      sessionId: x,
      turns: 2,
      shown: 2,
      source: 'terminal',
    })
    expect(snap.record.imported?.forked).toBeUndefined()
    expect(snap.items[0]).toMatchObject({ kind: 'notice', text: '接着终端里的 Codex 会话 · 2 轮' })
    // 导入的用户条目 id 是 turn id，引擎名是 codex
    expect(userIds(t.host, id)).toEqual([turnId(1, 1), turnId(1, 2)])
    expect(snap.items.filter(i => i.kind === 'user').every(i => i.kind === 'user' && i.engine === 'codex')).toBe(true)
    expect(snap.items.filter(i => i.kind === 'assistant').map(i => i.kind === 'assistant' && i.text)).toEqual([
      '回答 1',
      '回答 2',
    ])
    expect(snap.record.engineSessions?.codex).toEqual({ id: x, seen: snap.items.at(-1)!.id })

    await say(t.host, id, '新的', 1)
    const resumes = called('thread/resume')
    expect(resumes).toHaveLength(1)
    expect(resumes[0].params).toMatchObject({ threadId: x, modelProvider: 'fake' })
    expect(called('thread/start')).toHaveLength(0)
    expect(called('thread/fork')).toHaveLength(0)
    expect(called('thread/inject_items')).toHaveLength(0)
    // 没有交接提示，只有分隔条
    expect(notices(t.host, id)).toHaveLength(1)
    expect(turnIds(x)).toHaveLength(3)
    expect(t.host.open(id).record.engineSessionId).toBe(x)

    expect((await t.host.nativeSessions(t.project.id, 'codex'))[0].ownerId).toBe(id)
    await expect(t.host.importNativeSession(t.project.id, 'codex', x)).resolves.toEqual({ ownerId: id })
    await expect(t.host.importNativeSession(t.project.id, 'codex', x, { mode: 'copy' })).resolves.toEqual({
      ownerId: id,
    })
  })

  it('线程的 cwd 和项目路径是同一个目录、只差末尾分隔符 / 大小写：算项目根目录，不当成同名子文件夹', async () => {
    const t = setup()
    const a = addThread(1, `${t.cwd}${sep}`, 1)
    const first = await importIn(t, a)
    expect(t.host.open(first.sessionId).record.cwd).toBe(t.cwd)
    if (IS_WINDOWS) {
      const b = addThread(2, t.cwd.toUpperCase(), 1)
      const second = await importIn(t, b)
      expect(t.host.open(second.sessionId).record.cwd).toBe(t.cwd)
    }
  })

  it('子文件夹里的线程：导入后 cwd 是子文件夹；/resume <id> 直接导入（没有列表缓存）也是', async () => {
    const t = setup()
    const sub = join(t.cwd, 'pkg', 'app')
    mkdirSync(sub, { recursive: true })
    const a = addThread(1, sub, 2)
    const b = addThread(2, join(t.cwd, 'pkg'), 1)
    const list = await t.host.nativeSessions(t.project.id, 'codex')
    expect(list.map(s => [s.id, s.subdir])).toEqual([
      [a, 'pkg/app'],
      [b, 'pkg'],
    ])
    const first = await importIn(t, a)
    expect(t.host.open(first.sessionId).record).toMatchObject({ engineSessionId: a, cwd: sub })

    // 换一个宿主：没有列表缓存，只能靠读出来的 cwd
    const t2 = { ...setup(), project: t.project }
    const direct = await t2.host.importNativeSession(t2.host.addProject(t.cwd).id, 'codex', b, { mode: 'inplace' })
    if (!('sessionId' in direct)) throw new Error('没有建对话')
    expect(t2.host.open(direct.sessionId).record.cwd).toBe(join(t.cwd, 'pkg'))
  })

  it('导入前线程已经没了：报「已经不在了」，不建对话', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 1)
    await t.host.nativeSessions(t.project.id, 'codex')
    write('threads.json', {})
    write('meta.json', {})
    const before = t.host.sessions().length
    await expect(t.host.importNativeSession(t.project.id, 'codex', x)).rejects.toThrow(NATIVE_TEXT.gone)
    expect(t.host.sessions()).toHaveLength(before)
  })

  it('像素星空以前用过的线程（originator pixelsky）：分隔条后面多一条说明', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 1, { originator: 'pixelsky', source: 'vscode' })
    const { sessionId } = await importIn(t, x)
    const items = t.host.open(sessionId).items
    expect(items[0]).toMatchObject({ text: '接着 Codex 会话（来自其他程序）· 1 轮' })
    expect(items[1]).toMatchObject({ kind: 'notice', text: NATIVE_TEXT.pixelskyThread })
    expect(t.host.open(sessionId).record.imported?.source).toBe('other')
  })

  it('像素星空以前发的线程（轮次带 clientId）：导入的条目 id 仍是 turn id，回退照样按 turn id 截断', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 3, { originator: 'pixelsky', source: 'vscode' })
    const { sessionId } = await importIn(t, x)
    expect(userIds(t.host, sessionId)).toEqual([turnId(1, 1), turnId(1, 2), turnId(1, 3)])
    await t.host.rewind(sessionId, turnId(1, 3))
    expect(t.host.open(sessionId).record.engineSessionId).toBe(x)
    expect(t.host.open(sessionId).record.pendingRewind).toBe(turnId(1, 2))
    await t.host.rewind(sessionId, turnId(1, 1))
    expect(t.host.open(sessionId).record.pendingRewind ?? null).toBeNull()
    expect(t.host.open(sessionId).record.engineSessionId).toBeNull()
  })
})

describe('导入：复制一份接着聊', { timeout: 20_000 }, () => {
  it('engineSessionId 为 null + pendingFork{from: X, at: 最后一个已结束的 turn} + forked；发消息 thread/fork；X 的轮次没变；X 仍算被占用', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 2)
    // 最后一轮还没结束的（终端里正聊着）：复制的截断点不能落在它上面
    appendTurns(x, fxTurn(1, 3, { status: 'inProgress' }, null))
    const turnsBefore = JSON.stringify(threadsOf()[x])
    const { sessionId: id } = await importIn(t, x, 'copy')
    const record = t.host.open(id).record
    expect(record.engineSessionId).toBeNull()
    expect(record.pendingFork).toEqual({ from: x, at: turnId(1, 2) })
    expect(record.imported).toMatchObject({ sessionId: x, forked: true, source: 'terminal' })
    expect(record.engineSessions?.codex).toEqual({ id: null, seen: t.host.open(id).items.at(-1)!.id })
    expect(t.host.open(id).items[0]).toMatchObject({
      text: '复制了终端里的 Codex 会话 · 3 轮（原会话不动，两边可以同时用）',
    })
    expect((await t.host.nativeSessions(t.project.id, 'codex'))[0].ownerId).toBe(id)

    await say(t.host, id, '新的', 1)
    const forks = called('thread/fork')
    expect(forks).toHaveLength(1)
    expect(forks[0].params).toMatchObject({ threadId: x, lastTurnId: turnId(1, 2), modelProvider: 'fake' })
    expect(called('thread/resume')).toHaveLength(0)
    expect(called('thread/start')).toHaveLength(0)
    expect(JSON.stringify(threadsOf()[x])).toBe(turnsBefore)
    const after = t.host.open(id).record
    expect(after.engineSessionId).toMatch(/^fake-fork-/)
    expect(after.pendingFork ?? null).toBeNull()
    expect((await t.host.nativeSessions(t.project.id, 'codex'))[0].ownerId).toBe(id)
  })

  it('启动前先回退一条导入的消息：pendingFork.at 改成前一轮，fork 到那里', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 3)
    const { sessionId: id } = await importIn(t, x, 'copy')
    await t.host.rewind(id, turnId(1, 3))
    expect(userIds(t.host, id)).toEqual([turnId(1, 1), turnId(1, 2)])
    expect(t.host.open(id).record.pendingFork).toEqual({ from: x, at: turnId(1, 2) })
    await t.host.rewind(id, turnId(1, 2))
    expect(t.host.open(id).record.pendingFork).toEqual({ from: x, at: turnId(1, 1) })
    await say(t.host, id, '改', 1)
    expect(called('thread/fork')[0].params).toMatchObject({ threadId: x, lastTurnId: turnId(1, 1) })
    expect(turnIds(x)).toHaveLength(3)
  })

  it('启动前回退一条没送到 Codex 的消息（保留全部）：pendingFork.at 不动，不会带上导入之后终端里新聊的轮次', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 2)
    const { sessionId: id } = await importIn(t, x, 'copy')
    expect(t.host.open(id).record.pendingFork).toEqual({ from: x, at: turnId(1, 2) })
    // 导入之后终端里又聊了两轮（最后一轮还在跑）；对话里留着一条启动失败、没送到 Codex 的消息
    appendTurns(x, fxTurn(1, 3), fxTurn(1, 4, { status: 'inProgress' }, null))
    injectUser(t.host, id, UNSENT)
    await t.host.rewind(id, UNSENT)
    const record = t.host.open(id).record
    expect(record.pendingFork).toEqual({ from: x, at: turnId(1, 2) })
    expect(record.engineSessionId).toBeNull()
    expect(userIds(t.host, id)).toEqual([turnId(1, 1), turnId(1, 2)])
    expect(notices(t.host, id).filter(n => n.level === 'warn' || n.text.startsWith('无法'))).toEqual([])
    await say(t.host, id, '改', 1)
    expect(called('thread/fork')[0].params).toMatchObject({ threadId: x, lastTurnId: turnId(1, 2) })
    expect(turnIds(x)).toHaveLength(4)
  })

  it('原地导入的对话已有待回退时，再回退一条没送到 Codex 的消息：待回退不被盖掉', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 3)
    const { sessionId: id } = await importIn(t, x)
    await t.host.rewind(id, turnId(1, 3))
    expect(t.host.open(id).record.pendingRewind).toBe(turnId(1, 2))
    injectUser(t.host, id, UNSENT)
    await t.host.rewind(id, UNSENT)
    // 线程里第 3 轮还在（revert 要等下次启动），保留全部不能把 pendingRewind 挪到第 3 轮
    expect(t.host.open(id).record.pendingRewind).toBe(turnId(1, 2))
    await say(t.host, id, '改', 1)
    expect(called('thread/revert')[0].params).toEqual({ threadId: x, beforeTurnId: turnId(1, 3) })
  })

  it('线程里一轮结束的都没有：复制报「没聊完的一轮」，不建对话', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 1)
    write('threads.json', { [x]: [fxTurn(1, 1, { status: 'inProgress' }, null)] })
    const before = t.host.sessions().length
    await expect(t.host.importNativeSession(t.project.id, 'codex', x, { mode: 'copy' })).rejects.toThrow(
      NATIVE_TEXT.nothingToCopy,
    )
    expect(t.host.sessions()).toHaveLength(before)
  })

  it('旧格式（legacy）线程：原地导入的请求被改成复制，分隔条是旧格式的写法', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 2, { historyMode: 'legacy' })
    const { sessionId: id } = await importIn(t, x, 'inplace')
    const record = t.host.open(id).record
    expect(record.engineSessionId).toBeNull()
    expect(record.pendingFork).toEqual({ from: x, at: turnId(1, 2) })
    expect(record.imported?.forked).toBe(true)
    expect(t.host.open(id).items[0]).toMatchObject({
      text: '复制了终端里的 Codex 会话 · 2 轮（旧格式的线程不能原地回退，复制成新线程接着聊，原会话不动）',
    })
    await say(t.host, id, '新的', 1)
    expect(called('thread/fork')[0].params).toMatchObject({ threadId: x, lastTurnId: turnId(1, 2) })
    expect(called('thread/resume')).toHaveLength(0)
  })
})

describe('正开着', { timeout: 20_000 }, () => {
  it('原地导入以后终端又开了：发消息失败（resume.live，来源 terminal），没有 thread/start；复制一份后重发成功，X 没被写', async () => {
    const x = tid(1)
    const t = setup({ env: { FAKE_CODEX_LOCKED: x } })
    addThread(1, t.cwd, 2)
    const { sessionId: id } = await importIn(t, x)
    const turnsBefore = JSON.stringify(threadsOf()[x])
    const receipt = await t.host.send(id, { text: '来了', clientMessageId: 'live-1' })
    await waitFor(() => turnsDone(id) === 1)
    const failed = events
      .flatMap(e => (e.kind === 'session' && e.sessionId === id && e.event.type === 'turn_completed' ? [e.event] : []))
      .at(-1)!
    expect(failed).toMatchObject({ outcome: 'failed' })
    expect(parseCodedError(failed.type === 'turn_completed' ? failed.error : null)).toMatchObject({
      code: 'resume.live',
      params: { source: 'terminal' },
    })
    const queued = t.host.open(id).queue.find(q => q.id === receipt.queueId)
    expect(parseCodedError(queued?.error)).toMatchObject({ code: 'resume.live', params: { source: 'terminal' } })
    expect(called('thread/resume')).toHaveLength(1)
    expect(called('thread/start')).toHaveLength(0)
    expect(JSON.stringify(threadsOf()[x])).toBe(turnsBefore)

    await expect(t.host.nativeSessionAction(id, 'copy')).resolves.toEqual({ added: 0 })
    expect(t.host.open(id).record).toMatchObject({
      engineSessionId: null,
      pendingFork: { from: x, at: turnId(1, 2) },
      imported: { forked: true },
    })
    await t.host.runQueuedNow(id, receipt.queueId)
    await waitFor(() => turnsDone(id) === 2)
    expect(called('thread/fork')).toHaveLength(1)
    expect(called('thread/fork')[0].params).toMatchObject({ threadId: x, lastTurnId: turnId(1, 2) })
    expect(called('thread/start')).toHaveLength(0)
    expect(JSON.stringify(threadsOf()[x])).toBe(turnsBefore)
  })

  it('其他程序建的线程撞上：来源是 other', async () => {
    const x = tid(1)
    const t = setup({ env: { FAKE_CODEX_LOCKED: x } })
    addThread(1, t.cwd, 1, { source: 'vscode' })
    const { sessionId: id } = await importIn(t, x)
    const receipt = await t.host.send(id, { text: '来了', clientMessageId: 'live-1' })
    await waitFor(() => turnsDone(id) === 1)
    const queued = t.host.open(id).queue.find(q => q.id === receipt.queueId)
    expect(parseCodedError(queued?.error)).toMatchObject({ code: 'resume.live', params: { source: 'other' } })
  })

  it('普通（非导入）Codex 对话撞上同样报 resume.live，不开新线程', async () => {
    const t = setup({ idleMs: 50, env: { FAKE_CODEX_LOCKED: 'fake-thread' } })
    const session = t.host.createSession({ projectId: t.project.id, engine: 'codex', model: 'fake-codex' })
    await t.host.send(session.id, { text: 'first', clientMessageId: 'a' })
    await waitFor(() => turnsDone(session.id) === 1)
    const oldId = t.host.open(session.id).record.engineSessionId
    expect(oldId).toBe('fake-thread')
    // 空闲 50 毫秒后进程关掉，下一条消息要 thread/resume
    await new Promise(r => setTimeout(r, 200))
    const starts = called('thread/start').length
    const receipt = await t.host.send(session.id, { text: 'second', clientMessageId: 'b' })
    await waitFor(() => t.host.open(session.id).queue.find(q => q.id === receipt.queueId)?.error)
    const queued = t.host.open(session.id).queue.find(q => q.id === receipt.queueId)
    expect(parseCodedError(queued?.error)).toMatchObject({ code: 'resume.live', params: { source: 'other' } })
    expect(called('thread/start')).toHaveLength(starts)
    expect(t.host.open(session.id).record.engineSessionId).toBe(oldId)
  })

  it('列表上的「正开着」：锁文件在就标出（Windows 上读得到的是残留，不算），像素星空自己正占着的线程不算', async () => {
    const t = setup()
    const a = addThread(1, t.cwd, 1)
    const b = addThread(2, t.cwd, 1, { source: 'vscode' })
    const lockDir = join(codexHome(), 'thread-writer-locks')
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, `${a}.lock`), '')
    writeFileSync(join(lockDir, `${b}.lock`), '')
    const live = async (): Promise<Record<string, unknown>> =>
      Object.fromEntries((await t.host.nativeSessions(t.project.id, 'codex')).map(s => [s.id, s.live]))
    // 非 Windows：文件在就是 'maybe'；Windows：没有真被占着，读得到，是残留
    expect(await live()).toEqual({ [a]: IS_WINDOWS ? null : 'maybe', [b]: IS_WINDOWS ? null : 'maybe' })

    // 导入 a 并发一条消息：像素星空自己占着它，不算「别的程序正开着」（线程被占用的会排在 ownerId 里）
    const { sessionId } = await importIn(t, a)
    await say(t.host, sessionId, '新的', 1)
    const own = (): Set<string> => (t.adapter as unknown as { ownThreads: Set<string> }).ownThreads
    expect(own().has(a)).toBe(true)
    expect((await live())[a]).toBeNull()
    expect((await live())[b]).toBe(IS_WINDOWS ? null : 'maybe')
    // 会话关掉以后线程放开了，又会按锁文件标出来
    await t.host.shutdown()
    expect(own().has(a)).toBe(false)
    expect((t.adapter.nativeLive([{ id: a, mtimeMs: 0 }]).get(a) ?? null) === (IS_WINDOWS ? null : 'maybe')).toBe(true)
  })
})

describe('回退 / 分叉导入来的消息', { timeout: 20_000 }, () => {
  it('回退：pendingRewind 是被移除那轮的前一轮，线程这时没动；下次启动 thread/revert { beforeTurnId: 被移除的那轮 }', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 3)
    const { sessionId: id } = await importIn(t, x)
    await t.host.rewind(id, turnId(1, 2))
    expect(t.host.open(id).record.pendingRewind).toBe(turnId(1, 1))
    expect(userIds(t.host, id)).toEqual([turnId(1, 1)])
    expect(turnIds(x)).toHaveLength(3)

    await say(t.host, id, '改', 1)
    const sent = rpc()
    const reverts = sent.filter(m => m.method === 'thread/revert')
    expect(reverts).toHaveLength(1)
    expect(reverts[0].params).toEqual({ threadId: x, beforeTurnId: turnId(1, 2) })
    const order = sent.map(m => m.method)
    expect(order.indexOf('thread/resume')).toBeLessThan(order.indexOf('thread/revert'))
    expect(order.indexOf('thread/revert')).toBeLessThan(order.indexOf('turn/start'))
    expect(turnIds(x)).toHaveLength(2)
    expect(turnIds(x)[0]).toBe(turnId(1, 1))
    expect(called('thread/start')).toHaveLength(0)
  })

  /** 第 2 轮里除了第一条用户话，还有一条 steer 追加的 */
  function withSteer(x: string, turnIndex: number): void {
    const turns = threadsOf()[x]
    turns[turnIndex].items.splice(1, 0, {
      type: 'userMessage',
      id: 'steer-1',
      clientId: null,
      content: [{ type: 'text', text: '补充一句', text_elements: [] }],
    })
    write('threads.json', { [x]: turns })
  }

  it('一轮里有引导消息（-u1）、在最后一轮：回退到引导消息截不开半轮，开新线程，提示「无法在 Codex 记录中回退」，下一条消息带交接', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 2)
    withSteer(x, 1)
    const { sessionId: id } = await importIn(t, x)
    expect(userIds(t.host, id)).toEqual([turnId(1, 1), turnId(1, 2), `${turnId(1, 2)}-u1`])
    await t.host.rewind(id, `${turnId(1, 2)}-u1`)
    // 对话里这条引导消息已经删了；Codex 不能只回退半轮，所以不再接着 X：新线程 + 提示（不是悄悄留着）
    const record = t.host.open(id).record
    expect(record.engineSessionId ?? null).toBeNull()
    expect(record.pendingRewind ?? null).toBeNull()
    expect(userIds(t.host, id)).toEqual([turnId(1, 1), turnId(1, 2)])
    expect(notices(t.host, id).map(n => n.text)).toContain(
      '无法在 Codex 记录中回退到这条消息，已开始新的引擎会话，下一条消息会带上之前对话的交接',
    )
    await say(t.host, id, '改', 1)
    expect(called('thread/resume')).toHaveLength(0)
    expect(called('thread/revert')).toHaveLength(0)
    expect(called('thread/start')).toHaveLength(1)
    expect(turnIds(x)).toHaveLength(2)
  })

  it('引导消息在中间某一轮（后面还有一轮）：被移除的包括引导消息和后一轮，同样开新线程 + 提示，不留下半轮', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 3)
    withSteer(x, 1)
    const { sessionId: id } = await importIn(t, x)
    expect(userIds(t.host, id)).toEqual([turnId(1, 1), turnId(1, 2), `${turnId(1, 2)}-u1`, turnId(1, 3)])
    await t.host.rewind(id, `${turnId(1, 2)}-u1`)
    const record = t.host.open(id).record
    expect(record.engineSessionId ?? null).toBeNull()
    expect(record.pendingRewind ?? null).toBeNull()
    expect(notices(t.host, id).some(n => n.text.startsWith('无法在 Codex 记录中回退'))).toBe(true)
    // 回退到整轮（第 2 轮自己的话）照旧：截断点是第 1 轮
    const y = addThread(2, t.cwd, 3)
    withSteer(y, 1)
    const b = await importIn(t, y)
    await t.host.rewind(b.sessionId, turnId(2, 2))
    expect(t.host.open(b.sessionId).record.pendingRewind).toBe(turnId(2, 1))
  })

  it('分叉：分叉出的记录没有 imported，pendingFork.at 是被分叉消息的前一轮；原对话仍占着 X', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 3)
    const a = await importIn(t, x)
    const forked = await t.host.forkSession(a.sessionId, turnId(1, 3))
    expect(forked.record.imported).toBeNull()
    expect(forked.record.pendingFork).toEqual({ from: x, at: turnId(1, 2) })
    expect((await t.host.nativeSessions(t.project.id, 'codex'))[0].ownerId).toBe(a.sessionId)
    await say(t.host, forked.record.id, '分支', 2)
    expect(called('thread/fork')[0].params).toMatchObject({ threadId: x, lastTurnId: turnId(1, 2) })
    expect(turnIds(x)).toHaveLength(3)
  })
})

describe('加载更早的 / 补上', { timeout: 30_000 }, () => {
  it('加载更早的：60 轮的线程导入 50 轮，earlier 后 60 轮、顺序对、seen 不变；对新加进来的消息回退找得到截断点', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 60)
    const { sessionId: id, turns, shown } = await importIn(t, x)
    expect({ turns, shown }).toEqual({ turns: 60, shown: 50 })
    const first = t.host.open(id).items[0]
    expect(first).toMatchObject({
      kind: 'notice',
      text: '接着终端里的 Codex 会话 · 60 轮（更早的 10 轮没有显示）',
      action: { kind: 'native-earlier', count: 10 },
    })
    const seen = t.host.open(id).record.engineSessions?.codex?.seen
    await expect(t.host.nativeSessionAction(id, 'earlier')).resolves.toEqual({ added: 10 })
    const items = t.host.open(id).items
    expect(items[0]).toMatchObject({ id: first.id, kind: 'notice', text: '接着终端里的 Codex 会话 · 60 轮' })
    expect((items[0] as Notice).action).toBeUndefined()
    expect(userIds(t.host, id)).toEqual(Array.from({ length: 60 }, (_, k) => turnId(1, k + 1)))
    expect(new Set(items.map(i => i.id)).size).toBe(items.length)
    expect(t.host.open(id).record.engineSessions?.codex?.seen).toBe(seen)
    expect(t.host.open(id).record.imported).toMatchObject({ turns: 60, shown: 60 })
    expect(events.some(e => e.kind === 'session' && e.sessionId === id && e.event.type === 'items_reset')).toBe(true)

    // 对新加进来的消息回退：截断点是它之前的一轮
    await t.host.rewind(id, turnId(1, 5))
    expect(t.host.open(id).record.pendingRewind).toBe(turnId(1, 4))
    await say(t.host, id, '改', 1)
    expect(called('thread/revert')[0].params).toEqual({ threadId: x, beforeTurnId: turnId(1, 5) })
    expect(turnIds(x)).toHaveLength(5)
  })

  it('补上：终端里又聊了一轮，check 加提示，sync 接在后面、seen 跟着挪，下一条消息没有交接；追加的轮次没有用户消息时 check 是 0', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 2)
    const { sessionId: id } = await importIn(t, x)
    await expect(t.host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 0 })
    // 终端里 Codex 自己续跑了一轮（没有用户话）：不算新聊的
    appendTurns(x, fxTurn(1, 3, { items: [{ type: 'agentMessage', id: 'a-x', text: '后台任务结束', phase: null }] }))
    await expect(t.host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 0 })
    appendTurns(x, fxTurn(1, 4))
    await expect(t.host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 1 })
    expect(t.host.open(id).items.at(-1)).toMatchObject({
      kind: 'notice',
      text: NATIVE_TEXT.newer(1),
      action: { kind: 'native-sync', count: 1 },
    })
    // 再查一次不重复加提示
    await t.host.nativeSessionAction(id, 'check')
    expect(notices(t.host, id).filter(n => n.action?.kind === 'native-sync')).toHaveLength(1)

    await expect(t.host.nativeSessionAction(id, 'sync')).resolves.toEqual({ added: 1 })
    const items = t.host.open(id).items
    expect(userIds(t.host, id)).toEqual([turnId(1, 1), turnId(1, 2), turnId(1, 4)])
    expect(items.some(i => i.kind === 'notice' && i.action?.kind === 'native-sync')).toBe(false)
    expect(notices(t.host, id).some(n => n.text === NATIVE_TEXT.synced(1))).toBe(true)
    expect(t.host.open(id).record.engineSessions?.codex?.seen).toBe(items.at(-1)!.id)
    expect(t.host.open(id).record.imported).toMatchObject({ turns: 3, shown: 3 })
    await expect(t.host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 0 })

    await say(t.host, id, '接着', 1)
    expect(called('thread/inject_items')).toHaveLength(0)
    expect(notices(t.host, id).some(n => n.text.includes('交接') || n.level === 'warn')).toBe(false)
  })

  it('终端里正跑着一轮（锁文件说正开着）：check 不算这一轮、sync 不导入它；它跑完后下次 check 再补，回复完整', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 2)
    const { sessionId: id } = await importIn(t, x)
    appendTurns(x, fxTurn(1, 3, { status: 'inProgress' }, '半截'))
    const live = vi.spyOn(t.adapter, 'nativeLive').mockReturnValue(new Map([[x, 'terminal']]))
    await expect(t.host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 0 })
    await expect(t.host.nativeSessionAction(id, 'sync')).resolves.toEqual({ added: 0 })
    expect(userIds(t.host, id)).toEqual([turnId(1, 1), turnId(1, 2)])
    expect(t.host.open(id).record.imported).toMatchObject({ turns: 2 })
    // 不再开着（它也跑完了）：补上整轮
    live.mockReturnValue(new Map([[x, null]]))
    write('threads.json', {
      ...threadsOf(),
      [x]: threadsOf()[x].map(turn => (turn.id === turnId(1, 3) ? fxTurn(1, 3, {}, '写完了') : turn)),
    })
    const meta = metaOf()
    write('meta.json', { ...meta, [x]: { ...meta[x], updatedAt: Number(meta[x].updatedAt) + 10 } })
    await expect(t.host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 1 })
    await expect(t.host.nativeSessionAction(id, 'sync')).resolves.toEqual({ added: 1 })
    expect(userIds(t.host, id)).toEqual([turnId(1, 1), turnId(1, 2), turnId(1, 3)])
    const last = t.host.open(id).items.findLast(i => i.kind === 'assistant')
    expect(last).toMatchObject({ text: '写完了', status: 'completed' })
  })

  it('回退了还没发消息（线程还没截断）：check / sync 都是 0、不把回退掉的轮次当新聊的，撤销回退照样成功', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 3)
    const { sessionId: id } = await importIn(t, x)
    await t.host.rewind(id, turnId(1, 3))
    expect(t.host.open(id).record.pendingRewind).toBe(turnId(1, 2))
    expect(userIds(t.host, id)).toEqual([turnId(1, 1), turnId(1, 2)])
    const count = t.host.open(id).items.length
    await expect(t.host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 0 })
    await expect(t.host.nativeSessionAction(id, 'sync')).resolves.toEqual({ added: 0 })
    expect(t.host.open(id).items).toHaveLength(count)
    expect(t.host.open(id).record.pendingRewind).toBe(turnId(1, 2))

    await t.host.undoRewind(id)
    expect(userIds(t.host, id)).toEqual([turnId(1, 1), turnId(1, 2), turnId(1, 3)])
    expect(t.host.open(id).record.pendingRewind ?? null).toBeNull()
    appendTurns(x, fxTurn(1, 4))
    await expect(t.host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 1 })
  })

  it('回退到第一条（换了新线程）后，X 里再追加一轮：check 是 0；对话换了引擎会话但还留着前面的用户条目时同样是 0', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 3)
    const { sessionId: id } = await importIn(t, x)
    await t.host.rewind(id, turnId(1, 1))
    expect(t.host.open(id).record.engineSessionId).toBeNull()
    appendTurns(x, fxTurn(1, 4))
    await expect(t.host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 0 })
    await expect(t.host.nativeSessionAction(id, 'sync')).resolves.toEqual({ added: 0 })

    // 前面的用户条目还在、引擎会话换了（截断点找不到时 Codex 改开新线程）：X 里截断点之后的轮次不是新聊的
    const y = addThread(2, t.cwd, 3)
    const b = await importIn(t, y)
    await expect(t.host.nativeSessionAction(b.sessionId, 'check')).resolves.toEqual({ added: 0 })
    appendTurns(y, fxTurn(2, 4))
    await expect(t.host.nativeSessionAction(b.sessionId, 'check')).resolves.toEqual({ added: 1 })
    patchRecord(t.host, b.sessionId, { engineSessionId: 'fake-thread-9' })
    await expect(t.host.nativeSessionAction(b.sessionId, 'check')).resolves.toEqual({ added: 0 })
    await expect(t.host.nativeSessionAction(b.sessionId, 'sync')).resolves.toEqual({ added: 0 })
  })

  it('复制一份接着聊：回退换了新线程（不再接着 X）后拒绝，错误是 NATIVE_TEXT.notFollowing，不改记录', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 3)
    const { sessionId: id } = await importIn(t, x)
    await t.host.rewind(id, turnId(1, 1))
    expect(t.host.open(id).record.engineSessionId ?? null).toBeNull()
    const before = JSON.stringify(t.host.open(id).record)
    await expect(t.host.nativeSessionAction(id, 'copy')).rejects.toThrow(NATIVE_TEXT.notFollowing)
    expect(JSON.stringify(t.host.open(id).record)).toBe(before)
    // 回退还没执行时（pendingRewind）仍接着 X：放行，分叉点用待回退的位置
    const y = addThread(2, t.cwd, 3)
    const b = await importIn(t, y)
    await t.host.rewind(b.sessionId, turnId(2, 3))
    await expect(t.host.nativeSessionAction(b.sessionId, 'copy')).resolves.toEqual({ added: 0 })
    expect(t.host.open(b.sessionId).record.pendingFork).toEqual({ from: y, at: turnId(2, 2) })
  })

  it('复制的对话不补上：check / sync 都是 0', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 1)
    const { sessionId: id } = await importIn(t, x, 'copy')
    appendTurns(x, fxTurn(1, 2))
    await expect(t.host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 0 })
    await expect(t.host.nativeSessionAction(id, 'sync')).resolves.toEqual({ added: 0 })
  })
})

describe('线程记录不在了', { timeout: 20_000 }, () => {
  it('导入后 rollout 被删、resume 报找不到：整段聊天注入新线程，有中文 recreated 提示，没有英文「Could not resume」', async () => {
    const failFile = join(root, 'resume-fail')
    const t = setup({ env: { FAKE_CODEX_RESUME_FAIL_FILE: failFile } })
    const x = addThread(1, t.cwd, 2)
    const rollout = writeRollout(x)
    const { sessionId: id } = await importIn(t, x)
    rmSync(rollout)
    writeFileSync(failFile, '')
    await say(t.host, id, '还在吗', 1)
    expect(called('thread/resume')).toHaveLength(1)
    expect(called('thread/start')).toHaveLength(1)
    const injected = called('thread/inject_items')
    expect(injected).toHaveLength(1)
    expect(JSON.stringify(injected[0].params)).toContain('问题 1')
    const warns = notices(t.host, id).filter(n => n.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0].text).toBe(NATIVE_TEXT.recreated(2, 'Codex'))
    expect(warns[0].detail).toContain('问题 1')
    expect(notices(t.host, id).some(n => /Could not resume/.test(n.text))).toBe(false)
    // 换了新线程
    expect(t.host.open(id).record.engineSessionId).not.toBe(x)
  })

  it('注入失败退回文字交接时，「没能恢复」的英文提示照旧发', async () => {
    const failFile = join(root, 'resume-fail')
    const t = setup({ env: { FAKE_CODEX_RESUME_FAIL_FILE: failFile, FAKE_CODEX_INJECT_FAIL: '1' } })
    const x = addThread(1, t.cwd, 1)
    const rollout = writeRollout(x)
    const { sessionId: id } = await importIn(t, x)
    rmSync(rollout)
    writeFileSync(failFile, '')
    await say(t.host, id, '还在吗', 1)
    const texts = notices(t.host, id).map(n => n.text)
    expect(texts.some(s => /Could not resume the Codex thread/.test(s))).toBe(true)
    expect(texts.some(s => /Could not add the previous conversation/.test(s))).toBe(true)
  })

  it('rollout 还在、resume 却报错（版本不认、记录坏了）：导入的整段聊天注进新线程，提示「没能接上」并写明原因', async () => {
    const failFile = join(root, 'resume-fail')
    const t = setup({ env: { FAKE_CODEX_RESUME_FAIL_FILE: failFile } })
    const x = addThread(1, t.cwd, 2)
    writeRollout(x)
    const { sessionId: id } = await importIn(t, x)
    writeFileSync(failFile, '')
    await say(t.host, id, '还在吗', 1)
    expect(called('thread/resume')).toHaveLength(1)
    expect(called('thread/start')).toHaveLength(1)
    const injected = called('thread/inject_items')
    expect(injected).toHaveLength(1)
    expect(JSON.stringify(injected[0].params)).toContain('问题 1')
    expect(JSON.stringify(injected[0].params)).not.toContain('还在吗')
    const warns = notices(t.host, id).filter(n => n.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0].text).toBe(NATIVE_TEXT.resumeLost(2, 'Codex'))
    expect(warns[0].detail?.startsWith('thread/resume: ')).toBe(true)
    expect(warns[0].detail).toContain('问题 1')
    expect(notices(t.host, id).some(n => /Could not resume/.test(n.text))).toBe(false)
    expect(t.host.open(id).record.engineSessionId).not.toBe(x)
  })

  it('同上、注入也失败：聊天改成文字交接放在消息前面，不再说「之前的上下文没带过去」', async () => {
    const failFile = join(root, 'resume-fail')
    const t = setup({ env: { FAKE_CODEX_RESUME_FAIL_FILE: failFile, FAKE_CODEX_INJECT_FAIL: '1' } })
    const x = addThread(1, t.cwd, 1)
    writeRollout(x)
    const { sessionId: id } = await importIn(t, x)
    writeFileSync(failFile, '')
    await say(t.host, id, '还在吗', 1)
    const turn = called('turn/start').at(-1)
    expect(JSON.stringify(turn?.params)).toContain('问题 1')
    expect(JSON.stringify(turn?.params)).toContain('还在吗')
    const texts = notices(t.host, id).map(n => n.text)
    expect(texts).toContain(NATIVE_TEXT.resumeLost(1, 'Codex'))
    expect(texts.some(s => /Could not add the previous conversation/.test(s))).toBe(true)
    expect(texts.some(s => /previous context was not carried over/.test(s))).toBe(false)
  })

  it('rollout 还在时不触发；有待执行的回退时也不触发', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 2)
    writeRollout(x)
    const { sessionId: id } = await importIn(t, x)
    await say(t.host, id, '一', 1)
    expect(called('thread/inject_items')).toHaveLength(0)
    expect(notices(t.host, id).some(n => n.level === 'warn')).toBe(false)
  })
})

describe('modelProvider', { timeout: 20_000 }, () => {
  it('自己账号：resume / fork / start 都带 PIXELSKY_CODEX_PROVIDER（config 里的当前来源）', async () => {
    const t = setup()
    const x = addThread(1, t.cwd, 1)
    const y = addThread(2, t.cwd, 1)
    const a = await importIn(t, x)
    await say(t.host, a.sessionId, 'a', 1)
    const b = await importIn(t, y, 'copy')
    await say(t.host, b.sessionId, 'b', 2)
    const s = t.host.createSession({ projectId: t.project.id, engine: 'codex', model: 'fake-codex' })
    await say(t.host, s.id, 'c', 3)
    expect(called('thread/resume')[0].params?.modelProvider).toBe('fake')
    expect(called('thread/fork')[0].params?.modelProvider).toBe('fake')
    expect(called('thread/start')[0].params?.modelProvider).toBe('fake')
  })

  it('平台 / 自定义接口的会话：resume / fork / start 都带网关的 provider，导入终端（自己账号）的线程也一样', async () => {
    const t = setup({ env: { PIXELSKY_CODEX_BASE_URL: 'http://127.0.0.1:9/v1', PIXELSKY_CODEX_TOKEN: 'tok' } })
    const x = addThread(1, t.cwd, 1)
    const y = addThread(2, t.cwd, 1)
    const settings = { provider: { id: 'my-api' } }
    const a = await importIn(t, x, 'inplace', settings)
    await say(t.host, a.sessionId, 'a', 1)
    const b = await importIn(t, y, 'copy', settings)
    await say(t.host, b.sessionId, 'b', 2)
    const s = t.host.createSession({ projectId: t.project.id, engine: 'codex', model: 'fake-codex', ...settings })
    await say(t.host, s.id, 'c', 3)
    expect(called('thread/resume')[0].params?.modelProvider).toBe('pixelsky-custom')
    expect(called('thread/fork')[0].params?.modelProvider).toBe('pixelsky-custom')
    expect(called('thread/start')[0].params?.modelProvider).toBe('pixelsky-custom')
  })
})

describe('空闲后放开线程', { timeout: 20_000 }, () => {
  it('原地导入的 Codex 对话 2 分钟空闲就关进程，复制的和普通对话照旧', async () => {
    const t = setup({ idleMs: 3_600_000 })
    const x = addThread(1, t.cwd, 1)
    const y = addThread(2, t.cwd, 1)
    const inplace = await importIn(t, x)
    const copy = await importIn(t, y, 'copy')
    const plain = t.host.createSession({ projectId: t.project.id, engine: 'codex', model: 'fake-codex' })
    const delays: number[] = []
    const real = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === 120_000 || ms === 3_600_000) delays.push(ms)
      return real(fn, ms)
    }) as typeof setTimeout)
    await say(t.host, inplace.sessionId, 'a', 1)
    expect(delays.at(-1)).toBe(120_000)
    delays.length = 0
    await say(t.host, copy.sessionId, 'b', 2)
    expect(delays.at(-1)).toBe(3_600_000)
    delays.length = 0
    await say(t.host, plain.id, 'c', 3)
    expect(delays.at(-1)).toBe(3_600_000)
  })

  it('只在当前执行者是 Codex、并且还接着原线程时才缩短：回退换了新线程后按普通对话的空闲时间', async () => {
    const t = setup({ idleMs: 3_600_000 })
    const x = addThread(1, t.cwd, 2)
    const { sessionId: id } = await importIn(t, x)
    const delays: number[] = []
    const real = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === 120_000 || ms === 3_600_000) delays.push(ms)
      return real(fn, ms)
    }) as typeof setTimeout)
    await say(t.host, id, 'a', 1)
    expect(delays.at(-1)).toBe(120_000)
    // 回退到第一条：换了新线程，进程没有拿着 X 的写入锁
    await t.host.rewind(id, turnId(1, 1))
    expect(t.host.open(id).record.engineSessionId ?? null).toBeNull()
    delays.length = 0
    await say(t.host, id, 'b', 2)
    expect(t.host.open(id).record.engineSessionId).not.toBe(x)
    expect(delays.at(-1)).toBe(3_600_000)
  })

  it('idleMs 比 2 分钟还短时取短的', async () => {
    const t = setup({ idleMs: 50 })
    const x = addThread(1, t.cwd, 1)
    const { sessionId: id } = await importIn(t, x)
    await say(t.host, id, 'a', 1)
    await new Promise(r => setTimeout(r, 300))
    // 进程已关：再发一条要重新 thread/resume
    await say(t.host, id, 'b', 2)
    expect(called('thread/resume')).toHaveLength(2)
  })
})
