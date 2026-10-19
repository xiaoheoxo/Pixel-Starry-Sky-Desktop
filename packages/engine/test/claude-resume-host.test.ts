// 接着终端里的 Claude Code 会话：列表和占用、导入（原地 / 复制）、正开着、记录被删、回退 / 分叉、
// 加载更早的、补上（docs/ui/claude-resume.md §7 host 测试），用假 Claude（模拟真实记录链）
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  appendFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseCodedError, type HostEvent, type Item, type SessionRecord } from '@pixelsky/protocol'
import { ClaudeAdapter, EngineHost } from '../src'
import { NATIVE_TEXT } from '../src/claude/native'
import { helpersExited } from '../src/claude/helper'

const FAKE = fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url))

let root: string
let events: HostEvent[]
let hosts: EngineHost[]

function makeHost(): EngineHost {
  const projectsDir = join(root, 'claude-projects')
  const adapter = new ClaudeAdapter({
    launcher: { command: process.execPath, args: [FAKE] },
    projectsDir,
    env: {
      ...process.env,
      FAKE_CLAUDE_PROJECTS: projectsDir,
      FAKE_CLAUDE_LOG: join(root, 'argv.log'),
      FAKE_CLAUDE_CHAIN: '1',
      FAKE_CLAUDE_CHAIN_LOG: join(root, 'chain.log'),
    },
  })
  const host = new EngineHost({
    dataDir: join(root, 'data'),
    emit: e => events.push(e),
    idleMs: 60_000,
    adapters: { claude: adapter },
  })
  hosts.push(host)
  return host
}

const spawnArgs = (): string[][] => {
  try {
    return readFileSync(join(root, 'argv.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as string[])
  } catch {
    return []
  }
}
const visible = (): string[][] =>
  readFileSync(join(root, 'chain.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as string[])
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pixelsky-resume-'))
  events = []
  hosts = []
})
afterEach(async () => {
  await Promise.all(hosts.map(h => h.shutdown()))
  await helpersExited()
  rmSync(root, { recursive: true, force: true })
})

const uu = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const SID = '11111111-1111-4111-8111-111111111111'
const SID2 = '22222222-2222-4222-8222-222222222222'
const T0 = Date.parse('2026-10-01T00:00:00Z')

const dirOf = (cwd: string): string => join(root, 'claude-projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))

/** 一份终端里的会话记录：count 轮，user = uu(2k-1)，assistant = uu(2k)；from 是起始轮号，parent 是前一条 */
function rowsOf(sid: string, cwd: string, count: number, from = 1, parent: string | null = null): string {
  let last = parent
  const lines: string[] = []
  for (let k = from; k < from + count; k++) {
    const base = {
      isSidechain: false,
      userType: 'external',
      cwd,
      sessionId: sid,
      version: '2.1.300',
      gitBranch: 'main',
    }
    lines.push(
      JSON.stringify({
        ...base,
        type: 'user',
        uuid: uu(2 * k - 1),
        parentUuid: last,
        entrypoint: 'cli',
        origin: { kind: 'human' },
        timestamp: new Date(T0 + k * 2000).toISOString(),
        message: { role: 'user', content: `问题 ${k}` },
        text: `问题 ${k}`,
      }),
      JSON.stringify({
        ...base,
        type: 'assistant',
        uuid: uu(2 * k),
        parentUuid: uu(2 * k - 1),
        timestamp: new Date(T0 + k * 2000 + 1000).toISOString(),
        message: { role: 'assistant', model: 'claude-opus-4-5', content: [{ type: 'text', text: `回答 ${k}` }] },
      }),
    )
    last = uu(2 * k)
  }
  return lines.join('\n') + '\n'
}

function writeNative(cwd: string, sid: string, count: number): string {
  mkdirSync(dirOf(cwd), { recursive: true })
  const file = join(dirOf(cwd), `${sid}.jsonl`)
  writeFileSync(file, rowsOf(sid, cwd, count))
  return file
}

function setup() {
  const host = makeHost()
  const cwd = mkdtempSync(join(root, 'proj-'))
  const project = host.addProject(cwd)
  return { host, project, cwd: project.path }
}

type Imported = { sessionId: string; model: string | null; turns: number; shown: number }
async function importIn(
  host: EngineHost,
  projectId: string,
  nativeId = SID,
  mode: 'inplace' | 'copy' = 'inplace',
): Promise<Imported> {
  const res = await host.importNativeSession(projectId, 'claude', nativeId, { mode })
  if (!('sessionId' in res)) throw new Error(`没有建对话：${JSON.stringify(res)}`)
  return res
}

async function say(host: EngineHost, id: string, text: string, n: number): Promise<void> {
  const before = turnsDone(id)
  await host.send(id, { text, clientMessageId: `msg-${n}` })
  await waitFor(() => turnsDone(id) === before + 1)
}

const notices = (host: EngineHost, id: string) =>
  host.open(id).items.filter((i): i is Extract<Item, { kind: 'notice' }> => i.kind === 'notice')
const userIds = (host: EngineHost, id: string): string[] =>
  host.open(id).items.flatMap(i => (i.kind === 'user' ? [i.id] : []))
const records = (host: EngineHost): Map<string, SessionRecord> =>
  (host as unknown as { ctx: { records: Map<string, SessionRecord> } }).ctx.records

describe('列表和占用', () => {
  it('列出文件夹里的会话；第二步补最后一句、标题、模型；坏的 id 被拒', async () => {
    const { host, project, cwd } = setup()
    writeNative(cwd, SID, 2)
    const list = await host.nativeSessions(project.id, 'claude')
    expect(list).toHaveLength(1)
    // 读不到 pid 登记目录、记录又是刚写的：只能说「可能还开着」
    expect(list[0]).toMatchObject({ id: SID, source: 'terminal', ownerId: null, live: 'maybe', subdir: null })
    mkdirSync(join(root, 'sessions'))
    expect((await host.nativeSessions(project.id, 'claude'))[0].live).toBeNull()
    expect(list[0].lastPrompt).toBeNull()
    const details = await host.nativeSessionDetails(project.id, 'claude', [SID, '../x'])
    expect(details).toHaveLength(1)
    expect(details[0]).toMatchObject({ id: SID, model: 'claude-opus-4-5', skipped: false })
    await expect(host.importNativeSession(project.id, 'claude', '../x')).rejects.toThrow('会话 id 不对')
    await expect(host.nativeSessionAction(project.id, 'earlier')).rejects.toThrow()
  })

  it('占用：id / engineSessionId / engineSessions（任何引擎）/ pendingFork.from / imported 都算，选 owner 是确定的', async () => {
    const { host, project, cwd } = setup()
    writeNative(cwd, SID, 1)
    const owner = async (): Promise<string | null> => (await host.nativeSessions(project.id, 'claude'))[0].ownerId
    const make = (patch: Partial<SessionRecord>): SessionRecord => {
      const record = host.createSession({ projectId: project.id })
      const next = { ...record, ...patch }
      records(host).set(next.id, next)
      return next
    }
    expect(await owner()).toBeNull()
    // 只出现在 engineSessions.claude.id，当前引擎是 Codex
    const a = make({ engine: 'codex', engineSessions: { claude: { id: SID, seen: null } }, updatedAt: 10 })
    expect(await owner()).toBe(a.id)
    records(host).delete(a.id)
    // 只出现在 engineSessions.codex.id（不分引擎比）
    const b = make({ engineSessions: { codex: { id: SID, seen: null } }, updatedAt: 10 })
    expect(await owner()).toBe(b.id)
    records(host).delete(b.id)
    // 只出现在记录 id
    const c = host.createSession({ projectId: project.id })
    const renamed = { ...c, id: SID }
    records(host).delete(c.id)
    records(host).set(SID, renamed)
    expect(await owner()).toBe(SID)
    records(host).delete(SID)
    // 只出现在记录上的 pendingFork.from
    const d = make({ pendingFork: { from: SID, at: 'x' } })
    expect(await owner()).toBe(d.id)
    records(host).delete(d.id)
    // 只出现在 engineSessions.*.pendingFork.from
    const e = make({ engineSessions: { codex: { id: null, seen: null, pendingFork: { from: SID, at: 'x' } } } })
    expect(await owner()).toBe(e.id)
    records(host).delete(e.id)
    // 导入标记
    const f = make({ imported: { engine: 'claude', sessionId: SID, at: 1, turns: 1, shown: 1, forked: true } })
    expect(await owner()).toBe(f.id)
    // 多条命中：当前在用 > engineSessions > 导入 > 分叉待启动；同级取最近更新的
    const g = make({ pendingFork: { from: SID, at: 'x' }, updatedAt: Date.now() + 5000 })
    expect(await owner()).toBe(f.id)
    const h = make({ engineSessions: { claude: { id: SID, seen: null } }, updatedAt: 1 })
    expect(await owner()).toBe(h.id)
    const i = make({ engineSessionId: SID, updatedAt: 0 })
    expect(await owner()).toBe(i.id)
    const j = make({ engineSessionId: SID, updatedAt: 99 })
    expect(await owner()).toBe(j.id)
    expect(g.id).not.toBe(j.id)
  })
})

describe('导入：原地接着', () => {
  it('建对话、条目、engineSessionId 和 seen；发消息 --resume X 且没有交接；再列显示被占用，重复导入返回 ownerId', async () => {
    const { host, project, cwd } = setup()
    const file = writeNative(cwd, SID, 2)
    const before = host.sessions().length
    const res = await importIn(host, project.id)
    expect(res).toMatchObject({ model: 'claude-opus-4-5', turns: 2, shown: 2 })
    expect(host.sessions()).toHaveLength(before + 1)
    const id = res.sessionId
    const snap = host.open(id)
    expect(snap.record).toMatchObject({ engine: 'claude', engineSessionId: SID, cwd })
    expect(snap.record.imported).toMatchObject({ engine: 'claude', sessionId: SID, turns: 2, shown: 2 })
    expect(snap.record.imported?.forked).toBeUndefined()
    expect(snap.record.title).toBe('问题 1')
    expect(snap.items[0]).toMatchObject({ kind: 'notice', text: '接着终端里的 Claude Code 会话 · 2 轮' })
    expect(userIds(host, id)).toEqual([uu(1), uu(3)])
    expect(snap.items.filter(i => i.kind === 'user').every(i => i.kind === 'user' && i.engine === 'claude')).toBe(true)
    expect(snap.record.engineSessions?.claude).toEqual({ id: SID, seen: snap.items.at(-1)!.id })

    await say(host, id, '新的', 1)
    const args = spawnArgs().at(-1)!
    expect(args[args.indexOf('--resume') + 1]).toBe(SID)
    expect(args).not.toContain('--session-id')
    expect(args).not.toContain('--fork-session')
    // 模型能看到终端里的两轮，像素星空没有再带交接
    expect(visible().at(-1)).toEqual(['问题 1', '问题 2'])
    expect(notices(host, id)).toHaveLength(1)
    expect(readFileSync(file, 'utf8')).toContain('re:新的')

    expect((await host.nativeSessions(project.id, 'claude'))[0].ownerId).toBe(id)
    await expect(host.importNativeSession(project.id, 'claude', SID)).resolves.toEqual({ ownerId: id })
    await expect(host.importNativeSession(project.id, 'claude', SID, { mode: 'copy' })).resolves.toEqual({
      ownerId: id,
    })
  })

  it('子文件夹里开的会话：默认就列（带 subdir），已删的子文件夹不列；导入后 cwd 是子文件夹，--resume X 找得到记录', async () => {
    const { host, project, cwd } = setup()
    const sub = join(cwd, 'pkg', 'app')
    mkdirSync(sub, { recursive: true })
    const gone = join(cwd, 'removed')
    writeNative(sub, SID, 2)
    writeNative(gone, SID2, 1)
    const list = await host.nativeSessions(project.id, 'claude')
    expect(list.map(s => [s.id, s.subdir])).toEqual([[SID, 'pkg/app']])
    const res = await importIn(host, project.id)
    const id = res.sessionId
    const snap = host.open(id)
    expect(snap.record).toMatchObject({ engineSessionId: SID, cwd: sub })
    expect(userIds(host, id)).toEqual([uu(1), uu(3)])
    await say(host, id, '新的', 1)
    const args = spawnArgs().at(-1)!
    expect(args[args.indexOf('--resume') + 1]).toBe(SID)
    expect(visible().at(-1)).toEqual(['问题 1', '问题 2'])
    expect(readFileSync(join(dirOf(sub), `${SID}.jsonl`), 'utf8')).toContain('re:新的')
    expect((await host.nativeSessions(project.id, 'claude'))[0].ownerId).toBe(id)
    expect(await host.nativeSessions(project.id, 'claude', { subfolders: false })).toEqual([])
  })

  it('导入前文件已经没了：报「已经不在了」，不建对话', async () => {
    const { host, project, cwd } = setup()
    const file = writeNative(cwd, SID, 1)
    await host.nativeSessions(project.id, 'claude')
    rmSync(file)
    const before = host.sessions().length
    await expect(host.importNativeSession(project.id, 'claude', SID)).rejects.toThrow(NATIVE_TEXT.gone)
    expect(host.sessions()).toHaveLength(before)
  })

  it('导入大文件时能取消：不建对话', async () => {
    const { host, project, cwd } = setup()
    writeNative(cwd, SID, 3)
    const before = host.sessions().length
    const pending = host.importNativeSession(project.id, 'claude', SID, { token: 'tok' })
    host.cancelNativeImport('tok')
    await expect(pending).rejects.toThrow(NATIVE_TEXT.cancelled)
    expect(host.sessions()).toHaveLength(before)
  })

  it('导入后记录被删：下一条消息用接力把聊天写进同 id 的新记录，参数 --resume X，并提示', async () => {
    const { host, project, cwd } = setup()
    const file = writeNative(cwd, SID, 2)
    const { sessionId: id } = await importIn(host, project.id)
    rmSync(file)
    await say(host, id, '还在吗', 1)
    const args = spawnArgs().at(-1)!
    expect(args[args.indexOf('--resume') + 1]).toBe(SID)
    const rows = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as { type?: string; uuid?: string })
    // 接力行的用户行 uuid 就是我们的条目 id
    expect(rows.filter(r => r.type === 'user').map(r => r.uuid)).toEqual(expect.arrayContaining([uu(1), uu(3)]))
    // 接力写进去的行没有 text 字段，只看条数：导入的两轮都在新记录的上下文里
    expect(visible().at(-1)).toHaveLength(2)
    const warn = notices(host, id).find(n => n.level === 'warn')
    expect(warn?.text).toBe(NATIVE_TEXT.recreated(2))
    expect(warn?.detail).toContain('问题 1')
  })
})

describe('导入：复制一份接着聊', () => {
  it('记录是还没启动的分叉；--resume X --fork-session --session-id；原会话一个字节不动；X 仍算被占用', async () => {
    const { host, project, cwd } = setup()
    const file = writeNative(cwd, SID, 2)
    const old = new Date(Date.now() - 3_600_000)
    utimesSync(file, old, old)
    const content = readFileSync(file, 'utf8')
    const mtime = statSync(file).mtimeMs
    const { sessionId: id } = await importIn(host, project.id, SID, 'copy')
    const record = host.open(id).record
    expect(record.engineSessionId).toBeNull()
    expect(record.pendingFork).toEqual({ from: SID, at: uu(4) })
    expect(record.imported).toMatchObject({ sessionId: SID, forked: true })
    expect(record.engineSessions?.claude).toEqual({ id: null, seen: host.open(id).items.at(-1)!.id })
    expect(host.open(id).items[0]).toMatchObject({
      text: '复制了终端里的 Claude Code 会话 · 2 轮（原会话不动，两边可以同时用）',
    })
    expect((await host.nativeSessions(project.id, 'claude'))[0].ownerId).toBe(id)

    await say(host, id, '新的', 1)
    const args = spawnArgs().at(-1)!
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 6)).toEqual([
      '--resume',
      SID,
      '--fork-session',
      '--session-id',
      id,
      `--resume-session-at=${uu(4)}`,
    ])
    expect(readFileSync(file, 'utf8')).toBe(content)
    expect(statSync(file).mtimeMs).toBe(mtime)
    expect(visible().at(-1)).toEqual(['问题 1', '问题 2'])
    expect(host.open(id).record).toMatchObject({ engineSessionId: id, pendingFork: null })
    expect((await host.nativeSessions(project.id, 'claude'))[0].ownerId).toBe(id)
  })

  it('启动前先回退一条导入的消息：pendingFork.at 改成新的截断点', async () => {
    const { host, project, cwd } = setup()
    writeNative(cwd, SID, 2)
    const { sessionId: id } = await importIn(host, project.id, SID, 'copy')
    await host.rewind(id, uu(3))
    expect(userIds(host, id)).toEqual([uu(1)])
    expect(host.open(id).record.pendingFork).toEqual({ from: SID, at: uu(2) })
    await say(host, id, '改', 1)
    const args = spawnArgs().at(-1)!
    expect(args).toContain(`--resume-session-at=${uu(2)}`)
    expect(visible().at(-1)).toEqual(['问题 1'])
  })
})

describe('正开着', () => {
  const register = (entrypoint: string, sid = SID): void => {
    mkdirSync(join(root, 'sessions'), { recursive: true })
    writeFileSync(
      join(root, 'sessions', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: sid, kind: 'interactive', entrypoint }),
    )
  }

  it('列表标出开着；原地导入返回 live 不建对话；复制不拦', async () => {
    const { host, project, cwd } = setup()
    writeNative(cwd, SID, 1)
    register('cli')
    expect((await host.nativeSessions(project.id, 'claude'))[0].live).toBe('terminal')
    const before = host.sessions().length
    await expect(host.importNativeSession(project.id, 'claude', SID)).resolves.toEqual({ live: 'terminal' })
    expect(host.sessions()).toHaveLength(before)
    register('sdk-cli')
    await expect(host.importNativeSession(project.id, 'claude', SID, { mode: 'inplace' })).resolves.toEqual({
      live: 'other',
    })
    const copy = await importIn(host, project.id, SID, 'copy')
    expect(host.open(copy.sessionId).record.imported?.forked).toBe(true)
  })

  it('原地导入以后终端又开了：发消息失败（resume.live），X 没被写；改成复制后重试成功', async () => {
    const { host, project, cwd } = setup()
    const file = writeNative(cwd, SID, 2)
    const { sessionId: id } = await importIn(host, project.id)
    const content = readFileSync(file, 'utf8')
    register('cli')
    const spawns = spawnArgs().length
    const receipt = await host.send(id, { text: '来了', clientMessageId: 'live-1' })
    await waitFor(() => turnsDone(id) === 1)
    const failed = events
      .flatMap(e => (e.kind === 'session' && e.sessionId === id && e.event.type === 'turn_completed' ? [e.event] : []))
      .at(-1)!
    expect(failed).toMatchObject({ outcome: 'failed' })
    expect(parseCodedError(failed.type === 'turn_completed' ? failed.error : null)).toMatchObject({
      code: 'resume.live',
      params: { source: 'terminal' },
    })
    const queued = host.open(id).queue.find(q => q.id === receipt.queueId)
    expect(parseCodedError(queued?.error)?.code).toBe('resume.live')
    expect(spawnArgs()).toHaveLength(spawns)
    expect(readFileSync(file, 'utf8')).toBe(content)

    await expect(host.nativeSessionAction(id, 'copy')).resolves.toEqual({ added: 0 })
    expect(host.open(id).record).toMatchObject({
      engineSessionId: null,
      pendingFork: { from: SID, at: uu(4) },
      imported: { forked: true },
    })
    await host.runQueuedNow(id, receipt.queueId)
    await waitFor(() => turnsDone(id) === 2)
    const args = spawnArgs().at(-1)!
    expect(args).toContain('--fork-session')
    expect(args[args.indexOf('--resume') + 1]).toBe(SID)
    expect(readFileSync(file, 'utf8')).toBe(content)
    expect(visible().at(-1)).toEqual(['问题 1', '问题 2'])
  })
})

describe('回退 / 分叉导入来的消息', () => {
  it('回退：--resume-session-at 是它的 parentUuid；分叉：--fork-session，分叉出的记录没有 imported', async () => {
    const { host, project, cwd } = setup()
    writeNative(cwd, SID, 3)
    writeNative(cwd, SID2, 3)
    const a = await importIn(host, project.id, SID)
    await host.rewind(a.sessionId, uu(3))
    expect(host.open(a.sessionId).record.pendingRewind).toBe(uu(2))
    await say(host, a.sessionId, '改', 1)
    expect(spawnArgs().at(-1)).toContain(`--resume-session-at=${uu(2)}`)
    expect(visible().at(-1)).toEqual(['问题 1'])

    const b = await importIn(host, project.id, SID2)
    const forked = await host.forkSession(b.sessionId, uu(5))
    expect(forked.record.imported).toBeNull()
    expect(forked.record.pendingFork).toEqual({ from: SID2, at: uu(4) })
    // 原对话仍然占着 SID2，分叉出的不认领
    expect((await host.nativeSessions(project.id, 'claude')).find(s => s.id === SID2)?.ownerId).toBe(b.sessionId)
    await say(host, forked.record.id, '分支', 2)
    expect(spawnArgs().at(-1)).toContain('--fork-session')
    expect(visible().at(-1)).toEqual(['问题 1', '问题 2'])
  })
})

describe('加载更早的 / 补上', () => {
  it('加载更早的：条目多了、顺序对、seen 不变、事件 items_reset，再回退新加的消息找得到截断点', async () => {
    const { host, project, cwd } = setup()
    writeNative(cwd, SID, 60)
    const { sessionId: id, turns, shown } = await importIn(host, project.id)
    expect({ turns, shown }).toEqual({ turns: 60, shown: 50 })
    const first = host.open(id).items[0]
    expect(first).toMatchObject({
      kind: 'notice',
      text: '接着终端里的 Claude Code 会话 · 60 轮（更早的 10 轮没有显示）',
      action: { kind: 'native-earlier', count: 10 },
    })
    const seen = host.open(id).record.engineSessions?.claude?.seen
    await expect(host.nativeSessionAction(id, 'earlier')).resolves.toEqual({ added: 10 })
    const items = host.open(id).items
    expect(items[0]).toMatchObject({ id: first.id, kind: 'notice', text: '接着终端里的 Claude Code 会话 · 60 轮' })
    expect((items[0] as Extract<Item, { kind: 'notice' }>).action).toBeUndefined()
    expect(userIds(host, id)).toEqual(Array.from({ length: 60 }, (_, k) => uu(2 * k + 1)))
    expect(new Set(items.map(i => i.id)).size).toBe(items.length)
    expect(host.open(id).record.engineSessions?.claude?.seen).toBe(seen)
    expect(host.open(id).record.imported).toMatchObject({ turns: 60, shown: 60 })
    expect(events.some(e => e.kind === 'session' && e.sessionId === id && e.event.type === 'items_reset')).toBe(true)

    // 对新加进来的消息回退：截断点是它之前的 assistant
    await host.rewind(id, uu(9))
    expect(host.open(id).record.pendingRewind).toBe(uu(8))
    await say(host, id, '改', 1)
    expect(spawnArgs().at(-1)).toContain(`--resume-session-at=${uu(8)}`)
    expect(visible().at(-1)).toEqual(['问题 1', '问题 2', '问题 3', '问题 4'])
  })

  it('补上：终端里又聊了一轮，check 加提示，sync 接在后面、seen 跟着挪，下一条消息没有交接；再查是 0', async () => {
    const { host, project, cwd } = setup()
    const file = writeNative(cwd, SID, 2)
    const { sessionId: id } = await importIn(host, project.id)
    await expect(host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 0 })
    appendFileSync(file, rowsOf(SID, cwd, 1, 3, uu(4)))
    await expect(host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 1 })
    expect(host.open(id).items.at(-1)).toMatchObject({
      kind: 'notice',
      text: NATIVE_TEXT.newer(1),
      action: { kind: 'native-sync', count: 1 },
    })
    // 再查一次不重复加提示
    await host.nativeSessionAction(id, 'check')
    expect(notices(host, id).filter(n => n.action?.kind === 'native-sync')).toHaveLength(1)

    await expect(host.nativeSessionAction(id, 'sync')).resolves.toEqual({ added: 1 })
    const items = host.open(id).items
    expect(userIds(host, id)).toEqual([uu(1), uu(3), uu(5)])
    expect(items.some(i => i.kind === 'notice' && i.action?.kind === 'native-sync')).toBe(false)
    expect(notices(host, id).some(n => n.text === NATIVE_TEXT.synced(1))).toBe(true)
    expect(host.open(id).record.engineSessions?.claude?.seen).toBe(items.at(-1)!.id)
    expect(host.open(id).record.imported).toMatchObject({ turns: 3, shown: 3 })
    await expect(host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 0 })

    await say(host, id, '接着', 1)
    expect(visible().at(-1)).toEqual(['问题 1', '问题 2', '问题 3'])
    expect(notices(host, id).some(n => n.text.includes('交接') || n.level === 'warn')).toBe(false)
  })

  it('回退了还没发消息（原生记录还没截断）：check / sync 都是 0、不把回退掉的轮次当新聊的，撤销回退照样成功', async () => {
    const { host, project, cwd } = setup()
    const file = writeNative(cwd, SID, 3)
    const { sessionId: id } = await importIn(host, project.id)
    await host.rewind(id, uu(3))
    expect(host.open(id).record.pendingRewind).toBe(uu(2))
    expect(userIds(host, id)).toEqual([uu(1)])
    const count = host.open(id).items.length
    await expect(host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 0 })
    await expect(host.nativeSessionAction(id, 'sync')).resolves.toEqual({ added: 0 })
    expect(host.open(id).items).toHaveLength(count)
    expect(host.open(id).record.pendingRewind).toBe(uu(2))

    await host.undoRewind(id)
    expect(userIds(host, id)).toEqual([uu(1), uu(3), uu(5)])
    expect(host.open(id).record.pendingRewind ?? null).toBeNull()
    // 撤销以后照常查
    appendFileSync(file, rowsOf(SID, cwd, 1, 4, uu(6)))
    await expect(host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 1 })
  })

  it('回退后发了新消息（截断点用掉了）：被回退掉的轮次不再算终端里新聊的', async () => {
    const { host, project, cwd } = setup()
    writeNative(cwd, SID, 3)
    const { sessionId: id } = await importIn(host, project.id)
    await host.rewind(id, uu(3))
    await say(host, id, '改', 1)
    expect(host.open(id).record.pendingRewind ?? null).toBeNull()
    await expect(host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 0 })
    expect(notices(host, id).some(n => n.action?.kind === 'native-sync')).toBe(false)
  })

  it('对话已经换了引擎会话（回退找不到截断点、回退到第一条）：原会话里的新轮次不再算「终端里新聊的」，check / sync 都是 0', async () => {
    const { host, project, cwd } = setup()
    const file = writeNative(cwd, SID, 3)
    const { sessionId: id } = await importIn(host, project.id)
    appendFileSync(file, rowsOf(SID, cwd, 1, 4, uu(6)))
    await expect(host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 1 })
    // 回退找不到截断点时宿主给对话换一个新的引擎会话 id，imported.sessionId 还是原来的；前面的用户条目都还在
    const patch = (host as unknown as { m: { events: { patchRecord(id: string, p: Partial<SessionRecord>): void } } }).m
    patch.events.patchRecord(id, { engineSessionId: '99999999-9999-4999-8999-999999999999' })
    await expect(host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 0 })
    await expect(host.nativeSessionAction(id, 'sync')).resolves.toEqual({ added: 0 })
    // 回退到第一条：新会话的 id 也不是 X
    await host.rewind(id, uu(1))
    await expect(host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 0 })
  })

  it('复制的对话不补上：check / sync 都是 0', async () => {
    const { host, project, cwd } = setup()
    const file = writeNative(cwd, SID, 1)
    const { sessionId: id } = await importIn(host, project.id, SID, 'copy')
    appendFileSync(file, rowsOf(SID, cwd, 1, 2, uu(2)))
    await expect(host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 0 })
    await expect(host.nativeSessionAction(id, 'sync')).resolves.toEqual({ added: 0 })
  })
})
