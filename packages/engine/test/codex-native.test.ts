// 接着 Codex 的终端会话：读取层（docs/ui/codex-resume.md §3、§4.1-4.3、§4.8、§7、§8「单测」）
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Item } from '@pixelsky/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearCodexCaches,
  codexItems,
  codexThreadDetail,
  codexThreadExists,
  codexThreadName,
  codexTitle,
  codexTurnIndex,
  liveCodexThreads,
  listCodexThreads,
  newerCodexTurns,
  readCodexThread,
  type CodexTurn,
} from '../src/codex/native'
import { findCodexRollouts } from '../src/codex/runs'
import { CodexReader, readerLaunchKey, type CodexRpc, type ReaderLaunch, type ReaderProcess } from '../src/codex/reader'
import type { Message } from '../src/codex/process'
import { IS_WINDOWS } from '../src/exec'
import { HANDOFF_TAG } from '../src/handoff'
import { splitIdeContext } from '../src/native/prompt'
import { QUICK_CLOSE_MS } from '../src/adapter'
import { NATIVE_TEXT } from '../src/native/text'

// codexThreadExists 先查创建日的目录；findCodexRollouts（全扫）只在那里没找到时才该被调用
vi.mock('../src/codex/runs', async importActual => {
  const actual = await importActual<typeof import('../src/codex/runs')>()
  return { ...actual, findCodexRollouts: vi.fn(actual.findCodexRollouts) }
})

let root: string
let proj: string
beforeEach(() => {
  vi.mocked(findCodexRollouts).mockClear()
  root = mkdtempSync(join(tmpdir(), 'pixelsky-codexnative-'))
  proj = join(root, 'proj')
  mkdirSync(proj, { recursive: true })
  clearCodexCaches()
  // 缓存按「取数据时的本机时间」决定要不要核对最后一轮：默认时钟定在 updatedAt（T0 + 100）那一秒里
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime((T0 + 100) * 1000 + 500)
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

// ---------- 手写的 Thread / Turn ----------

const tid = (n: number): string => `0199aaaa-0000-7000-8000-${String(n).padStart(12, '0')}`
const T0 = Date.parse('2026-10-01T00:00:00Z') / 1000
const text = (t: string): Message => ({ type: 'text', text: t, text_elements: [] })
const user = (id: string, t: string, clientId: string | null = null, more: Message[] = []): Message => ({
  type: 'userMessage',
  id,
  clientId,
  content: [text(t), ...more],
})
const agent = (id: string, t: string): Message => ({ type: 'agentMessage', id, text: t, phase: null })
const turn = (id: string, items: Message[], more: Message = {}): CodexTurn => ({
  id,
  items,
  itemsView: 'full',
  status: 'completed',
  error: null,
  startedAt: T0 + 10,
  completedAt: T0 + 20,
  ...more,
})
/** 一个普通的轮：用户话 + 回复 */
const simple = (n: number, prompt = `问题 ${n}`, more: Message = {}): CodexTurn =>
  turn(`turn-${n}`, [user(`u-${n}`, prompt, null), agent(`a-${n}`, `回答 ${n}`)], { startedAt: T0 + n * 60, ...more })

interface Fixture {
  meta: Message
  turns: CodexTurn[]
}
const thread = (id: string, over: Message = {}): Message => ({
  id,
  parentThreadId: null,
  preview: '帮我看看这个',
  ephemeral: false,
  historyMode: 'paginated',
  modelProvider: 'openai',
  model: 'gpt-5.5',
  createdAt: T0,
  updatedAt: T0 + 100,
  path: null,
  cwd: proj,
  originator: 'codex_cli_rs',
  source: 'cli',
  gitInfo: { sha: null, branch: 'main', originUrl: null },
  name: null,
  turns: [],
  ...over,
})

/** 内存里的假 app-server：thread/list、thread/read、thread/turns/list，记下每次请求 */
class FakeRpc implements CodexRpc {
  readonly threads = new Map<string, Fixture>()
  readonly calls: { method: string; params: Message }[] = []
  add(meta: Message, turns: CodexTurn[] = []): this {
    this.threads.set(String(meta.id), { meta, turns })
    return this
  }
  of(method: string): Message[] {
    return this.calls.filter(c => c.method === method).map(c => c.params)
  }
  async request(method: string, params: Message, signal?: AbortSignal): Promise<Message> {
    signal?.throwIfAborted()
    this.calls.push({ method, params })
    const p = params as Record<string, unknown>
    if (method === 'thread/list') {
      const rows = [...this.threads.values()].map(f => f.meta).sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
      const size = Number(p.limit) || rows.length,
        start = Number(p.cursor) || 0
      return {
        data: rows.slice(start, start + size),
        nextCursor: start + size < rows.length ? String(start + size) : null,
        backwardsCursor: null,
      }
    }
    const f = this.threads.get(String(p.threadId))
    if (!f) throw new Error(`thread not loaded: ${String(p.threadId)}`)
    if (method === 'thread/read') return { thread: { ...f.meta, turns: [] } }
    if (method === 'thread/turns/list') {
      const ordered = p.sortDirection === 'asc' ? f.turns : [...f.turns].reverse()
      const size = Number(p.limit) || ordered.length,
        start = Number(p.cursor) || 0
      const full = p.itemsView === 'full'
      return {
        data: ordered.slice(start, start + size).map(t => {
          if (full) return t
          const items = array(t.items)
          const first = items.find(i => i.type === 'userMessage')
          const reply = [...items].reverse().find(i => i.type === 'agentMessage')
          return { ...t, itemsView: 'summary', items: [first, reply].filter(Boolean) }
        }),
        nextCursor: start + size < ordered.length ? String(start + size) : null,
        backwardsCursor: null,
      }
    }
    throw new Error('unexpected ' + method)
  }
}
const array = (v: unknown): Message[] => (Array.isArray(v) ? (v as Message[]) : [])

const kinds = (items: Item[]): string[] => items.map(i => i.kind)
const users = (items: Item[]): string[] => items.filter(i => i.kind === 'user').map(i => i.id)
const notices = (items: Item[]): { text: string; detail?: string | null; level: string }[] =>
  items.flatMap(i => (i.kind === 'notice' ? [{ text: i.text, detail: i.detail, level: i.level }] : []))

/** n 轮的线程（可以带每轮的额外条目数） */
const manyTurns = (n: number, extra = 0): CodexTurn[] =>
  Array.from({ length: n }, (_, i) =>
    turn(
      `turn-${i + 1}`,
      [
        user(`u-${i + 1}`, `问题 ${i + 1}`),
        agent(`a-${i + 1}`, `回答 ${i + 1}`),
        ...Array.from({ length: extra }, (_, k) => agent(`x-${i + 1}-${k}`, `补充 ${k}`)),
      ],
      { startedAt: T0 + (i + 1) * 60 },
    ),
  )

// ---------- codexItems ----------

describe('codexItems', () => {
  it('每种 ThreadItem 一条', () => {
    const items = codexItems([
      turn('t1', [
        user('u1', '你好'),
        { type: 'reasoning', id: 'r1', summary: ['想一想'], content: [] },
        agent('a1', '好的'),
        { type: 'plan', id: 'p1', text: '计划' },
        { type: 'commandExecution', id: 'c1', command: 'ls', aggregatedOutput: 'x', exitCode: 0, status: 'completed' },
        {
          type: 'fileChange',
          id: 'f1',
          changes: [{ path: 'a.ts', kind: { type: 'add' }, diff: 'x' }],
          status: 'completed',
        },
        { type: 'mcpToolCall', id: 'm1', server: 's', tool: 't', status: 'completed', result: {} },
        { type: 'dynamicToolCall', id: 'd1', tool: 'x', status: 'completed' },
        { type: 'webSearch', id: 'w1', query: 'q' },
        { type: 'imageView', id: 'i1', path: '/a.png' },
        { type: 'collabAgentToolCall', id: 'k1', tool: 'spawn_agent', receiverThreadIds: ['t2'], status: 'completed' },
        { type: 'subAgentActivity', id: 's1', kind: 'started', agentThreadId: 'sub-1', agentPath: 'a/b' },
        { type: 'imageGeneration', id: 'g1' },
      ]),
    ])
    expect(Object.fromEntries(items.map(i => [i.id, i.kind]))).toEqual({
      t1: 'user',
      'cx-r1': 'reasoning',
      'cx-a1': 'assistant',
      'cx-p1': 'assistant',
      'cx-c1': 'command',
      'cx-f1': 'file_change',
      'cx-m1': 'tool',
      'cx-d1': 'tool',
      'cx-w1': 'tool',
      'cx-i1': 'tool',
      'cx-k1': 'tool',
      'cx-s1': 'tool',
      'cx-g1': 'tool',
    })
    // 按出现顺序
    expect(items.map(i => i.id).slice(0, 4)).toEqual(['t1', 'cx-r1', 'cx-a1', 'cx-p1'])
    expect(items.every(i => !('status' in i) || i.status === 'completed')).toBe(true)
  })

  it('用户条目：id 是 turn id、engine codex、createdAt 是轮的开始时间；steer 消息带 -u 后缀', () => {
    const items = codexItems([
      turn('turn-x', [user('u1', '第一句'), agent('a1', 'ok'), user('u2', '改一下'), user('u3', '再改')], {
        startedAt: 1_700_000_000,
      }),
    ])
    const us = items.filter(i => i.kind === 'user')
    expect(us.map(u => u.id)).toEqual(['turn-x', 'turn-x-u1', 'turn-x-u2'])
    expect(us[0]).toMatchObject({ text: '第一句', engine: 'codex', createdAt: 1_700_000_000_000 })
    expect(us[1]).toMatchObject({ text: '改一下', engine: 'codex' })
  })

  it('图片不导入，文字后面加占位；skill / mention 不导入', () => {
    const items = codexItems([
      turn('t1', [
        user('u1', '看这张', null, [
          { type: 'image', url: 'x' },
          { type: 'localImage', path: 'C:\\a.png' },
          { type: 'skill', name: 's', path: 'p' },
          { type: 'mention', name: 'm', path: 'p' },
        ]),
      ]),
    ])
    expect(items[0]).toMatchObject({ kind: 'user', text: `看这张\n${NATIVE_TEXT.images(2)}` })
  })

  it('<pixelsky-handoff 前缀拆成提示，用户条目只留原话', () => {
    const handoff = `<${HANDOFF_TAG} conversation="c1">\n以前聊过的东西\n</${HANDOFF_TAG}>`
    const items = codexItems([turn('t1', [user('u1', `${handoff}\n\n继续做`)])])
    expect(kinds(items)).toEqual(['notice', 'user'])
    expect(notices(items)[0]).toMatchObject({ text: NATIVE_TEXT.handoff, detail: handoff, level: 'info' })
    expect(items[1]).toMatchObject({ kind: 'user', text: '继续做' })
  })

  it('VS Code 扩展的 IDE 上下文拆成提示，用户条目只留请求', () => {
    const context = '# Context from my IDE setup:\n\n## Open tabs:\n- a.ts'
    const items = codexItems([turn('t1', [user('u1', `${context}\n\n## My request for Codex:\n修一下这个 bug\n`)])])
    expect(kinds(items)).toEqual(['notice', 'user'])
    expect(notices(items)[0]).toMatchObject({ text: NATIVE_TEXT.ideContext, detail: context })
    expect(items[1]).toMatchObject({ kind: 'user', text: '修一下这个 bug' })
  })

  it('splitIdeContext：开头不是上下文标记的不拆', () => {
    const mid = '看一下 ## My request for Codex: 这行字'
    expect(splitIdeContext(mid)).toEqual({ text: mid, context: null })
    const noRequest = '# Context from my IDE setup:\n只有上下文'
    expect(splitIdeContext(noRequest)).toEqual({ text: noRequest, context: null })
    expect(splitIdeContext('## My request for Codex:\n只有请求')).toEqual({ text: '只有请求', context: null })
  })

  it('压缩条目用这一轮的时间，前面放「模型只看到压缩摘要」（加载更早的 / 补上不放）', () => {
    const turns = [simple(1), turn('turn-c', [{ type: 'contextCompaction', id: 'z1' }], { startedAt: T0 + 5000 })]
    const items = codexItems(turns)
    expect(kinds(items)).toEqual(['user', 'assistant', 'notice', 'compaction'])
    expect(notices(items)[0].text).toBe(NATIVE_TEXT.summaryOnly)
    expect(items[3]).toMatchObject({
      kind: 'compaction',
      id: 'cx-z1',
      status: 'completed',
      startedAt: (T0 + 5000) * 1000,
      durationMs: null,
      preTokens: null,
      postTokens: null,
    })
    expect(kinds(codexItems(turns, { summaryNote: false }))).toEqual(['user', 'assistant', 'compaction'])
    // 压缩在最开头：上面没有东西，不放提示
    expect(kinds(codexItems([turns[1]]))).toEqual(['compaction'])
  })

  it('失败的轮末尾加 warn 提示，文字是错误原文', () => {
    const items = codexItems([
      simple(1, '问', { status: 'failed', error: { message: 'exceeded retry limit', additionalDetails: '502' } }),
    ])
    expect(kinds(items)).toEqual(['user', 'assistant', 'notice'])
    expect(notices(items)[0]).toEqual({ text: 'exceeded retry limit', detail: '502', level: 'warn' })
  })

  it('没结束的轮里还在进行的条目改成已中断；live 时这一轮不转', () => {
    const running = turn(
      't1',
      [
        user('u1', '跑一下'),
        { type: 'commandExecution', id: 'c1', command: 'sleep 9', aggregatedOutput: '', status: 'inProgress' },
        agent('a1', '正在'),
      ],
      { status: 'inProgress' },
    )
    const items = codexItems([running])
    expect(items.filter(i => 'status' in i).map(i => ('status' in i ? i.status : ''))).toEqual([
      'interrupted',
      'completed',
    ])
    expect(items.find(i => i.id === 'cx-c1')).toMatchObject({ kind: 'command', status: 'interrupted' })
    expect(codexItems([simple(1), running], { live: true }).filter(i => i.kind === 'user')).toHaveLength(1)
  })

  it('hookPrompt、enteredReviewMode、sleep 和没见过的类型跳过', () => {
    const items = codexItems([
      turn('t1', [
        user('u1', '你好'),
        { type: 'hookPrompt', id: 'h1', fragments: [] },
        { type: 'enteredReviewMode', id: 'e1', review: 'x' },
        { type: 'exitedReviewMode', id: 'e2', review: 'x' },
        { type: 'sleep', id: 's1' },
        { type: 'somethingNew', id: 'n1' },
        agent('a1', '嗯'),
      ]),
    ])
    expect(items.map(i => i.id)).toEqual(['t1', 'cx-a1'])
  })
})

// ---------- 标题 ----------

describe('经网关线程的名字前缀', () => {
  it('codexThreadName：经网关加前缀（新会话先不改、一样不重发），不经网关去掉以前的前缀', () => {
    expect(codexThreadName('', '新会话', true)).toBeNull()
    expect(codexThreadName('', '修登录', true)).toBe('[像素星空] 修登录')
    expect(codexThreadName('[像素星空] 修登录', '修登录', true)).toBeNull()
    expect(codexThreadName('[像素星空] 修登录', '修登录 2', true)).toBe('[像素星空] 修登录 2')
    expect(codexThreadName('我起的名字', '修登录', true)).toBe('[像素星空] 修登录')
    expect(codexThreadName('[像素星空] 修登录', '修登录', false)).toBe('修登录')
    expect(codexThreadName('我起的名字', '修登录', false)).toBeNull()
    expect(codexThreadName('[像素星空] ', '新会话', false)).toBeNull()
  })
  it('列表里的标题去掉前缀', () => {
    expect(codexTitle({ name: '[像素星空] 修登录' })).toBe('修登录')
  })
})

describe('标题', () => {
  it('name → preview（去前缀）→ 日期', () => {
    expect(codexTitle(thread(tid(1), { name: '  我起的名字 ', preview: '别的' }))).toBe('我起的名字')
    expect(codexTitle(thread(tid(1), { preview: '修一下登录页' }))).toBe('修一下登录页')
    const handoff = `<${HANDOFF_TAG} conversation="c">\n材料\n</${HANDOFF_TAG}>`
    expect(codexTitle(thread(tid(1), { preview: `${handoff}\n\n真正的请求` }))).toBe('真正的请求')
    expect(
      codexTitle(
        thread(tid(1), { preview: '# Context from my IDE setup:\n- a\n\n## My request for Codex:\n加个按钮' }),
      ),
    ).toBe('加个按钮')
    const d = new Date((T0 + 100) * 1000),
      pad = (n: number): string => String(n).padStart(2, '0')
    expect(codexTitle(thread(tid(1), { preview: '   ' }))).toBe(
      `Codex 会话 ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
    )
    // 交接材料被截断（列表的 preview 有长度限制）：整段当没有
    expect(codexTitle(thread(tid(1), { preview: `<${HANDOFF_TAG} conversation="c">\n材料没写完` }))).toMatch(
      /^Codex 会话/,
    )
  })

  it('列表里 firstPrompt 去前缀、单行', async () => {
    const rpc = new FakeRpc().add(
      thread(tid(1), { preview: `<${HANDOFF_TAG} conversation="c">\nx\n</${HANDOFF_TAG}>\n\n第一行\n第二行` }),
    )
    const list = await listCodexThreads(rpc, proj)
    expect(list.sessions[0]).toMatchObject({ title: '第一行', firstPrompt: '第一行 第二行' })
  })
})

// ---------- 列表 ----------

describe('listCodexThreads', () => {
  it('字段：来源、模型、分支、时间、子文件夹', async () => {
    mkdirSync(join(proj, 'pkg', 'web'), { recursive: true })
    const file = join(root, 'rollout.jsonl')
    writeFileSync(file, 'x'.repeat(123))
    const rpc = new FakeRpc()
      .add(thread(tid(1), { path: file, name: '改名了' }))
      .add(thread(tid(2), { cwd: join(proj, 'pkg', 'web'), source: 'vscode', updatedAt: T0 + 50, model: null }))
    const list = await listCodexThreads(rpc, proj, { subfolders: true })
    expect(list.sessions).toHaveLength(2)
    expect(list.sessions[0]).toMatchObject({
      id: tid(1),
      file,
      size: 123,
      mtimeMs: (T0 + 100) * 1000,
      updatedAt: (T0 + 100) * 1000,
      cwd: proj,
      subdir: null,
      title: '改名了',
      firstPrompt: '帮我看看这个',
      lastPrompt: null,
      branch: 'main',
      source: 'terminal',
      model: 'gpt-5.5',
    })
    expect(list.sessions[1]).toMatchObject({ id: tid(2), subdir: 'pkg/web', source: 'other', model: null })
  })

  it('cwd：相同 / 末尾分隔符 / 只差大小写（Windows）/ 子文件夹 / 兄弟目录 / 子文件夹已删', async () => {
    mkdirSync(join(proj, 'sub'), { recursive: true })
    mkdirSync(join(root, 'proj-verify'), { recursive: true })
    const rpc = new FakeRpc()
      .add(thread(tid(1), { cwd: proj }))
      .add(thread(tid(2), { cwd: proj + (IS_WINDOWS ? '\\' : '/') }))
      .add(thread(tid(3), { cwd: join(proj, 'sub') }))
      .add(thread(tid(4), { cwd: join(root, 'proj-verify') }))
      .add(thread(tid(5), { cwd: join(proj, 'gone') }))
      .add(thread(tid(6), { cwd: IS_WINDOWS ? proj.toUpperCase() : proj }))
    const all = await listCodexThreads(rpc, proj, { subfolders: true })
    expect(all.sessions.map(s => [s.id, s.subdir])).toEqual([
      [tid(1), null],
      [tid(2), null],
      [tid(3), 'sub'],
      [tid(6), null],
    ])
    const rootOnly = await listCodexThreads(rpc, proj, { subfolders: false })
    expect(rootOnly.sessions.map(s => s.id)).toEqual([tid(1), tid(2), tid(6)])
  })

  it('子智能体、ephemeral、没有内容的线程不列', async () => {
    const rpc = new FakeRpc()
      .add(thread(tid(1)))
      .add(thread(tid(2), { parentThreadId: tid(1) }))
      .add(thread(tid(3), { ephemeral: true }))
      .add(thread(tid(4), { preview: '' }))
    expect((await listCodexThreads(rpc, proj)).sessions.map(s => s.id)).toEqual([tid(1)])
  })

  it('最多 200 个；第一页不带 useStateDbOnly、后面的页带；modelProviders: [] 一定带；不传 cwd', async () => {
    const rpc = new FakeRpc()
    for (let i = 1; i <= 250; i++) rpc.add(thread(tid(i), { updatedAt: T0 + i }))
    const list = await listCodexThreads(rpc, proj)
    expect(list.sessions).toHaveLength(200)
    // 从新到旧
    expect(list.sessions[0].id).toBe(tid(250))
    const calls = rpc.of('thread/list')
    expect(calls).toHaveLength(2)
    expect(calls[0]).not.toHaveProperty('useStateDbOnly')
    expect(calls[1]).toMatchObject({ useStateDbOnly: true, cursor: '100' })
    for (const c of calls) {
      expect(c).toMatchObject({
        limit: 100,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        modelProviders: [],
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
        archived: false,
      })
      expect(c).not.toHaveProperty('cwd')
    }
  })

  it('不在项目下面的线程看到 2000 个就不再翻', async () => {
    const rpc = new FakeRpc()
    for (let i = 1; i <= 2500; i++) rpc.add(thread(tid(i), { cwd: join(root, 'elsewhere') }))
    expect((await listCodexThreads(rpc, proj)).sessions).toEqual([])
    expect(rpc.of('thread/list')).toHaveLength(20)
  })

  it('Codex 读不到时抛错', async () => {
    const broken: CodexRpc = {
      request: () => Promise.reject(new Error(NATIVE_TEXT.codexUnavailable)),
    }
    await expect(listCodexThreads(broken, proj)).rejects.toThrow(NATIVE_TEXT.codexUnavailable)
  })
})

// ---------- 第二步 ----------

describe('第二步（最后一句）', () => {
  const lastUser = (t: string): CodexTurn => turn('tx', [user('ux', t)])

  it('取最近一个有用户消息的轮；去前缀、单行', async () => {
    const rpc = new FakeRpc().add(thread(tid(1)), [
      simple(1, '第一句'),
      simple(2, '第二句\n换行'),
      turn('turn-3', [agent('a3', '没有用户消息的续跑')]),
    ])
    const list = await listCodexThreads(rpc, proj)
    const out: string[] = []
    for await (const d of list.details()) {
      out.push(d.lastPrompt ?? '')
      expect(d).toMatchObject({
        id: tid(1),
        skipped: false,
        hidden: false,
        superseded: false,
        continuedIn: null,
        read: 0,
      })
    }
    expect(out).toEqual(['第二句 换行'])
    expect(list.sessions[0].lastPrompt).toBe('第二句 换行')
    expect(rpc.of('thread/turns/list')[0]).toMatchObject({
      threadId: tid(1),
      sortDirection: 'desc',
      limit: 3,
      itemsView: 'summary',
    })
  })

  it('按 id + updatedAt 缓存：第二次只核对最后一轮（desc limit 1），不重取；updatedAt 变了重新取', async () => {
    const rpc = new FakeRpc().add(thread(tid(1)), [lastUser('甲')])
    const first = await listCodexThreads(rpc, proj)
    for await (const d of first.details()) expect(d.lastPrompt).toBe('甲')
    expect(rpc.of('thread/turns/list')).toHaveLength(1)
    const second = await listCodexThreads(rpc, proj)
    for await (const d of second.details()) expect(d.lastPrompt).toBe('甲')
    expect(rpc.of('thread/turns/list').map(p => p.limit)).toEqual([3, 1])
    rpc.threads.get(tid(1))!.meta.updatedAt = T0 + 999
    rpc.threads.get(tid(1))!.turns = [lastUser('乙')]
    const third = await listCodexThreads(rpc, proj)
    for await (const d of third.details()) expect(d.lastPrompt).toBe('乙')
    expect(rpc.of('thread/turns/list')).toHaveLength(3)
  })

  it('同一秒（updatedAt 不变）里有了新回复：核对发现最后一轮变了，重新取', async () => {
    const rpc = new FakeRpc().add(thread(tid(1)), [simple(1, '甲')])
    const read = async (): Promise<string | null> => {
      const list = await listCodexThreads(rpc, proj)
      let out: string | null = null
      for await (const d of list.details()) out = d.lastPrompt
      return out
    }
    expect(await read()).toBe('甲')
    rpc.threads.get(tid(1))!.turns.push(simple(2, '乙'))
    expect(await read()).toBe('乙')
    expect(rpc.of('thread/turns/list').map(p => p.limit)).toEqual([3, 1, 3])
    // 没有再变：只多一次 limit 1
    expect(await read()).toBe('乙')
    expect(rpc.of('thread/turns/list').map(p => p.limit)).toEqual([3, 1, 3, 1])
  })

  it('缓存是在 updatedAt 那一秒的余量（之后 2 秒）之外取的：不发核对请求；余量之内仍核对', async () => {
    const rpc = new FakeRpc().add(thread(tid(1)), [lastUser('甲')])
    const read = async (): Promise<void> => {
      for await (const d of (await listCodexThreads(rpc, proj)).details()) expect(d.lastPrompt).toBe('甲')
    }
    // updatedAt 是 T0 + 100 秒；在它之后 3 秒（余量用完）取的缓存
    vi.setSystemTime((T0 + 103) * 1000)
    await read()
    await read()
    expect(rpc.of('thread/turns/list')).toHaveLength(1)
    // 之后 2.5 秒取的：核对
    clearCodexCaches()
    rpc.calls.length = 0
    vi.setSystemTime((T0 + 102) * 1000 + 500)
    await read()
    await read()
    expect(rpc.of('thread/turns/list').map(p => p.limit)).toEqual([3, 1])
  })

  it('核对发现变了但重取失败：退回缓存的旧「最后一句」；重取也扣预算', async () => {
    const rpc = new FakeRpc().add(thread(tid(1)), [simple(1, '甲')])
    const s = (await listCodexThreads(rpc, proj)).sessions[0]
    const budget = { left: 10 }
    await codexThreadDetail(rpc, s, budget)
    expect(budget.left).toBe(9)
    rpc.threads.get(tid(1))!.turns.push(simple(2, '乙'))
    await codexThreadDetail(rpc, s, budget)
    expect(budget.left).toBe(7)
    const request = rpc.request.bind(rpc)
    let n = 0
    rpc.threads.get(tid(1))!.turns.push(simple(3, '丙'))
    rpc.request = async (method, params, signal) => {
      if (++n === 2) throw new Error('boom')
      return request(method, params, signal)
    }
    expect((await codexThreadDetail(rpc, s, budget)).lastPrompt).toBe('乙')
  })

  it('同一秒里最后一轮从 inProgress 变成 completed 也算变了；核对失败沿用缓存', async () => {
    const running = simple(1, '甲', { status: 'inProgress' })
    const rpc = new FakeRpc().add(thread(tid(1)), [running])
    const budget = { left: 10 }
    const s = (await listCodexThreads(rpc, proj)).sessions[0]
    await codexThreadDetail(rpc, s, budget)
    Object.assign(running, { status: 'completed' })
    const before = rpc.of('thread/turns/list').length
    await codexThreadDetail(rpc, s, budget)
    expect(
      rpc
        .of('thread/turns/list')
        .slice(before)
        .map(p => p.limit),
    ).toEqual([1, 3])
    // 核对失败（线程刚被删）：沿用缓存，不抛
    rpc.threads.delete(tid(1))
    expect((await codexThreadDetail(rpc, s, budget)).lastPrompt).toBe('甲')
  })

  it('超过 200 次请求的 skipped；tailBudget 可以改', async () => {
    const rpc = new FakeRpc()
    for (let i = 1; i <= 250; i++) rpc.add(thread(tid(i), { updatedAt: T0 + i }), [lastUser(`话 ${i}`)])
    const list = await listCodexThreads(rpc, proj, { limit: 250 })
    expect(list.sessions).toHaveLength(250)
    let skipped = 0
    for await (const d of list.details()) if (d.skipped) skipped++
    expect(skipped).toBe(50)
    expect(rpc.of('thread/turns/list')).toHaveLength(200)

    clearCodexCaches()
    const small = await listCodexThreads(rpc, proj, { tailBudget: 2 })
    const flags: boolean[] = []
    for await (const d of small.details()) flags.push(d.skipped)
    expect(flags.slice(0, 4)).toEqual([false, false, true, true])
  })

  it('取消时抛出；线程取不到时这一行没有最后一句，不缓存', async () => {
    const rpc = new FakeRpc().add(thread(tid(1)), [lastUser('甲')])
    const list = await listCodexThreads(rpc, proj)
    const ac = new AbortController()
    ac.abort()
    await expect(list.details(undefined, ac.signal).next()).rejects.toThrow()
    rpc.threads.delete(tid(1))
    const detail = await codexThreadDetail(rpc, list.sessions[0], { left: 5 })
    expect(detail).toMatchObject({ lastPrompt: null, skipped: false })
  })
})

// ---------- 正开着 ----------

describe('liveCodexThreads', () => {
  let home: string
  beforeEach(() => {
    home = join(root, 'codex-home')
    mkdirSync(join(home, 'thread-writer-locks'), { recursive: true })
  })
  const lock = (id: string): void => writeFileSync(join(home, 'thread-writer-locks', `${id}.lock`), '')
  const rows = [{ id: tid(1) }, { id: tid(2) }, { id: tid(3) }]

  it('Windows：文件不存在 null / 读得到（残留）null / 读报 EBUSY 才是被占着，按来源定标签', () => {
    lock(tid(1))
    lock(tid(2))
    lock(tid(3))
    const probe = vi.fn((file: string) => (file.includes(tid(1)) ? 'busy' : file.includes(tid(2)) ? 'busy' : 'free'))
    const sources = new Map<string, 'terminal' | 'other'>([
      [tid(1), 'terminal'],
      [tid(2), 'other'],
    ])
    const live = liveCodexThreads(home, [...rows, { id: tid(4) }], [], sources, { windows: true, probe })
    expect([...live]).toEqual([
      [tid(1), 'terminal'],
      [tid(2), 'other'],
      [tid(3), null],
      [tid(4), null],
    ])
    // 不存在的文件不用读
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('Windows 默认的读法：普通可读文件算残留', () => {
    lock(tid(1))
    expect(liveCodexThreads(home, rows, [], new Map(), { windows: true }).get(tid(1))).toBeNull()
  })

  it('读不出是什么错的算 maybe', () => {
    lock(tid(1))
    expect(liveCodexThreads(home, rows, [], new Map(), { windows: true, probe: () => 'unknown' }).get(tid(1))).toBe(
      'maybe',
    )
  })

  it('macOS / Linux：文件存在就是 maybe', () => {
    lock(tid(1))
    const probe = vi.fn(() => 'free' as const)
    const live = liveCodexThreads(home, rows, [], new Map(), { windows: false, probe })
    expect(live.get(tid(1))).toBe('maybe')
    expect(live.get(tid(2))).toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })

  it('像素星空自己的会话在用的线程不算', () => {
    lock(tid(1))
    lock(tid(2))
    const live = liveCodexThreads(home, rows, new Set([tid(1)]), new Map(), { windows: true, probe: () => 'busy' })
    expect(live.get(tid(1))).toBeNull()
    expect(live.get(tid(2))).toBe('other')
  })

  it('目录不存在：全是 null', () => {
    const live = liveCodexThreads(join(root, 'no-such-home'), rows, [], new Map(), {
      windows: true,
      probe: () => 'busy',
    })
    expect([...live.values()]).toEqual([null, null, null])
  })
})

// ---------- 记录还在不在 ----------

describe('codexThreadExists', () => {
  const home = (): string => join(root, 'home')
  // v7 线程 id 的前 48 位是创建时间，rollout 放在那天（本地日期）的目录
  const ms = Date.parse('2026-10-05T08:00:00')
  const hex = ms.toString(16).padStart(12, '0')
  const id = `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000001`
  const rollout = `rollout-2026-10-05T08-00-00-${id}.jsonl`

  it('在 sessions 里', () => {
    mkdirSync(join(home(), 'sessions', '2026', '10', '05'), { recursive: true })
    writeFileSync(join(home(), 'sessions', '2026', '10', '05', rollout), '{}')
    expect(codexThreadExists(home(), id)).toBe(true)
  })

  it('在创建日的目录里：命中就返回，不去扫创建日之后的每一天', () => {
    mkdirSync(join(home(), 'sessions', '2026', '10', '05'), { recursive: true })
    writeFileSync(join(home(), 'sessions', '2026', '10', '05', rollout), '{}')
    // 创建日之后几个月每天一个目录：全扫的话要把它们都读一遍
    for (let d = 6; d <= 30; d++) mkdirSync(join(home(), 'sessions', '2026', '10', String(d).padStart(2, '0')))
    expect(codexThreadExists(home(), id)).toBe(true)
    expect(findCodexRollouts).not.toHaveBeenCalled()
  })

  it('创建日前后一天的目录也算（时区 / 跨零点）', () => {
    mkdirSync(join(home(), 'sessions', '2026', '10', '04'), { recursive: true })
    writeFileSync(join(home(), 'sessions', '2026', '10', '04', rollout), '{}')
    expect(codexThreadExists(home(), id)).toBe(true)
    expect(findCodexRollouts).not.toHaveBeenCalled()
    rmSync(join(home(), 'sessions', '2026', '10', '04'), { recursive: true })
    mkdirSync(join(home(), 'sessions', '2026', '10', '06'), { recursive: true })
    writeFileSync(join(home(), 'sessions', '2026', '10', '06', rollout), '{}')
    expect(codexThreadExists(home(), id)).toBe(true)
    expect(findCodexRollouts).not.toHaveBeenCalled()
  })

  it('创建日的目录里没有、后来接着跑的段在更晚的目录里：回退到全扫，找得到', () => {
    mkdirSync(join(home(), 'sessions', '2026', '10', '05'), { recursive: true })
    mkdirSync(join(home(), 'sessions', '2026', '10', '20'), { recursive: true })
    writeFileSync(join(home(), 'sessions', '2026', '10', '20', rollout.replace('2026-10-05T08', '2026-10-20T09')), '{}')
    expect(codexThreadExists(home(), id)).toBe(true)
    expect(findCodexRollouts).toHaveBeenCalledTimes(1)
  })

  it('在 archived_sessions 里', () => {
    mkdirSync(join(home(), 'sessions'), { recursive: true })
    mkdirSync(join(home(), 'archived_sessions'), { recursive: true })
    writeFileSync(join(home(), 'archived_sessions', rollout), '{}')
    expect(codexThreadExists(home(), id)).toBe(true)
  })

  it('都不在', () => {
    mkdirSync(join(home(), 'sessions', '2026', '10', '05'), { recursive: true })
    writeFileSync(join(home(), 'sessions', '2026', '10', '05', rollout.replace(id, 'other')), '{}')
    expect(codexThreadExists(home(), id)).toBe(false)
    mkdirSync(join(home(), 'archived_sessions'), { recursive: true })
    expect(codexThreadExists(home(), id)).toBe(false)
  })

  it('sessions 目录不存在：拿不准，当它在', () => {
    mkdirSync(home(), { recursive: true })
    expect(codexThreadExists(home(), id)).toBe(true)
  })

  it('线程 id 不是 UUIDv7（算不出 rollout 在哪天的目录）：拿不准，当它在', () => {
    mkdirSync(join(home(), 'sessions', '2026', '10', '05'), { recursive: true })
    expect(codexThreadExists(home(), '11111111-1111-4111-8111-111111111111')).toBe(true)
    expect(codexThreadExists(home(), 'fake-thread')).toBe(true)
  })
})

// ---------- 导入 ----------

describe('readCodexThread', () => {
  it('线程不在了返回 null', async () => {
    expect(await readCodexThread(new FakeRpc(), proj, tid(9))).toBeNull()
  })

  it('字段：元数据、最后一个已结束的 turn、cwd、copyOnly、pixelsky', async () => {
    const rpc = new FakeRpc().add(
      thread(tid(1), { path: 'C:\\x\\rollout.jsonl', historyMode: 'legacy', originator: 'pixelsky', name: '名字' }),
      manyTurns(3),
    )
    const read = (await readCodexThread(rpc, proj, tid(1)))!
    expect(read).toMatchObject({
      file: 'C:\\x\\rollout.jsonl',
      title: '名字',
      turns: 3,
      shown: 3,
      summary: null,
      source: 'terminal',
      model: 'gpt-5.5',
      leafUuid: null,
      at: 'turn-3',
      earliestShownUuid: 'turn-1',
      hasEarlier: false,
      compacted: false,
      cwd: proj,
      copyOnly: true,
      pixelsky: true,
    })
    expect(users(read.items)).toEqual(['turn-1', 'turn-2', 'turn-3'])
    expect(rpc.of('thread/read')[0]).toEqual({ threadId: tid(1), includeTurns: false })
    // 普通线程不是 copyOnly、不是像素星空的
    const plain = new FakeRpc().add(thread(tid(2), { source: 'exec' }), manyTurns(1))
    const r2 = (await readCodexThread(plain, proj, tid(2)))!
    expect(r2.copyOnly).toBeUndefined()
    expect(r2).toMatchObject({ pixelsky: false, source: 'other' })
  })

  it('线程不在了的说法才算「不在了」；别的错误（provider / profile 找不到……）原样抛出', async () => {
    const failing = (message: string): CodexRpc => ({
      request: async () => {
        throw new Error(message)
      },
    })
    for (const gone of [
      'thread not loaded: x',
      'thread not found',
      'invalid thread id: x',
      'no rollout found for thread id x',
    ]) {
      expect(await readCodexThread(failing(gone), proj, tid(1)), gone).toBeNull()
      expect(await newerCodexTurns(failing(gone), proj, tid(1), 'a'), gone).toBeNull()
    }
    for (const other of ['model provider not found: pixelsky', 'profile not found', 'file not found']) {
      await expect(readCodexThread(failing(other), proj, tid(1)), other).rejects.toThrow(other)
      await expect(newerCodexTurns(failing(other), proj, tid(1), 'a'), other).rejects.toThrow(other)
    }
  })

  it('没有用户消息的 turn 并进前一轮，不计数', async () => {
    const turns = [
      simple(1),
      turn('turn-1b', [agent('a1b', '后台任务结束后继续')]),
      simple(2),
      turn('turn-2b', [{ type: 'contextCompaction', id: 'z' }]),
    ]
    const rpc = new FakeRpc().add(thread(tid(1)), turns)
    const read = (await readCodexThread(rpc, proj, tid(1)))!
    expect(read.turns).toBe(2)
    expect(read.shown).toBe(2)
    expect(users(read.items)).toEqual(['turn-1', 'turn-2'])
    // 续跑的内容照常显示，在前一轮后面
    expect(kinds(read.items)).toEqual(['user', 'assistant', 'assistant', 'user', 'assistant', 'notice', 'compaction'])
    expect(read.at).toBe('turn-2b')
    expect(read.compacted).toBe(true)
  })

  it('默认最近 50 轮：turns / shown / hasEarlier / earliestShownUuid', async () => {
    const rpc = new FakeRpc().add(thread(tid(1)), manyTurns(60))
    const read = (await readCodexThread(rpc, proj, tid(1)))!
    expect(read).toMatchObject({ turns: 60, shown: 50, hasEarlier: true, earliestShownUuid: 'turn-11', at: 'turn-60' })
    expect(users(read.items)[0]).toBe('turn-11')
    const few = (await readCodexThread(rpc, proj, tid(1), { turns: 5 }))!
    expect(few).toMatchObject({ turns: 60, shown: 5, earliestShownUuid: 'turn-56' })
  })

  it('条目超过 1000 条从前面整轮去掉', async () => {
    const rpc = new FakeRpc().add(thread(tid(1)), manyTurns(50, 28))
    const read = (await readCodexThread(rpc, proj, tid(1)))!
    expect(read.items.length).toBeLessThanOrEqual(1000)
    expect(read.items[0].kind).toBe('user')
    expect(read.shown).toBe(users(read.items).length)
    expect(read.shown).toBeLessThan(50)
    expect(read.hasEarlier).toBe(true)
    expect(read.turns).toBe(50)
    expect(read.earliestShownUuid).toBe(users(read.items)[0])
  })

  it('live：末尾还没结束的轮不导入，at 退到前一轮；不是 live 时导入但 at 也不指向它', async () => {
    const turns = [
      ...manyTurns(2),
      turn('turn-3', [user('u-3', '在跑'), agent('a-3', '...')], { status: 'inProgress' }),
    ]
    const rpc = new FakeRpc().add(thread(tid(1)), turns)
    const live = (await readCodexThread(rpc, proj, tid(1), { live: true }))!
    expect(users(live.items)).toEqual(['turn-1', 'turn-2'])
    expect(live).toMatchObject({ turns: 2, shown: 2, at: 'turn-2' })
    const cold = (await readCodexThread(rpc, proj, tid(1)))!
    expect(users(cold.items)).toEqual(['turn-1', 'turn-2', 'turn-3'])
    expect(cold.at).toBe('turn-2')
  })

  it('before：按 turn id、按 clientId 找；取它前面的 50 轮，不放摘要提示；找不到报错', async () => {
    const turns = manyTurns(120)
    ;(turns[69].items as Message[])[0] = user('u-70', '问题 70', 'client-70')
    const rpc = new FakeRpc().add(thread(tid(1)), turns)
    const a = (await readCodexThread(rpc, proj, tid(1), { before: 'turn-61' }))!
    expect(users(a.items)).toEqual(Array.from({ length: 50 }, (_, i) => `turn-${11 + i}`))
    expect(a).toMatchObject({ turns: 120, shown: 50, hasEarlier: true, earliestShownUuid: 'turn-11' })
    const b = (await readCodexThread(rpc, proj, tid(1), { before: 'client-70' }))!
    expect(users(b.items)[49]).toBe('turn-69')
    const c = (await readCodexThread(rpc, proj, tid(1), { before: 'turn-11' }))!
    expect(c).toMatchObject({ shown: 10, hasEarlier: false, earliestShownUuid: 'turn-1' })
    await expect(readCodexThread(rpc, proj, tid(1), { before: 'nope' })).rejects.toThrow('找不到要接着往前加载的位置')
  })

  it('before 读到的段里有压缩：不放「模型只看到压缩摘要」，默认读法放', async () => {
    const turns = [simple(1), turn('turn-c', [{ type: 'contextCompaction', id: 'z' }]), simple(2), simple(3)]
    const rpc = new FakeRpc().add(thread(tid(1)), turns)
    const earlier = (await readCodexThread(rpc, proj, tid(1), { before: 'turn-3' }))!
    expect(notices(earlier.items)).toEqual([])
    expect(earlier.compacted).toBe(true)
    const normal = (await readCodexThread(rpc, proj, tid(1)))!
    expect(notices(normal.items).map(n => n.text)).toEqual([NATIVE_TEXT.summaryOnly])
  })

  it('full 读每页不超过 5 轮；默认段从末尾 desc 往前读，读够就停', async () => {
    const rpc = new FakeRpc().add(thread(tid(1)), manyTurns(300))
    const read = (await readCodexThread(rpc, proj, tid(1), { turns: 10 }))!
    expect(read.shown).toBe(10)
    const full = rpc.of('thread/turns/list').filter(c => c.itemsView === 'full')
    expect(full).toHaveLength(2)
    for (const c of full) expect(c).toMatchObject({ sortDirection: 'desc', limit: 5 })
    // 索引：summary、asc、每页 200 轮，翻两页
    const index = rpc.of('thread/turns/list').filter(c => c.itemsView === 'summary')
    expect(index.map(c => c.limit)).toEqual([200, 200])
    expect(index.every(c => c.sortDirection === 'asc')).toBe(true)
  })

  it('加载更早的：跳过比 before 新的轮，读到要的 50 轮为止', async () => {
    const rpc = new FakeRpc().add(thread(tid(1)), manyTurns(100))
    const read = (await readCodexThread(rpc, proj, tid(1), { before: 'turn-61' }))!
    expect(users(read.items)[0]).toBe('turn-11')
    const full = rpc.of('thread/turns/list').filter(c => c.itemsView === 'full')
    // 末尾 40 轮跳过（8 页）+ 50 轮要读（10 页）
    expect(full.length).toBe(18)
    expect(full.every(c => (c.limit as number) <= 5)).toBe(true)
  })

  it('轮次索引：prompt / clientIds / startedAt / 状态，按 id + updatedAt 缓存', async () => {
    const turns = [
      turn('t1', [user('u1', '甲', 'c1')], { startedAt: T0 + 1 }),
      turn('t2', [agent('a2', '续')], { status: 'inProgress', startedAt: null }),
    ]
    const rpc = new FakeRpc().add(thread(tid(1)), turns)
    const refs = await codexTurnIndex(rpc, tid(1), undefined, T0 + 100)
    expect(refs).toEqual([
      { id: 't1', status: 'completed', startedAt: T0 + 1, prompt: true, clientIds: ['c1'] },
      { id: 't2', status: 'inProgress', startedAt: null, prompt: false, clientIds: [] },
    ])
    // 命中缓存：只多一次核对最后一轮（desc limit 1 summary），不整份重读
    const again = await codexTurnIndex(rpc, tid(1), undefined, T0 + 100)
    expect(again).toBe(refs)
    expect(rpc.of('thread/turns/list')).toHaveLength(2)
    expect(rpc.of('thread/turns/list')[1]).toMatchObject({ sortDirection: 'desc', limit: 1, itemsView: 'summary' })
    await codexTurnIndex(rpc, tid(1), undefined, T0 + 101)
    expect(rpc.of('thread/turns/list')).toHaveLength(3)
  })

  it('同一秒（updatedAt 不变）里新增轮次：首次导入 / 再读都能读到；没变化时不整份重读；核对失败照常抛', async () => {
    const rpc = new FakeRpc().add(thread(tid(1)), [simple(1), simple(2)])
    expect((await readCodexThread(rpc, proj, tid(1)))!.turns).toBe(2)
    const n = rpc.of('thread/turns/list').length
    expect((await readCodexThread(rpc, proj, tid(1)))!.turns).toBe(2)
    // 没变化：多一次 limit 1 核对，索引不重读
    const extra = rpc.of('thread/turns/list').slice(n)
    expect(extra.filter(p => p.itemsView === 'summary' && p.limit !== 1)).toEqual([])
    expect(extra.filter(p => p.limit === 1)).toHaveLength(1)
    rpc.threads.get(tid(1))!.turns.push(simple(3))
    const fresh = (await readCodexThread(rpc, proj, tid(1)))!
    expect(fresh.turns).toBe(3)
    expect(users(fresh.items)).toEqual(['turn-1', 'turn-2', 'turn-3'])
    // 索引缓存命中后线程没了：核对失败按「线程不在了」处理，两条路径都是 null
    rpc.threads.delete(tid(1))
    expect(await readCodexThread(rpc, proj, tid(1))).toBeNull()
    expect(await newerCodexTurns(rpc, proj, tid(1), 'turn-1')).toBeNull()
  })

  it('索引缓存在 updatedAt 那一秒的余量之外取的：命中不发核对请求', async () => {
    const rpc = new FakeRpc().add(thread(tid(1)), [simple(1)])
    vi.setSystemTime((T0 + 103) * 1000)
    await codexTurnIndex(rpc, tid(1), undefined, T0 + 100)
    await codexTurnIndex(rpc, tid(1), undefined, T0 + 100)
    expect(rpc.of('thread/turns/list')).toHaveLength(1)
  })

  it('取消：翻页之间检查 signal', async () => {
    const rpc = new FakeRpc().add(thread(tid(1)), manyTurns(60))
    const ac = new AbortController()
    ac.abort()
    await expect(readCodexThread(rpc, proj, tid(1), { signal: ac.signal })).rejects.toThrow()
  })
})

// ---------- 补上 ----------

describe('newerCodexTurns', () => {
  it('after 是 turn id / clientId；之后的轮就是新的，base 是 after 这一轮', async () => {
    const turns = manyTurns(5)
    ;(turns[1].items as Message[])[0] = user('u-2', '问题 2', 'client-2')
    const rpc = new FakeRpc().add(thread(tid(1)), turns)
    const byTurn = (await newerCodexTurns(rpc, proj, tid(1), 'turn-3'))!
    expect(users(byTurn.items)).toEqual(['turn-4', 'turn-5'])
    expect(byTurn).toMatchObject({ turns: 2, shown: 2, gap: 0, base: 'turn-3', at: 'turn-5', leafUuid: null })
    const byClient = (await newerCodexTurns(rpc, proj, tid(1), 'client-2'))!
    expect(users(byClient.items)).toEqual(['turn-3', 'turn-4', 'turn-5'])
    expect(byClient.base).toBe('turn-2')
    const none = (await newerCodexTurns(rpc, proj, tid(1), 'turn-5'))!
    expect(none).toMatchObject({ items: [], turns: 0, shown: 0, base: 'turn-5' })
  })

  it('after 不在线程里、线程没了：null', async () => {
    const rpc = new FakeRpc().add(thread(tid(1)), manyTurns(2))
    expect(await newerCodexTurns(rpc, proj, tid(1), 'zzz')).toBeNull()
    expect(await newerCodexTurns(rpc, proj, tid(2), 'turn-1')).toBeNull()
  })

  it('超过 50 轮只给最近 50 轮，最前面放「中间还有 M 轮没有显示」', async () => {
    const rpc = new FakeRpc().add(thread(tid(1)), manyTurns(65))
    const newer = (await newerCodexTurns(rpc, proj, tid(1), 'turn-1'))!
    expect(newer).toMatchObject({ turns: 64, shown: 50, gap: 14, base: 'turn-1', at: 'turn-65' })
    expect(newer.items[0]).toMatchObject({ kind: 'notice', text: NATIVE_TEXT.gap(14) })
    expect(users(newer.items)[0]).toBe('turn-16')
  })

  it('after 那一轮后面没有用户消息的续跑轮算它自己的；之后只有续跑轮时没有新轮次', async () => {
    const turns = [simple(1), turn('turn-1b', [agent('a1b', '续跑')])]
    const rpc = new FakeRpc().add(thread(tid(1)), turns)
    const none = (await newerCodexTurns(rpc, proj, tid(1), 'turn-1'))!
    expect(none).toMatchObject({ items: [], turns: 0, base: 'turn-1b' })
    rpc.threads.get(tid(1))!.turns.push(simple(2))
    rpc.threads.get(tid(1))!.meta.updatedAt = T0 + 200
    const next = (await newerCodexTurns(rpc, proj, tid(1), 'turn-1'))!
    expect(users(next.items)).toEqual(['turn-2'])
    expect(next.base).toBe('turn-1b')
  })

  it('live：终端里正在跑的那一轮不导入，turns / at 都不算它；它结束后下次再补，回复是完整的', async () => {
    const rpc = new FakeRpc().add(thread(tid(1)), manyTurns(2))
    const running = turn('turn-3', [user('u-3', '在跑'), agent('a-3', '半截')], { status: 'inProgress' })
    rpc.threads.get(tid(1))!.turns.push(running)
    rpc.threads.get(tid(1))!.meta.updatedAt = T0 + 300
    const live = (await newerCodexTurns(rpc, proj, tid(1), 'turn-2', { live: true }))!
    expect(live).toMatchObject({ items: [], turns: 0, shown: 0, at: 'turn-2', base: 'turn-2' })
    // 对话里认识的最后一条就是这个没结束的轮（不可能，但不能当成「找不到」而丢掉整个判断）
    expect(await newerCodexTurns(rpc, proj, tid(1), 'turn-3', { live: true })).toMatchObject({ turns: 0, items: [] })

    // 它结束了（回复写完）：下一次补上整轮，回复是完整的、状态不是已中断
    Object.assign(running, { status: 'completed' })
    ;(running.items as Message[])[1] = agent('a-3', '写完了')
    rpc.threads.get(tid(1))!.meta.updatedAt = T0 + 400
    const done = (await newerCodexTurns(rpc, proj, tid(1), 'turn-2', { live: false }))!
    expect(users(done.items)).toEqual(['turn-3'])
    expect(done).toMatchObject({ turns: 1, shown: 1, at: 'turn-3' })
    expect(done.items.find(i => i.kind === 'assistant')).toMatchObject({ text: '写完了', status: 'completed' })
  })

  it('同一秒（updatedAt 不变）里：补上 A 之后又新增 B，第二次补上拿得到 B', async () => {
    const rpc = new FakeRpc().add(thread(tid(1)), manyTurns(1))
    rpc.threads.get(tid(1))!.turns.push(simple(2))
    const first = (await newerCodexTurns(rpc, proj, tid(1), 'turn-1'))!
    expect(users(first.items)).toEqual(['turn-2'])
    rpc.threads.get(tid(1))!.turns.push(simple(3))
    const second = (await newerCodexTurns(rpc, proj, tid(1), 'turn-2'))!
    expect(users(second.items)).toEqual(['turn-3'])
    expect(second).toMatchObject({ turns: 1, at: 'turn-3', base: 'turn-2' })
    // 没变化：不整份重读索引，只多一次 limit 1 核对
    const n = rpc.of('thread/turns/list').length
    expect((await newerCodexTurns(rpc, proj, tid(1), 'turn-3'))!.turns).toBe(0)
    const extra = rpc.of('thread/turns/list').slice(n)
    expect(extra).toHaveLength(1)
    expect(extra[0]).toMatchObject({ sortDirection: 'desc', limit: 1, itemsView: 'summary' })
  })

  it('同一秒（updatedAt 不变）里 live 的最后一轮从 inProgress 变成 completed：第二次补上补到它', async () => {
    const rpc = new FakeRpc().add(thread(tid(1)), manyTurns(1))
    const running = turn('turn-2', [user('u-2', '在跑'), agent('a-2', '半截')], { status: 'inProgress' })
    rpc.threads.get(tid(1))!.turns.push(running)
    expect((await newerCodexTurns(rpc, proj, tid(1), 'turn-1', { live: true }))!.turns).toBe(0)
    Object.assign(running, { status: 'completed' })
    const done = (await newerCodexTurns(rpc, proj, tid(1), 'turn-1', { live: true }))!
    expect(users(done.items)).toEqual(['turn-2'])
    expect(done).toMatchObject({ turns: 1, at: 'turn-2' })
  })

  it('线程更新后（updatedAt 变了）重建索引；live 时末尾没结束的轮不算', async () => {
    const rpc = new FakeRpc().add(thread(tid(1)), manyTurns(2))
    expect((await newerCodexTurns(rpc, proj, tid(1), 'turn-2'))!.turns).toBe(0)
    rpc.threads
      .get(tid(1))!
      .turns.push(turn('turn-3', [user('u-3', '在跑'), agent('a-3', '..')], { status: 'inProgress' }))
    rpc.threads.get(tid(1))!.meta.updatedAt = T0 + 300
    expect((await newerCodexTurns(rpc, proj, tid(1), 'turn-2', { live: true }))!.turns).toBe(0)
    expect((await newerCodexTurns(rpc, proj, tid(1), 'turn-2'))!.turns).toBe(1)
  })
})

// ---------- CodexReader ----------

describe('CodexReader', () => {
  interface Pending {
    method: string
    resolve: (value: Message) => void
    reject: (err: Error) => void
  }
  class FakeProc implements ReaderProcess {
    alive = true
    closed = false
    readonly pending: Pending[] = []
    constructor(readonly onExit: () => void) {}
    request(method: string): Promise<Message> {
      if (!this.alive) return Promise.reject(new Error('Codex process exited'))
      return new Promise((resolve, reject) => {
        const entry: Pending = {
          method,
          resolve: v => {
            this.pending.splice(this.pending.indexOf(entry), 1)
            resolve(v)
          },
          reject: e => {
            this.pending.splice(this.pending.indexOf(entry), 1)
            reject(e)
          },
        }
        this.pending.push(entry)
      })
    }
    closeTimeout: number | undefined
    async close(timeoutMs?: number): Promise<void> {
      this.alive = false
      this.closed = true
      this.closeTimeout = timeoutMs
    }
    killed = false
    kill(): void {
      this.killed = true
      this.die()
    }
    die(): void {
      this.alive = false
      for (const p of [...this.pending]) p.reject(new Error('Codex process exited'))
      this.onExit()
    }
  }
  const launch: ReaderLaunch = { launcher: { command: 'codex', args: [] }, args: [], env: {}, cwd: root }
  function make(opts: { idleMs?: number; gate?: Promise<void> } = {}): { reader: CodexReader; procs: FakeProc[] } {
    const procs: FakeProc[] = []
    const reader = new CodexReader(async () => launch, {
      idleMs: opts.idleMs,
      open: async (_l, onExit) => {
        // 测试想让「正在启动」停一会儿时给 gate
        await opts.gate
        const p = new FakeProc(onExit)
        procs.push(p)
        return p
      },
    })
    return { reader, procs }
  }
  const tick = (): Promise<void> => new Promise(r => setImmediate(r))
  afterEach(() => vi.useRealTimers())

  it('按需起进程；并发请求排队，一次只发一个，顺序不变', async () => {
    const { reader, procs } = make()
    const a = reader.request('thread/list', {})
    const b = reader.request('thread/read', {})
    const c = reader.request('thread/turns/list', {})
    await tick()
    expect(procs).toHaveLength(1)
    expect(procs[0].pending.map(p => p.method)).toEqual(['thread/list'])
    procs[0].pending[0].resolve({ n: 1 })
    expect(await a).toEqual({ n: 1 })
    await tick()
    expect(procs[0].pending.map(p => p.method)).toEqual(['thread/read'])
    procs[0].pending[0].resolve({ n: 2 })
    await tick()
    expect(procs[0].pending.map(p => p.method)).toEqual(['thread/turns/list'])
    procs[0].pending[0].resolve({ n: 3 })
    expect(await b).toEqual({ n: 2 })
    expect(await c).toEqual({ n: 3 })
    expect(procs).toHaveLength(1)
  })

  it('一个请求失败不影响队列里后面的', async () => {
    const { reader, procs } = make()
    const a = reader.request('thread/read', {})
    const b = reader.request('thread/list', {})
    const failed = expect(a).rejects.toThrow('thread not loaded')
    await tick()
    procs[0].pending[0].reject(new Error('thread not loaded: x'))
    await failed
    await tick()
    procs[0].pending[0].resolve({ ok: true })
    expect(await b).toEqual({ ok: true })
  })

  it('空闲 60 秒关进程，之后再请求重新起', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { reader, procs } = make()
    const first = reader.request('thread/list', {})
    await vi.advanceTimersByTimeAsync(0)
    await tick()
    procs[0].pending[0].resolve({})
    await first
    expect(reader.running).toBe(true)
    await vi.advanceTimersByTimeAsync(59_000)
    expect(procs[0].closed).toBe(false)
    // 中途又有请求：重新计时
    const second = reader.request('thread/list', {})
    await tick()
    procs[0].pending[0].resolve({})
    await second
    await vi.advanceTimersByTimeAsync(59_000)
    expect(procs[0].closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(procs[0].closed).toBe(true)
    expect(reader.running).toBe(false)

    const third = reader.request('thread/list', {})
    await tick()
    expect(procs).toHaveLength(2)
    procs[1].pending[0].resolve({})
    await third
  })

  it('进程死了，下一次请求重新起；请求发出去时才发现进程死了，重起重发一次', async () => {
    const { reader, procs } = make()
    const a = reader.request('thread/list', {})
    await tick()
    procs[0].pending[0].resolve({})
    await a
    procs[0].die()
    const b = reader.request('thread/list', {})
    await tick()
    expect(procs).toHaveLength(2)
    procs[1].pending[0].resolve({ again: true })
    expect(await b).toEqual({ again: true })

    // 进程在请求途中退出：和真进程一样，先同步拒绝挂着的请求、再同步通知 onExit（reader 里的 proc 先被清掉），
    // 同一个请求在新进程上重发一次
    const c = reader.request('thread/read', {})
    await tick()
    procs[1].die()
    await tick()
    expect(procs).toHaveLength(3)
    procs[2].pending[0].resolve({ retried: true })
    expect(await c).toEqual({ retried: true })

    // 只重发一次：新进程又在请求途中死了，错误往外抛
    const d = reader.request('thread/read', {})
    const failed = expect(d).rejects.toThrow('Codex process exited')
    await tick()
    procs[2].die()
    await tick()
    expect(procs).toHaveLength(4)
    procs[3].die()
    await failed
  })

  it('请求出错但进程还活着：不重发', async () => {
    const { reader, procs } = make()
    const a = reader.request('thread/read', {})
    const failed = expect(a).rejects.toThrow('thread not loaded')
    await tick()
    procs[0].pending[0].reject(new Error('thread not loaded: x'))
    await failed
    expect(procs).toHaveLength(1)
  })

  it('close() 引起的失败不重发（不会把刚关掉的进程又拉起来）', async () => {
    const { reader, procs } = make()
    const a = reader.request('thread/read', {})
    const failed = expect(a).rejects.toThrow('Codex process exited')
    await tick()
    const closing = reader.close()
    procs[0].die()
    await closing
    await failed
    await tick()
    expect(procs).toHaveLength(1)
  })

  it('close() 时进程正在启动：起来后马上关掉，请求被拒绝；之后的新请求再按需起', async () => {
    let open!: () => void
    const gate = new Promise<void>(resolve => (open = resolve))
    const { reader, procs } = make({ gate })
    const a = reader.request('thread/list', {})
    const rejected = expect(a).rejects.toThrow(NATIVE_TEXT.codexReaderClosed)
    await tick()
    await reader.close()
    open()
    await rejected
    await tick()
    // 这个进程不能留着：update / install 前关的，留着会占住 codex.exe
    expect(procs).toHaveLength(1)
    expect(procs[0].killed).toBe(true)
    expect(reader.running).toBe(false)
    const b = reader.request('thread/list', {})
    await tick()
    expect(procs).toHaveLength(2)
    procs[1].pending[0].resolve({ ok: 1 })
    expect(await b).toEqual({ ok: 1 })
    expect(procs[1].killed).toBe(false)
  })

  it('close() 后马上又有请求时旧的启动收尾不会弄乱新的：旧进程被关，新请求共用一个新进程', async () => {
    let open!: () => void
    const gate = new Promise<void>(resolve => (open = resolve))
    const { reader, procs } = make({ gate })
    const a = reader.request('thread/list', {})
    const rejected = expect(a).rejects.toThrow(NATIVE_TEXT.codexReaderClosed)
    await tick()
    await reader.close()
    const b = reader.request('thread/read', {})
    await tick()
    open()
    await rejected
    await tick()
    const c = reader.request('thread/turns/list', {})
    await tick()
    // 旧一代的进程已被关，b / c 共用新一代的那一个
    expect(procs).toHaveLength(2)
    expect(procs[0].killed).toBe(true)
    expect(procs[1].killed).toBe(false)
    procs[1].pending[0].resolve({ b: 1 })
    expect(await b).toEqual({ b: 1 })
    await tick()
    procs[1].pending[0].resolve({ c: 1 })
    expect(await c).toEqual({ c: 1 })
    expect(procs).toHaveLength(2)
  })

  it('close() 时队列里还有请求：立即拒绝，不会为它们再起进程；close 之后发的请求不受影响', async () => {
    const { reader, procs } = make()
    const a = reader.request('thread/list', {})
    const b = reader.request('thread/read', {})
    const c = reader.request('thread/turns/list', {})
    await tick()
    expect(procs[0].pending.map(p => p.method)).toEqual(['thread/list'])
    const rejectedB = expect(b).rejects.toThrow(NATIVE_TEXT.codexReaderClosed)
    const rejectedC = expect(c).rejects.toThrow(NATIVE_TEXT.codexReaderClosed)
    await reader.close()
    // 在途的 a 照常得到结果（进程已经 close，回包是不是到得了不归 reader 管）
    procs[0].pending[0].resolve({ a: 1 })
    expect(await a).toEqual({ a: 1 })
    await rejectedB
    await rejectedC
    await tick()
    expect(procs).toHaveLength(1)
    // close 之后的新请求排在旧的后面，但属于新的一代，正常起进程
    const d = reader.request('thread/list', {})
    await tick()
    expect(procs).toHaveLength(2)
    procs[1].pending[0].resolve({ d: 1 })
    expect(await d).toEqual({ d: 1 })
  })

  it('close({ quick: true }) 给进程 1 秒；默认不限定（用进程自己的默认）', async () => {
    const { reader, procs } = make()
    const a = reader.request('thread/list', {})
    await tick()
    procs[0].pending[0].resolve({})
    await a
    await reader.close({ quick: true })
    expect(procs[0].closeTimeout).toBe(QUICK_CLOSE_MS)
    const b = reader.request('thread/list', {})
    await tick()
    procs[1].pending[0].resolve({})
    await b
    await reader.close()
    expect(procs[1].closeTimeout).toBeUndefined()
  })

  it('signal 触发时不等回包直接拒绝，晚到的回包丢掉，队列继续', async () => {
    const { reader, procs } = make()
    const ac = new AbortController()
    const slow = reader.request('thread/list', {}, ac.signal)
    const next = reader.request('thread/read', {})
    await tick()
    ac.abort()
    await expect(slow).rejects.toThrow()
    // 进程没杀
    expect(procs[0].closed).toBe(false)
    procs[0].pending[0].resolve({ late: true })
    await tick()
    procs[0].pending[0].resolve({ ok: 1 })
    expect(await next).toEqual({ ok: 1 })
    // 已经取消的请求不再发
    const gone = new AbortController()
    gone.abort()
    await expect(reader.request('thread/list', {}, gone.signal)).rejects.toThrow()
  })

  it('Codex 没装好：抛 codexUnavailable；起不来：抛带原因的错误', async () => {
    const none = new CodexReader(async () => null)
    await expect(none.request('thread/list', {})).rejects.toThrow(NATIVE_TEXT.codexUnavailable)
    const bad = new CodexReader(async () => launch, {
      open: async () => {
        throw new Error(`${NATIVE_TEXT.codexUnavailable}：error: unexpected argument`)
      },
    })
    await expect(bad.request('thread/list', {})).rejects.toThrow('unexpected argument')
  })

  it('启动配置变了（改了 CODEX_HOME / 追加参数）：下次请求关掉旧进程、按新配置起；没变就接着用', async () => {
    let current: ReaderLaunch = { ...launch, env: { CODEX_HOME: 'A' } }
    const procs: FakeProc[] = []
    const used: ReaderLaunch[] = []
    const reader = new CodexReader(async () => current, {
      open: async (l, onExit) => {
        used.push(l)
        const p = new FakeProc(onExit)
        procs.push(p)
        return p
      },
    })
    const ask = async (index: number): Promise<void> => {
      const r = reader.request('thread/list', {})
      await tick()
      procs[index].pending[0].resolve({})
      await r
    }
    await ask(0)
    // 配置没变（新对象、同样内容、环境变量顺序不同也一样）：不换进程
    current = { ...launch, env: { CODEX_HOME: 'A', EXTRA: undefined } }
    await ask(0)
    expect(procs).toHaveLength(1)

    current = { ...launch, env: { CODEX_HOME: 'B' } }
    await ask(1)
    expect(procs[0].killed).toBe(true)
    expect(used[1].env.CODEX_HOME).toBe('B')

    current = { ...current, args: ['-c', 'x=1'] }
    await ask(2)
    expect(procs[1].killed).toBe(true)
    expect(procs[2].killed).toBe(false)
    expect(reader.running).toBe(true)
  })

  it('开着进程时 Codex 变得不可用：关掉旧进程，抛 codexUnavailable', async () => {
    let current: ReaderLaunch | null = launch
    const procs: FakeProc[] = []
    const reader = new CodexReader(async () => current, {
      open: async (_l, onExit) => {
        const p = new FakeProc(onExit)
        procs.push(p)
        return p
      },
    })
    const a = reader.request('thread/list', {})
    await tick()
    procs[0].pending[0].resolve({})
    await a
    current = null
    await expect(reader.request('thread/list', {})).rejects.toThrow(NATIVE_TEXT.codexUnavailable)
    expect(procs[0].killed).toBe(true)
    expect(reader.running).toBe(false)
  })

  it('readerLaunchKey：环境变量顺序不影响，CODEX_HOME / 参数 / 程序不同就不同', () => {
    const base: ReaderLaunch = { ...launch, env: { A: '1', CODEX_HOME: 'x' } }
    expect(readerLaunchKey(base)).toBe(readerLaunchKey({ ...base, env: { CODEX_HOME: 'x', A: '1' } }))
    expect(readerLaunchKey(base)).not.toBe(readerLaunchKey({ ...base, env: { A: '1', CODEX_HOME: 'y' } }))
    expect(readerLaunchKey(base)).not.toBe(readerLaunchKey({ ...base, args: ['--x'] }))
    expect(readerLaunchKey(base)).not.toBe(readerLaunchKey({ ...base, launcher: { command: 'codex2', args: [] } }))
  })

  it('close() 之后再请求会重起', async () => {
    const { reader, procs } = make()
    const a = reader.request('thread/list', {})
    await tick()
    procs[0].pending[0].resolve({})
    await a
    await reader.close()
    expect(procs[0].closed).toBe(true)
    const b = reader.request('thread/list', {})
    await tick()
    expect(procs).toHaveLength(2)
    procs[1].pending[0].resolve({})
    await b
  })
})

// ---------- 真的起一个假 Codex 进程 ----------

describe('CodexReader + 假 Codex', () => {
  const fake = fileURLToPath(new URL('./fakes/fake-codex.mjs', import.meta.url))
  let reader: CodexReader
  let log: string
  afterEach(async () => {
    await reader?.close()
  })

  function setup(meta: Record<string, Message>, threads: Record<string, unknown[]>): void {
    const state = join(root, 'state')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'meta.json'), JSON.stringify(meta))
    writeFileSync(join(state, 'threads.json'), JSON.stringify(threads))
    log = join(root, 'rpc.jsonl')
    reader = new CodexReader(async () => ({
      launcher: { command: process.execPath, args: [fake] },
      args: [],
      env: { ...process.env, FAKE_CODEX_STATE_DIR: state, FAKE_CODEX_LOG: log },
      cwd: root,
    }))
  }
  const stored = (n: number, prompt: string): Message => ({
    id: `turn-${n}`,
    clientId: null,
    content: [text(prompt)],
    startedAt: T0 + n,
    items: [user(`u-${n}`, prompt), agent(`a-${n}`, `回答 ${n}`)],
  })
  const metaFor = (over: Message = {}): Message => ({
    cwd: proj,
    source: 'cli',
    originator: 'codex_cli_rs',
    preview: '问题 1',
    updatedAt: T0 + 100,
    model: 'gpt-5.5',
    modelProvider: 'openai',
    gitBranch: 'main',
    historyMode: 'paginated',
    ...over,
  })

  it('列表 / 读取走真实的 JSON-RPC：只看得到 modelProviders: [] 传进去之后的线程', async () => {
    setup(
      {
        [tid(1)]: metaFor({ name: '终端里的' }),
        [tid(2)]: metaFor({
          source: 'vscode',
          originator: 'pixelsky',
          updatedAt: T0 + 200,
          modelProvider: 'pixelsky',
          preview: '像素星空的',
        }),
        [tid(3)]: metaFor({ source: { subAgent: 'review' } }),
        [tid(4)]: metaFor({ archived: true }),
        [tid(5)]: metaFor({ cwd: join(root, 'elsewhere') }),
      },
      { [tid(1)]: [stored(1, '问题 1'), stored(2, '问题 2')], [tid(2)]: [stored(1, '像素星空的')] },
    )
    // 不传 modelProviders 时假 Codex 只给 'fake' 来源的：一个都没有
    expect((await reader.request('thread/list', {})).data).toEqual([])
    const list = await listCodexThreads(reader, proj, { subfolders: true })
    expect(list.sessions.map(s => [s.id, s.title, s.source])).toEqual([
      [tid(2), '像素星空的', 'other'],
      [tid(1), '终端里的', 'terminal'],
    ])
    for await (const d of list.details()) expect(d.skipped).toBe(false)
    expect(list.sessions.map(s => s.lastPrompt)).toEqual(['像素星空的', '问题 2'])

    const read = (await readCodexThread(reader, proj, tid(1)))!
    expect(users(read.items)).toEqual(['turn-1', 'turn-2'])
    expect(read).toMatchObject({ turns: 2, at: 'turn-2', cwd: proj, pixelsky: false })
    expect((await readCodexThread(reader, proj, tid(2)))!.pixelsky).toBe(true)
    expect(await readCodexThread(reader, proj, tid(9))).toBeNull()

    // 我们没传 cwd 过滤，也没有 thread/resume
    const sent = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as { method?: string; params?: Message })
    expect(
      sent.filter(m => m.method === 'thread/list' && m.params?.modelProviders).every(m => !('cwd' in m.params!)),
    ).toBe(true)
    expect(sent.some(m => m.method === 'thread/resume' || m.method === 'thread/start')).toBe(false)
    // 整个过程只起了一个进程
    expect(existsSync(log)).toBe(true)
    expect(sent.filter(m => m.method === 'initialize')).toHaveLength(1)
  })

  it('summary 视图（轮次索引用的）里 userMessage 带 clientId：像素星空发的有，终端里发的是 null（Codex 0.163.0 实测的形状）', async () => {
    const sent = (n: number, clientId: string): Message => ({
      id: `turn-${n}`,
      clientId,
      content: [text(`问题 ${n}`)],
      startedAt: T0 + n,
      items: [user(`u-${n}`, `问题 ${n}`, clientId), agent(`a-${n}`, `回答 ${n}`)],
    })
    setup(
      { [tid(1)]: metaFor({ source: 'vscode', originator: 'pixelsky' }) },
      { [tid(1)]: [stored(1, '终端里的'), sent(2, 'client-2'), sent(3, 'client-3-retry-7a1f')] },
    )
    const raw = await reader.request('thread/turns/list', {
      threadId: tid(1),
      sortDirection: 'asc',
      itemsView: 'summary',
      limit: 10,
    })
    const summaryUsers = array(raw.data).map(t => array(t.items).find(i => i.type === 'userMessage')!)
    expect(summaryUsers.map(u => Object.keys(u))).toEqual(
      Array.from({ length: 3 }, () => ['type', 'id', 'clientId', 'content']),
    )
    expect(summaryUsers.map(u => u.clientId)).toEqual([null, 'client-2', 'client-3-retry-7a1f'])
    // 索引、按 clientId 补上 / 加载更早的都靠它
    const index = await codexTurnIndex(reader, tid(1))
    expect(index.map(r => r.clientIds)).toEqual([[], ['client-2'], ['client-3-retry-7a1f']])
    expect(users((await newerCodexTurns(reader, proj, tid(1), 'client-2'))!.items)).toEqual(['turn-3'])
    expect((await readCodexThread(reader, proj, tid(1), { before: 'client-3-retry-7a1f' }))!.turns).toBe(3)
  })

  it('起不来的命令抛出带原因的错误', async () => {
    reader = new CodexReader(async () => ({
      launcher: { command: process.execPath, args: [fake] },
      args: ['--fake-bad-arg'],
      env: { ...process.env },
      cwd: root,
    }))
    await expect(listCodexThreads(reader, proj)).rejects.toThrow(/unexpected argument/)
  })
})
