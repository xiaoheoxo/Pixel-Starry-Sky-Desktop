// 接着 Claude Code 的终端会话：列表、pid 登记、导入（docs/ui/claude-resume.md §3、§4、§7）
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Item } from '@pixelsky/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NO_REPLY } from '../src/chat-log'
import { buildHandoff } from '../src/handoff'
import {
  NATIVE_TEXT,
  claudeSessionDetail,
  clearNativeCaches,
  listClaudeSessions,
  liveClaudeSession,
  newerTurns,
  readClaudeSession,
  splitPrompt,
} from '../src/claude/native'
import { encodeCwd, seedTranscript } from '../src/claude/transcript'
import { clearTranscriptIndexCache } from '../src/claude/transcript-index'

let root: string
let projects: string
let cwd: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pixelsky-native-'))
  projects = join(root, 'config', 'projects')
  cwd = join(root, 'proj')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(projects, { recursive: true })
  clearNativeCaches()
  clearTranscriptIndexCache()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const T0 = Date.parse('2026-10-01T00:00:00Z')
type Block = Record<string, unknown>

/** 手写一份 Claude Code 的会话记录 */
class Log {
  rows: unknown[] = []
  n = 0
  constructor(
    readonly sid: string,
    readonly dirCwd = cwd,
    readonly extra: Record<string, unknown> = { version: '2.1.300', entrypoint: 'cli', gitBranch: 'main' },
  ) {}
  private base(uuid: string, parent: string | null, more: Record<string, unknown>): Record<string, unknown> {
    return {
      parentUuid: parent,
      isSidechain: false,
      uuid,
      timestamp: new Date(T0 + this.n++ * 1000).toISOString(),
      userType: 'external',
      cwd: this.dirCwd,
      sessionId: this.sid,
      ...this.extra,
      ...more,
    }
  }
  user(uuid: string, parent: string | null, content: string | Block[], more: Record<string, unknown> = {}): this {
    this.rows.push(this.base(uuid, parent, { type: 'user', message: { role: 'user', content }, ...more }))
    return this
  }
  assistant(uuid: string, parent: string | null, content: string | Block[], more: Record<string, unknown> = {}): this {
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content
    this.rows.push(
      this.base(uuid, parent, {
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-opus-4-5', content: blocks },
        ...more,
      }),
    )
    return this
  }
  result(uuid: string, parent: string, toolId: string, out: string, more: Record<string, unknown> = {}): this {
    return this.user(uuid, parent, [{ type: 'tool_result', tool_use_id: toolId, content: out }], {
      toolUseResult: { stdout: out },
      ...more,
    })
  }
  system(uuid: string, parent: string | null, subtype: string, more: Record<string, unknown> = {}): this {
    this.rows.push(this.base(uuid, parent, { type: 'system', subtype, ...more }))
    return this
  }
  raw(row: unknown): this {
    this.rows.push(row)
    return this
  }
  get path(): string {
    return join(projects, encodeCwd(this.dirCwd), `${this.sid}.jsonl`)
  }
  save(): string {
    mkdirSync(join(projects, encodeCwd(this.dirCwd)), { recursive: true })
    writeFileSync(this.path, this.rows.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n')
    return this.path
  }
  append(): string {
    appendFileSync(this.path, this.rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    this.rows = []
    return this.path
  }
}

/** n 轮对话：u<k> → a<k>，返回最后一条的 uuid */
function turns(log: Log, from: number, count: number, parent: string | null, prefix = 'u'): string | null {
  let last = parent
  for (let k = from; k < from + count; k++) {
    log.user(`${prefix}${k}`, last, `问题 ${k}`, { origin: { kind: 'human' } })
    log.assistant(`${prefix}a${k}`, `${prefix}${k}`, `回答 ${k}`)
    last = `${prefix}a${k}`
  }
  return last
}

const users = (items: Item[]) => items.filter((i): i is Extract<Item, { kind: 'user' }> => i.kind === 'user')

// ======================================================================= 列表
describe('列表：第一步（stat + 头 64 KB）', () => {
  const touch = (path: string, age: number): void => {
    const t = new Date(Date.now() - age * 1000)
    utimesSync(path, t, t)
  }

  it('标题先用第一句；去掉像素星空加的前缀；来源、分支', async () => {
    const a = new Log(id(1))
    a.user('u1', null, '修复 Caddy 超时\n第二行', { origin: { kind: 'human' } }).assistant('a1', 'u1', 'ok')
    touch(a.save(), 10)
    const b = new Log(id(2), cwd, { version: '2.1.300', entrypoint: 'sdk-cli', gitBranch: 'dev' })
    b.user('u1', null, '另一个会话')
    touch(b.save(), 20)
    // 没有 entrypoint 的算其他程序
    const c = new Log(id(3), cwd, {})
    c.user('u1', null, '接力新建的会话')
    touch(c.save(), 30)
    const list = await listClaudeSessions(projects, cwd)
    expect(list.sessions.map(s => s.id)).toEqual([id(1), id(2), id(3)])
    expect(list.sessions.map(s => s.title)).toEqual(['修复 Caddy 超时', '另一个会话', '接力新建的会话'])
    expect(list.sessions.map(s => s.source)).toEqual(['terminal', 'other', 'other'])
    expect(list.sessions.map(s => s.branch)).toEqual(['main', 'dev', null])
    expect(list.sessions[0]).toMatchObject({ subdir: null, lastPrompt: null, model: null, cwd })
  })

  it('标题优先级：custom-title → 最后一条 ai-title → 第一句 → lastPrompt → 时间', async () => {
    const mk = (n: number, tail: unknown[], first = true) => {
      const log = new Log(id(n))
      if (first) log.user('u1', null, `第一句 ${n}`)
      for (const row of tail) log.raw(row)
      touch(log.save(), n)
    }
    mk(1, [
      { type: 'ai-title', aiTitle: '旧标题' },
      { type: 'ai-title', aiTitle: '新标题' },
    ])
    mk(2, [
      { type: 'ai-title', aiTitle: '机器起的' },
      { type: 'custom-title', customTitle: '我改的' },
    ])
    mk(3, [{ type: 'last-prompt', lastPrompt: '最后一句', leafUuid: 'u1' }])
    // 头部没有用户输入（比如开头被工具结果占满）、只有 lastPrompt
    const noFirst = new Log(id(4))
    noFirst.raw({ type: 'last-prompt', lastPrompt: '只剩最后一句', leafUuid: 'x', cwd })
    noFirst.rows.unshift({ type: 'mode', mode: 'default', cwd })
    touch(noFirst.save(), 4)
    const list = await listClaudeSessions(projects, cwd)
    const titles: string[] = []
    for await (const d of list.details()) titles.push(d.title)
    expect(titles).toEqual(['新标题', '我改的', '第一句 3', '只剩最后一句'])
    const byId = (n: number) => list.sessions.find(s => s.id === id(n))!
    expect(byId(1).title).toBe('新标题')
    expect(byId(3).lastPrompt).toBe('最后一句')
  })

  it('没有任何文字时标题是「Claude Code 会话 月-日 时:分」', async () => {
    const log = new Log(id(1))
    log.raw({ type: 'last-prompt', lastPrompt: '   ', leafUuid: 'x', cwd })
    log.rows.unshift({ type: 'mode', mode: 'x', cwd })
    log.save()
    const list = await listClaudeSessions(projects, cwd)
    expect(list.sessions[0].title).toMatch(/^Claude Code 会话 \d\d-\d\d \d\d:\d\d$/)
  })

  it('只有元数据的隐藏；0 字节、非 uuid 文件名、cwd 对不上的不列；末行半截照常', async () => {
    const meta = new Log(id(1))
    meta.raw({ type: 'mode', mode: 'default', cwd }).raw({ type: 'ai-title', aiTitle: 'x' })
    meta.save()
    const dir = join(projects, encodeCwd(cwd))
    writeFileSync(join(dir, `${id(2)}.jsonl`), '')
    writeFileSync(join(dir, 'notes.jsonl'), '{"cwd":"x","type":"user"}\n')
    writeFileSync(join(dir, `${id(3)}.txt`), 'x')
    mkdirSync(join(dir, id(4)))
    // 编码撞车：D:\a-b 和 D:\a_b 编码一样
    const ab = join(root, 'a-b')
    const a_b = join(root, 'a_b')
    mkdirSync(ab)
    mkdirSync(a_b)
    new Log(id(5), a_b).user('u1', null, '别的目录的会话').save()
    // 末行写到一半
    const half = new Log(id(6))
    half.user('u1', null, '半截末行').raw('{"type":"assistant","uuid":"a1","par')
    half.save()
    expect((await listClaudeSessions(projects, cwd)).sessions.map(s => s.id)).toEqual([id(6)])
    expect((await listClaudeSessions(projects, ab)).sessions).toEqual([])
    expect((await listClaudeSessions(projects, a_b)).sessions.map(s => s.id)).toEqual([id(5)])
  })

  it('第一句话贴了截图（那一行超过 64 KB、cwd 只在那一行）：接着往下读，照常列出、标题是那句话', async () => {
    const shot = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(200_000) } }
    const log = new Log(id(1))
    log.raw({ type: 'queue-operation', operation: 'enqueue', sessionId: id(1) })
    log.user('u1', null, [{ type: 'text', text: '看下这个报错' }, shot], { origin: { kind: 'human' } })
    log.assistant('a1', 'u1', '好的')
    log.save()
    const [s] = (await listClaudeSessions(projects, cwd)).sessions
    expect(s).toMatchObject({ id: id(1), cwd, title: '看下这个报错', firstPrompt: '看下这个报错' })
  })

  it('cwd 在前面的小行、第一句话那一行跨过 64 KB：把这一行读完，标题是那句话', async () => {
    const log = new Log(id(1))
    log.raw({ type: 'mode', mode: 'default', cwd })
    log.user('u1', null, '贴一段日志\n' + 'log '.repeat(30_000), { origin: { kind: 'human' } })
    for (let k = 0; k < 5; k++) log.assistant(`a${k}`, 'u1', 'x'.repeat(50_000))
    log.save()
    const [s] = (await listClaudeSessions(projects, cwd)).sessions
    expect(s).toMatchObject({ id: id(1), title: '贴一段日志', firstPrompt: expect.stringMatching(/^贴一段日志/) })
  })

  it('整个头部都没有 cwd：在项目自己的记录目录里算这个项目的，别的目录里的不算', async () => {
    const dir = join(projects, encodeCwd(cwd))
    mkdirSync(dir, { recursive: true })
    const row = { type: 'user', uuid: 'u1', sessionId: id(1), message: { role: 'user', content: '没有 cwd 的会话' } }
    writeFileSync(join(dir, `${id(1)}.jsonl`), JSON.stringify(row) + '\n')
    const sub = join(cwd, 'sub')
    mkdirSync(sub)
    mkdirSync(join(projects, encodeCwd(sub)), { recursive: true })
    writeFileSync(join(projects, encodeCwd(sub), `${id(2)}.jsonl`), JSON.stringify({ ...row, sessionId: id(2) }) + '\n')
    const list = await listClaudeSessions(projects, cwd, { subfolders: true })
    expect(list.sessions.map(s => [s.id, s.cwd, s.subdir])).toEqual([[id(1), cwd, null]])
  })

  it('cwd 只差末尾分隔符（Windows 上还有大小写）的照常列', async () => {
    new Log(id(1)).user('u1', null, '一').save()
    // 记录里的 cwd 多一个末尾分隔符
    writeFileSync(
      join(projects, encodeCwd(cwd), `${id(3)}.jsonl`),
      JSON.stringify({ type: 'user', uuid: 'u1', cwd: cwd + '/', message: { content: '末尾分隔符' } }) + '\n',
    )
    expect((await listClaudeSessions(projects, cwd)).sessions).toHaveLength(2)
    if (process.platform === 'win32') {
      new Log(id(2), cwd.toUpperCase()).user('u1', null, '大写').save()
      const ids = (await listClaudeSessions(projects, cwd.toLowerCase())).sessions.map(s => s.id).sort()
      expect(ids).toEqual([id(1), id(2), id(3)])
    }
  })

  it('符号链接 / 目录联接进来的：两边 realpath 再比', async () => {
    const real = join(root, 'real')
    mkdirSync(real)
    const link = join(root, 'link')
    try {
      symlinkSync(real, link, 'junction')
    } catch {
      return
    }
    // 会话是在 link 下开的（记录里的 cwd 是 link），项目路径填的是 real
    const dir = join(projects, encodeCwd(real))
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${id(1)}.jsonl`),
      JSON.stringify({ type: 'user', uuid: 'u1', cwd: link, message: { content: '联接' } }) + '\n',
    )
    expect((await listClaudeSessions(projects, real)).sessions.map(s => s.id)).toEqual([id(1)])
  })

  it('目录不存在是空；读不了的目录抛错', async () => {
    expect((await listClaudeSessions(join(root, 'nope'), cwd)).sessions).toEqual([])
    const file = join(root, 'a-file')
    writeFileSync(file, 'x')
    await expect(listClaudeSessions(file, cwd)).rejects.toThrow()
  })

  it('长路径（目录名被截断加哈希）：按前缀找目录，再核对 cwd', async () => {
    // 目录不用真的建（Windows 上路径太长），只看记录里的 cwd
    const long = join(root, 'x'.repeat(220))
    const dir = join(projects, `${encodeCwd(long).slice(0, 200)}-9fz3k`)
    mkdirSync(dir)
    const row = (n: number) =>
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        cwd: n === 1 ? long : join(root, 'y'),
        message: { content: `长路径 ${n}` },
      }) + '\n'
    writeFileSync(join(dir, `${id(1)}.jsonl`), row(1))
    writeFileSync(join(dir, `${id(2)}.jsonl`), row(2))
    const list = await listClaudeSessions(projects, long)
    expect(list.sessions.map(s => s.id)).toEqual([id(1)])
  })

  it('子文件夹里开的会话：subfolders 时列出并标相对路径；兄弟目录、已删的子文件夹不列', async () => {
    const sub = join(cwd, 'apps', 'mobile')
    mkdirSync(sub, { recursive: true })
    const gone = join(cwd, 'scratch', 'gone')
    const verify = join(root, 'proj-verify')
    mkdirSync(verify)
    new Log(id(1)).user('u1', null, '根目录').save()
    new Log(id(2), sub).user('u1', null, '子文件夹').save()
    new Log(id(3), gone).user('u1', null, '已经删了').save()
    new Log(id(4), verify).user('u1', null, '兄弟目录').save()
    expect((await listClaudeSessions(projects, cwd)).sessions.map(s => s.id)).toEqual([id(1)])
    const list = await listClaudeSessions(projects, cwd, { subfolders: true })
    expect(list.sessions.map(s => [s.id, s.subdir]).sort()).toEqual([
      [id(1), null],
      [id(2), 'apps/mobile'],
    ])
    expect(list.sessions.find(s => s.id === id(2))?.cwd).toBe(sub)
  })

  it('最多给 limit 个，按修改时间从新到旧', async () => {
    for (let n = 1; n <= 5; n++) touch(new Log(id(n)).user('u1', null, `会话 ${n}`).save(), n * 10)
    const list = await listClaudeSessions(projects, cwd, { limit: 3 })
    expect(list.sessions.map(s => s.id)).toEqual([id(1), id(2), id(3)])
  })
})

describe('列表：第二步（尾部）', () => {
  const filler = 'z'.repeat(8000)
  /** 600 KB 的会话：last-prompt 等元数据在开头附近，后面是大块填充 */
  const bigSession = (n: number, tailRows: unknown[] = []): string => {
    const log = new Log(id(n))
    log.user('u1', null, `大会话 ${n}`).assistant('a1', 'u1', '好')
    for (let k = 0; k < 75; k++) log.raw({ type: 'attachment', uuid: `f${k}`, parentUuid: 'a1', cwd, text: filler })
    for (const row of tailRows) log.raw(row)
    return log.save()
  }

  it('第一步不读尾部：lastPrompt 在文件末尾时列表里是空的，第二步补上，并补模型、分支、最后活动时间', async () => {
    bigSession(1, [
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'a1',
        timestamp: '2026-10-02T03:04:05.000Z',
        gitBranch: 'feat',
        message: { model: 'claude-sonnet-4-5', content: [] },
      },
      { type: 'assistant', uuid: 'a3', parentUuid: 'a2', message: { model: '<synthetic>', content: [] } },
      { type: 'assistant', uuid: 'a4', parentUuid: 'a3', message: { content: [] } },
      { type: 'ai-title', aiTitle: '尾部标题' },
      { type: 'last-prompt', lastPrompt: '（像素星空补充：更早 3 轮…）\n- 一\n\n最后一句话', leafUuid: 'a4' },
    ])
    const list = await listClaudeSessions(projects, cwd)
    expect(list.sessions[0]).toMatchObject({ lastPrompt: null, model: null, title: '大会话 1' })
    const [detail] = await collect(list.details())
    expect(detail).toMatchObject({
      id: id(1),
      lastPrompt: '最后一句话',
      title: '尾部标题',
      model: 'claude-sonnet-4-5',
      branch: 'feat',
      lastActive: Date.parse('2026-10-02T03:04:05.000Z'),
      hidden: false,
      skipped: false,
    })
    expect(detail.read).toBeGreaterThan(0)
    expect(detail.read).toBeLessThanOrEqual(256 * 1024 * 3)
    // 补进了列表里的条目；排序用的 mtime 不变
    expect(list.sessions[0]).toMatchObject({ lastPrompt: '最后一句话', title: '尾部标题', model: 'claude-sonnet-4-5' })
    // 再列一次：尾部命中缓存，不再读
    const again = await listClaudeSessions(projects, cwd)
    const [cached] = await collect(again.details())
    expect(cached.read).toBe(0)
    expect(cached.lastPrompt).toBe('最后一句话')
  })

  it('单个文件最多读 tailCap，总共不超过预算，用完了剩下的 skipped', async () => {
    for (let n = 1; n <= 3; n++) {
      // last-prompt 在开头附近，尾部读不到它
      const log = new Log(id(n))
      log.user('u1', null, `会话 ${n}`)
      for (let k = 0; k < 75; k++) {
        log.raw({ type: 'attachment', uuid: `f${k}`, parentUuid: 'u1', cwd, text: filler })
        if (k === 9) log.raw({ type: 'last-prompt', lastPrompt: `藏在中间 ${n}`, leafUuid: 'u1' })
      }
      touch(log.save(), n)
    }
    const list = await listClaudeSessions(projects, cwd, { tailBudget: 150 * 1024, tailCap: 100 * 1024 })
    const details = await collect(list.details())
    expect(details.map(d => d.read)).toEqual([100 * 1024, 50 * 1024, 0])
    expect(details.map(d => d.skipped)).toEqual([false, false, true])
    expect(list.budget.left).toBe(0)
    // 读不到 lastPrompt 就是没有；预算用完的保持第一步的样子
    expect(details[2].lastPrompt).toBeNull()
  })

  it('头部没有用户输入、尾部也没有 lastPrompt 的大文件：第二步标成 hidden', async () => {
    const log = new Log(id(1))
    log.raw({ type: 'mode', mode: 'default', cwd })
    for (let k = 0; k < 20; k++) log.raw({ type: 'attachment', uuid: `f${k}`, cwd, text: filler })
    log.save()
    const list = await listClaudeSessions(projects, cwd)
    expect(list.sessions).toHaveLength(1)
    const [d] = await collect(list.details())
    expect(d.hidden).toBe(true)
  })

  it('末尾有 continued-in：目标记录在同一个目录里算 superseded，不在照常', async () => {
    const mk = (n: number, target: string): void => {
      new Log(id(n))
        .user('u1', null, `会话 ${n}`)
        .raw({
          type: 'continued-in',
          timestamp: '2026-10-09T12:36:48.118Z',
          sessionId: id(n),
          continuedInSessionId: target,
        })
        .save()
    }
    mk(1, id(2))
    mk(3, id(9))
    new Log(id(2)).user('u1', null, '接着的').save()
    const list = await listClaudeSessions(projects, cwd)
    const details = await collect(list.details([id(1), id(3)]))
    expect(details.map(d => [d.id, d.continuedIn, d.superseded])).toEqual([
      [id(1), id(2), true],
      [id(3), id(9), false],
    ])
  })

  it('claudeSessionDetail 单独用：预算 0 时 skipped', async () => {
    new Log(id(1)).user('u1', null, '一').raw({ type: 'last-prompt', lastPrompt: '末', leafUuid: 'u1' }).save()
    const list = await listClaudeSessions(projects, cwd)
    const d = await claudeSessionDetail(list.sessions[0], { left: 0 })
    expect(d).toMatchObject({ skipped: true, read: 0 })
  })

  function touch(path: string, age: number): void {
    const t = new Date(Date.now() - age * 1000)
    utimesSync(path, t, t)
  }
})

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of gen) out.push(v)
  return out
}

describe('前缀拆分', () => {
  it('交接材料和接力概要', () => {
    expect(splitPrompt('<pixelsky-handoff conversation="c">\n内容\n</pixelsky-handoff>\n\n原话')).toEqual({
      text: '原话',
      handoff: '<pixelsky-handoff conversation="c">\n内容\n</pixelsky-handoff>',
      overview: null,
    })
    expect(splitPrompt('（像素星空补充：更早还有 2 轮）\n- 一\n- 二\n\n原话')).toEqual({
      text: '原话',
      handoff: null,
      overview: '（像素星空补充：更早还有 2 轮）\n- 一\n- 二',
    })
    expect(splitPrompt('普通的话')).toEqual({ text: '普通的话', handoff: null, overview: null })
  })
})

// ======================================================================= pid 登记
describe('正开着吗', () => {
  let config: string
  beforeEach(() => {
    config = join(root, 'config')
    mkdirSync(join(config, 'sessions'), { recursive: true })
  })
  const register = (name: string, body: unknown): void =>
    writeFileSync(join(config, 'sessions', name), typeof body === 'string' ? body : JSON.stringify(body))

  /** 一个已经退出的进程的 pid */
  function deadPid(): number {
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'])
    return Number(r.stdout.toString())
  }

  it('进程活着：entrypoint 是 cli 算终端，其余算别的程序', () => {
    register(`${process.pid}.json`, { pid: process.pid, sessionId: id(1), entrypoint: 'cli', kind: 'interactive' })
    expect(liveClaudeSession(config, id(1))).toBe('terminal')
    register(`${process.pid}.json`, { pid: process.pid, sessionId: id(1), entrypoint: 'sdk-cli', kind: 'interactive' })
    expect(liveClaudeSession(config, id(1))).toBe('other')
    expect(liveClaudeSession(config, id(2))).toBeNull()
  })

  it('进程已死、像素星空自己的进程不算', () => {
    register('dead.json', { pid: deadPid(), sessionId: id(1), entrypoint: 'cli' })
    expect(liveClaudeSession(config, id(1))).toBeNull()
    register('mine.json', { pid: process.pid, sessionId: id(2), entrypoint: 'sdk-cli' })
    expect(liveClaudeSession(config, id(2), [process.pid])).toBeNull()
    expect(liveClaudeSession(config, id(2), new Set([1]))).toBe('other')
  })

  it('只读 *.json：.key 文件里写什么都不算', () => {
    register(`${process.pid}.abcdef.key`, { pid: process.pid, sessionId: id(1), entrypoint: 'cli' })
    expect(liveClaudeSession(config, id(1))).toBeNull()
  })

  it('格式坏了或目录不在：退回看记录的修改时间，2 分钟内是 maybe', () => {
    register('bad.json', '{坏了')
    const now = Date.now()
    expect(liveClaudeSession(config, id(1), [], now - 30_000)).toBe('maybe')
    expect(liveClaudeSession(config, id(1), [], now - 10 * 60_000)).toBeNull()
    expect(liveClaudeSession(config, id(1))).toBeNull()
    expect(liveClaudeSession(join(root, 'no-config'), id(1), [], now)).toBe('maybe')
    // 别的登记是好的、也对得上时，不管坏的那个
    register(`${process.pid}.json`, { pid: process.pid, sessionId: id(1), entrypoint: 'cli' })
    expect(liveClaudeSession(config, id(1), [], now)).toBe('terminal')
  })
})

// ======================================================================= 导入
describe('导入：分支、末端、压缩', () => {
  it('基本：user 条目 id 是行 uuid 且标 claude；工具补全；标题、来源、模型、末端', async () => {
    const log = new Log(id(1))
    log
      .user('u1', null, '看看目录', { origin: { kind: 'human' } })
      .assistant('a1', 'u1', [{ type: 'thinking', thinking: '想一想' }])
      .assistant('a2', 'a1', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }])
      .result('r1', 'a2', 'toolu_1', 'file.txt')
      .assistant('a3', 'r1', '有一个文件')
      .raw({ type: 'ai-title', aiTitle: '看目录' })
      .save()
    const r = (await readClaudeSession(projects, cwd, id(1)))!
    expect(r.items.map(i => i.kind)).toEqual(['user', 'reasoning', 'command', 'assistant'])
    expect(r.items[0]).toMatchObject({ kind: 'user', id: 'u1', text: '看看目录', engine: 'claude' })
    expect(r.items[1]).toMatchObject({ id: 'imp-a1-0', text: '想一想', status: 'completed' })
    expect(r.items[2]).toMatchObject({
      id: 'toolu_1',
      command: 'ls',
      output: 'file.txt',
      status: 'completed',
      exitCode: 0,
    })
    expect(r.items[3]).toMatchObject({ id: 'imp-a3-0', text: '有一个文件' })
    expect(r).toMatchObject({
      title: '看目录',
      turns: 1,
      shown: 1,
      summary: null,
      source: 'terminal',
      model: 'claude-opus-4-5',
      leafUuid: 'a3',
      at: 'a3',
      earliestShownUuid: 'u1',
      hasEarlier: false,
      compacted: false,
    })
    expect(users(r.items)[0].createdAt).toBe(Date.parse(String((log.rows[0] as { timestamp: string }).timestamp)))
  })

  it('记录不在返回 null；id 不是 uuid 抛错（防 ../）', async () => {
    expect(await readClaudeSession(projects, cwd, id(9))).toBeNull()
    await expect(readClaudeSession(projects, cwd, '../x')).rejects.toThrow()
  })

  it('有回退旁支时走最后写下的那条分支', async () => {
    const log = new Log(id(1))
    turns(log, 1, 2, null)
    // 回退到 ua1 之后接着聊
    log
      .user('x2', 'ua1', '改问这个', { origin: { kind: 'human' } })
      .assistant('xa2', 'x2', '新回答')
      .save()
    const r = (await readClaudeSession(projects, cwd, id(1)))!
    expect(users(r.items).map(u => u.text)).toEqual(['问题 1', '改问这个'])
    expect(r.items.map(i => i.kind)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(r.at).toBe('xa2')
  })

  it('last-prompt 比最后的消息新：用它的 leafUuid（可以是 system 行）；比最后的消息旧：不用', async () => {
    const log = new Log(id(1))
    turns(log, 1, 2, null)
    log.user('x2', 'ua1', '岔开的一问', { origin: { kind: 'human' } }).assistant('xa2', 'x2', '岔开的回答')
    // last-prompt 指向旧分支末端（回退后进程退出时写的），在最后一条消息之后
    log.raw({ type: 'last-prompt', lastPrompt: '问题 2', leafUuid: 'ua2' }).save()
    let r = (await readClaudeSession(projects, cwd, id(1)))!
    expect(users(r.items).map(u => u.text)).toEqual(['问题 1', '问题 2'])
    expect(r.leafUuid).toBe('ua2')
    // 之后又有新消息：last-prompt 旧了，不用
    log.rows = []
    log
      .user('x3', 'xa2', '继续', { origin: { kind: 'human' } })
      .assistant('xa3', 'x3', '好')
      .append()
    r = (await readClaudeSession(projects, cwd, id(1)))!
    expect(users(r.items).map(u => u.text)).toEqual(['问题 1', '岔开的一问', '继续'])
  })

  it('leafUuid 指向 system/turn_duration 这类行时照样找到分支', async () => {
    const log = new Log(id(1))
    turns(log, 1, 1, null)
    log.system('s1', 'ua1', 'turn_duration', { durationMs: 5 })
    log.raw({ type: 'last-prompt', lastPrompt: '问题 1', leafUuid: 's1' }).save()
    const r = (await readClaudeSession(projects, cwd, id(1)))!
    expect(r.leafUuid).toBe('s1')
    expect(r.at).toBe('ua1')
    expect(users(r.items)).toHaveLength(1)
  })

  /** 压缩：前面 3 轮（u1-u3），保留段 P1-P3 在边界之前，边界 b1，摘要 sum1，之后 2 轮 */
  function compacted(log: Log): void {
    const last = turns(log, 1, 3, null)
    log.user('p1', last, '保留的用户话', { origin: { kind: 'human' } })
    log.assistant('pa1', 'p1', '保留的回答')
    log.system('b1', null, 'compact_boundary', {
      logicalParentUuid: 'pa1',
      content: 'Conversation compacted',
      compactMetadata: {
        trigger: 'auto',
        preTokens: 90000,
        postTokens: 12000,
        durationMs: 4500,
        preservedSegment: { headUuid: 'p1', anchorUuid: 'sum1', tailUuid: 'pa1' },
      },
    })
    log.user('sum1', 'b1', '这是压缩摘要', { isCompactSummary: true, isVisibleInTranscriptOnly: true })
    turns(log, 10, 2, 'sum1', 'n')
  }

  it('在 compact_boundary 停下并取到摘要；保留段接在摘要后面、顺序对；总轮数越过边界数、保留段不重复算', async () => {
    const log = new Log(id(1))
    compacted(log)
    log.save()
    const r = (await readClaudeSession(projects, cwd, id(1)))!
    // compaction 条目 → 保留段 → 之后的两轮；摘要行本身不是用户消息
    expect(r.items.map(i => i.kind)).toEqual([
      'compaction',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    expect(r.items[0]).toMatchObject({
      kind: 'compaction',
      status: 'completed',
      trigger: 'auto',
      preTokens: 90000,
      postTokens: 12000,
      durationMs: 4500,
      startedAt: Date.parse(
        String((log.rows.find(x => (x as { uuid: string }).uuid === 'b1') as { timestamp: string }).timestamp),
      ),
    })
    expect(users(r.items).map(u => u.text)).toEqual(['保留的用户话', '问题 10', '问题 11'])
    expect(r.summary).toBe('这是压缩摘要')
    // 前面 3 轮 + 保留的 1 轮 + 后面 2 轮
    expect(r.turns).toBe(6)
    expect(r.shown).toBe(3)
    expect(r.hasEarlier).toBe(true)
    expect(r.compacted).toBe(false)
    expect(r.earliestShownUuid).toBe('p1')
  })

  it('没有 preservedSegment 的边界也对', async () => {
    const log = new Log(id(1))
    const last = turns(log, 1, 2, null)
    log.system('b1', null, 'compact_boundary', {
      logicalParentUuid: last,
      compactMetadata: { trigger: 'manual', preTokens: 5 },
    })
    log.user('sum1', 'b1', '摘要', { isCompactSummary: true })
    turns(log, 5, 1, 'sum1', 'n')
    log.save()
    const r = (await readClaudeSession(projects, cwd, id(1)))!
    expect(r.items.map(i => i.kind)).toEqual(['compaction', 'user', 'assistant'])
    expect(r.items[0]).toMatchObject({ trigger: 'manual', postTokens: null, durationMs: null })
    expect(r.turns).toBe(3)
  })
})

describe('导入：行的取舍', () => {
  it('origin.kind 不是 human 的（task-notification 不是 isMeta、peer 是 isMeta）不当用户消息；没有 origin 的旧行照常算', async () => {
    const log = new Log(id(1))
    log
      .user('u1', null, '旧版本写的，没有 origin')
      .assistant('a1', 'u1', '好')
      .user('n1', 'a1', '<task-notification>任务做完了</task-notification>', {
        origin: { kind: 'task-notification' },
        promptSource: 'system',
      })
      .assistant('a2', 'n1', '知道了')
      .user('pe1', 'a2', '别的会话来的', { origin: { kind: 'peer' }, isMeta: true })
      .user('u2', 'pe1', '新的问题', { origin: { kind: 'human' } })
      .assistant('a3', 'u2', '回答')
      .save()
    const r = (await readClaudeSession(projects, cwd, id(1)))!
    expect(users(r.items).map(u => u.text)).toEqual(['旧版本写的，没有 origin', '新的问题'])
    expect(r.turns).toBe(2)
    expect(r.items.filter(i => i.kind === 'assistant')).toHaveLength(3)
  })

  it('斜杠命令行变成 /x args；local-command 输出、isMeta 说明行、中断提示跳过', async () => {
    const log = new Log(id(1))
    log
      .user(
        'c1',
        null,
        '<command-message>compact</command-message>\n<command-name>/compact</command-name>\n<command-args>只留结论</command-args>',
      )
      .user('l1', 'c1', '<local-command-stdout>Compacted</local-command-stdout>')
      .user('m1', 'l1', '<local-command-caveat>Caveat</local-command-caveat>', { isMeta: true })
      .user('c2', 'm1', '<command-name>clear</command-name><command-args></command-args>')
      .user('i1', 'c2', [{ type: 'text', text: '[Request interrupted by user]' }])
      .user('u1', 'i1', '真正的话', { origin: { kind: 'human' } })
      .save()
    const r = (await readClaudeSession(projects, cwd, id(1)))!
    expect(users(r.items).map(u => [u.id, u.text])).toEqual([
      ['c1', '/compact 只留结论'],
      ['c2', '/clear'],
      ['u1', '真正的话'],
    ])
    expect(r.turns).toBe(3)
  })

  it('图片不导入，文字后面加一句；工具结果里的图片也不带', async () => {
    const log = new Log(id(1))
    log
      .user('u1', null, [
        { type: 'text', text: '看这两张图' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
      ])
      .assistant('a1', 'u1', [
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: join(cwd, 'x.png') } },
      ])
      .user('r1', 'a1', [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'CCCC' } }],
        },
      ])
      .save()
    const r = (await readClaudeSession(projects, cwd, id(1)))!
    expect(users(r.items)[0].text).toBe(`看这两张图\n${NATIVE_TEXT.images(2)}`)
    expect(r.items[1]).toMatchObject({ kind: 'tool', id: 'toolu_1', status: 'completed' })
    expect((r.items[1] as { images?: unknown }).images).toBeUndefined()
  })

  it('只发了图片（没写字）的用户消息也是一轮：导入显示图片提示，算轮数、有回退入口', async () => {
    const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    const log = new Log(id(1))
    log
      .user('u1', null, '第一问', { origin: { kind: 'human' } })
      .assistant('a1', 'u1', '第一答')
      .user('u2', 'a1', [png], { origin: { kind: 'human' } })
      .assistant('a2', 'u2', '第二答')
      .save()
    const r = (await readClaudeSession(projects, cwd, id(1)))!
    expect(r.turns).toBe(2)
    expect(users(r.items).map(u => [u.id, u.text])).toEqual([
      ['u1', '第一问'],
      ['u2', NATIVE_TEXT.images(1)],
    ])
    expect(r.items.filter(i => i.kind === 'assistant').map(i => (i as { text: string }).text)).toEqual([
      '第一答',
      '第二答',
    ])
  })

  it('终端里追加了一轮只发图片的：补上找得到（从已知那一轮的末尾算起也一样）', async () => {
    const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    const log = new Log(id(1))
    turns(log, 1, 1, null)
    log.save()
    const base = (await readClaudeSession(projects, cwd, id(1)))!
    log.rows = []
    log
      .user('t1', base.at, [png], { origin: { kind: 'human' } })
      .assistant('ta1', 't1', '看到了')
      .append()
    clearNativeCaches()
    const next = (await newerTurns(projects, cwd, id(1), base.at!))!
    expect(next).toMatchObject({ turns: 1, shown: 1, at: 'ta1' })
    expect(next.items.map(i => i.kind)).toEqual(['user', 'assistant'])
    expect(next.items[0]).toMatchObject({ id: 't1', text: NATIVE_TEXT.images(1) })
    // 宿主按「对话里认识的最后一条用户消息」补：从 u1 这一轮的末尾算起，新的一轮照样找得到
    expect((await newerTurns(projects, cwd, id(1), 'u1', { afterTurn: true }))!).toMatchObject({ turns: 1, shown: 1 })
  })

  it('列表：第一条只发了图片时标题用后面第一句有字的；整个会话只发过图片也照样列出、不隐藏', async () => {
    const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    new Log(id(1))
      .user('u1', null, [png], { origin: { kind: 'human' } })
      .assistant('a1', 'u1', '一张截图')
      .user('u2', 'a1', '帮我把按钮改圆', { origin: { kind: 'human' } })
      .assistant('a2', 'u2', '好')
      .save()
    new Log(id(2))
      .user('v1', null, [png], { origin: { kind: 'human' } })
      .assistant('b1', 'v1', '看到了')
      .save()
    const list = await listClaudeSessions(projects, cwd)
    const byId = new Map(list.sessions.map(s => [s.id, s]))
    expect(byId.get(id(1))?.title).toBe('帮我把按钮改圆')
    expect(byId.has(id(2))).toBe(true)
    const details = await collect(list.details())
    expect(details.find(d => d.id === id(2))?.hidden).toBe(false)
  })

  it('大的工具结果（<persisted-output>）照原样显示', async () => {
    const out =
      '<persisted-output>\nOutput too large (2MB). Full output saved to: C:\\x\\tool-results\\a.txt\n\nPreview…\n</persisted-output>'
    new Log(id(1))
      .user('u1', null, '跑一下')
      .assistant('a1', 'u1', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'big' } }])
      .result('r1', 'a1', 'toolu_1', out)
      .save()
    const r = (await readClaudeSession(projects, cwd, id(1)))!
    expect(r.items[1]).toMatchObject({ kind: 'command', output: out })
  })

  it('并行工具调用：兄弟结果不在当前分支上也能补上；没有结果的标 interrupted', async () => {
    const log = new Log(id(1))
    log
      .user('u1', null, '并行查')
      .assistant('a1', 'u1', [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'a' } }])
      .assistant('a2', 'a1', [{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'b' } }])
      .assistant('a3', 'a2', [{ type: 'tool_use', id: 'toolu_c', name: 'Bash', input: { command: 'c' } }])
      // 结果各挂在自己的 tool_use 行下面；下一条 assistant 只接在最后一个结果后面，前两个结果是旁支
      .result('ra', 'a1', 'toolu_a', 'A 的结果')
      .result('rb', 'a2', 'toolu_b', 'B 的结果')
      .result('rc', 'a3', 'toolu_c', 'C 的结果')
      .assistant('a4', 'rc', [{ type: 'tool_use', id: 'toolu_d', name: 'Bash', input: { command: 'd' } }])
      .save()
    const r = (await readClaudeSession(projects, cwd, id(1)))!
    const cmds = r.items.filter((i): i is Extract<Item, { kind: 'command' }> => i.kind === 'command')
    expect(cmds.map(c => [c.id, c.output, c.status])).toEqual([
      ['toolu_a', 'A 的结果', 'completed'],
      ['toolu_b', 'B 的结果', 'completed'],
      ['toolu_c', 'C 的结果', 'completed'],
      ['toolu_d', '', 'interrupted'],
    ])
  })

  it('按 50 轮截断，剩余轮数算对；条目超过上限时整轮整轮去掉', async () => {
    const log = new Log(id(1))
    turns(log, 1, 120, null)
    log.save()
    const r = (await readClaudeSession(projects, cwd, id(1)))!
    expect(r.turns).toBe(120)
    expect(r.shown).toBe(50)
    expect(users(r.items)[0].text).toBe('问题 71')
    expect(r.earliestShownUuid).toBe('u71')
    expect(r.hasEarlier).toBe(true)
    const capped = (await readClaudeSession(projects, cwd, id(1), { maxItems: 25 }))!
    expect(capped.items).toHaveLength(24)
    expect(capped.shown).toBe(12)
    expect(users(capped.items)[0].text).toBe('问题 109')
    expect(capped.hasEarlier).toBe(true)
    const all = (await readClaudeSession(projects, cwd, id(1), { turns: 500 }))!
    expect(all.shown).toBe(120)
    expect(all.hasEarlier).toBe(false)
  })

  it('正开着、末尾一轮还没结束：这一轮不导入，截断点在它前面', async () => {
    const log = new Log(id(1))
    turns(log, 1, 2, null)
    log
      .user('u3', 'ua2', '正在做的', { origin: { kind: 'human' } })
      .assistant('a3', 'u3', [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'sleep' } }])
      .save()
    const live = (await readClaudeSession(projects, cwd, id(1), { live: true }))!
    expect(users(live.items).map(u => u.text)).toEqual(['问题 1', '问题 2'])
    expect(live.at).toBe('ua2')
    expect(live.turns).toBe(2)
    // 没开着的照旧：没结果的工具标 interrupted
    const idle = (await readClaudeSession(projects, cwd, id(1)))!
    expect(users(idle.items)).toHaveLength(3)
    expect(idle.items.at(-1)).toMatchObject({ kind: 'command', status: 'interrupted' })
    expect(idle.at).toBe('a3')
    // 这一轮已经结束就照常导入
    log.rows = []
    log.result('r3', 'a3', 'toolu_x', 'done').assistant('a4', 'r3', '完成').append()
    const done = (await readClaudeSession(projects, cwd, id(1), { live: true }))!
    expect(users(done.items)).toHaveLength(3)
    expect(done.at).toBe('a4')
  })

  it('取消：signal 中途触发时抛出不返回条目；进度按字节递增', async () => {
    const log = new Log(id(1))
    turns(log, 1, 60, null)
    log.save()
    const ctl = new AbortController()
    const progress: number[] = []
    await expect(
      readClaudeSession(projects, cwd, id(1), {
        chunk: 1024,
        signal: ctl.signal,
        onProgress: read => {
          progress.push(read)
          if (progress.length === 3) ctl.abort()
        },
      }),
    ).rejects.toThrow()
    expect(progress).toEqual([1024, 2048, 3072])
    clearTranscriptIndexCache()
    const seen: number[] = []
    const r = await readClaudeSession(projects, cwd, id(1), { chunk: 1024, onProgress: read => seen.push(read) })
    expect(r?.items.length).toBeGreaterThan(0)
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)
    expect(seen.length).toBeGreaterThan(3)
  })
})

describe('导入：像素星空接力写进来的行（用真的 seedTranscript 生成）', () => {
  const uuid1 = '11111111-2222-4333-8444-555555555555'
  const uuid2 = '66666666-2222-4333-8444-555555555555'

  it('新建的文件（开头没有 entrypoint）：来源是其他程序；提示、user 条目标 claude、NO_REPLY 不建 assistant、非 uuid 的 id 换成新的', async () => {
    await seedTranscript(
      projects,
      cwd,
      id(1),
      [
        { id: uuid1, user: '用 Codex 聊的第一句', assistant: 'Codex 的回答' },
        { id: 'not-a-uuid', user: '第二句', assistant: null },
      ],
      NO_REPLY,
    )
    const r = (await readClaudeSession(projects, cwd, id(1)))!
    expect(r.source).toBe('other')
    expect(r.items.map(i => i.kind)).toEqual(['notice', 'user', 'assistant', 'user'])
    expect(r.items[0]).toMatchObject({ kind: 'notice', level: 'info', text: NATIVE_TEXT.relayRun(2), detail: null })
    expect(r.items[1]).toMatchObject({ id: uuid1, text: '用 Codex 聊的第一句', engine: 'claude' })
    expect(r.items[2]).toMatchObject({ text: 'Codex 的回答' })
    const second = r.items[3] as Extract<Item, { kind: 'user' }>
    expect(second.text).toBe('第二句')
    expect(second.id).not.toBe('not-a-uuid')
    expect(second.engine).toBe('claude')
    expect(r.turns).toBe(2)
    expect(r.model).toBeNull()
    // 回退时按条目 id 找得到
    expect(r.title).toBe('用 Codex 聊的第一句')
  })

  it('接在已有记录后面：只有接力的那段前面有提示；Claude 自己的轮次照常', async () => {
    const log = new Log(id(1))
    turns(log, 1, 2, null)
    log.save()
    await seedTranscript(projects, cwd, id(1), [{ id: uuid1, user: '换去 Codex 聊', assistant: '好的' }], NO_REPLY)
    const r = (await readClaudeSession(projects, cwd, id(1)))!
    expect(r.items.map(i => i.kind)).toEqual(['user', 'assistant', 'user', 'assistant', 'notice', 'user', 'assistant'])
    expect(r.items[4]).toMatchObject({ text: NATIVE_TEXT.relayRun(1) })
    expect(users(r.items).map(u => u.engine)).toEqual(['claude', 'claude', 'claude'])
    // seedTranscript 补了一条指向新末端的 last-prompt
    expect(r.leafUuid).not.toBe('ua2')
    expect(r.turns).toBe(3)
  })

  it('带概要前缀的第一轮：概要进提示的 detail，user 条目只留原话；标题和 lastPrompt 去掉前缀', async () => {
    const overview = '（像素星空补充：这段对话更早还有 5 轮，原文没有带过来，下面是其中用户的要求）\n- 要求一\n- 要求二'
    await seedTranscript(
      projects,
      cwd,
      id(1),
      [{ id: uuid1, user: `${overview}\n\n真正的第一句`, assistant: '嗯' }],
      NO_REPLY,
    )
    const r = (await readClaudeSession(projects, cwd, id(1)))!
    expect(r.items[0]).toMatchObject({ kind: 'notice', detail: overview })
    expect(users(r.items)[0].text).toBe('真正的第一句')
    expect(r.title).toBe('真正的第一句')
    // 列表里的第一句和 lastPrompt 也去掉
    appendFileSync(
      join(projects, encodeCwd(cwd), `${id(1)}.jsonl`),
      JSON.stringify({ type: 'last-prompt', lastPrompt: `${overview}\n\n最后一句`, leafUuid: 'x' }) + '\n',
    )
    const list = await listClaudeSessions(projects, cwd)
    expect(list.sessions[0].title).toBe('真正的第一句')
    expect(list.sessions[0].firstPrompt).toBe('真正的第一句')
    const [d] = await collect(list.details())
    expect(d.lastPrompt).toBe('最后一句')
  })

  it('两段接力之间隔着 Claude 自己的轮次：各有一条提示', async () => {
    await seedTranscript(projects, cwd, id(1), [{ id: uuid1, user: '接力一', assistant: '答一' }], NO_REPLY)
    const log = new Log(id(1))
    const rows = readFileSync(log.path, 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l) as { uuid?: string; type: string })
    const leaf = rows.filter(r => r.type === 'assistant').at(-1)!.uuid!
    log
      .user('c1', leaf, 'Claude 自己的一轮', { origin: { kind: 'human' } })
      .assistant('ca1', 'c1', '嗯')
      .append()
    await seedTranscript(projects, cwd, id(1), [{ id: uuid2, user: '接力二', assistant: '答二' }], NO_REPLY)
    const r = (await readClaudeSession(projects, cwd, id(1)))!
    expect(r.items.filter(i => i.kind === 'notice').map(i => (i as { text: string }).text)).toEqual([
      NATIVE_TEXT.relayRun(1),
      NATIVE_TEXT.relayRun(1),
    ])
    expect(users(r.items).map(u => u.text)).toEqual(['接力一', 'Claude 自己的一轮', '接力二'])
  })

  it('文字交接：用真的 buildHandoff 生成的前缀拆开，user 条目只剩原话，提示里有交接原文', async () => {
    const handoff = buildHandoff({
      items: [
        { kind: 'user', id: 'x1', text: '之前问过的', createdAt: 1, engine: 'codex' },
        { kind: 'assistant', id: 'x2', text: '之前答过的', status: 'completed' },
      ],
      mode: 'full',
      target: 'claude',
      conversationId: 'conv-1',
    })!
    new Log(id(1))
      .user('u1', null, `${handoff.text}\n\n接着问这个`, { origin: { kind: 'human' } })
      .assistant('a1', 'u1', '好')
      .save()
    const r = (await readClaudeSession(projects, cwd, id(1)))!
    expect(r.items.map(i => i.kind)).toEqual(['notice', 'user', 'assistant'])
    expect(r.items[0]).toMatchObject({ text: NATIVE_TEXT.handoff, detail: handoff.text })
    expect(users(r.items)[0]).toMatchObject({ id: 'u1', text: '接着问这个' })
    expect(r.title).toBe('接着问这个')
    const list = await listClaudeSessions(projects, cwd)
    expect(list.sessions[0].title).toBe('接着问这个')
  })
})

describe('加载更早的', () => {
  it('取下一批轮次，接在原来的前面，id 不重；到文件开头后 hasEarlier 为 false', async () => {
    const log = new Log(id(1))
    turns(log, 1, 120, null)
    log.save()
    const first = (await readClaudeSession(projects, cwd, id(1)))!
    expect(first.earliestShownUuid).toBe('u71')
    const second = (await readClaudeSession(projects, cwd, id(1), { before: first.earliestShownUuid! }))!
    expect(users(second.items)[0].text).toBe('问题 21')
    expect(second.shown).toBe(50)
    expect(second.hasEarlier).toBe(true)
    expect(second.earliestShownUuid).toBe('u21')
    const third = (await readClaudeSession(projects, cwd, id(1), { before: second.earliestShownUuid! }))!
    expect(users(third.items).map(u => u.text)).toEqual(Array.from({ length: 20 }, (_, i) => `问题 ${i + 1}`))
    expect(third.hasEarlier).toBe(false)
    const ids = [...first.items, ...second.items, ...third.items].map(i => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    await expect(readClaudeSession(projects, cwd, id(1), { before: 'nope' })).rejects.toThrow()
  })

  it('越过压缩边界：边界之间有 compaction 条目，标 compacted，一直翻到文件开头', async () => {
    const log = new Log(id(1))
    // 第一段 4 轮 → 边界 b1 → 第二段 4 轮 → 边界 b2（带保留段）→ 第三段 3 轮
    const l1 = turns(log, 1, 4, null, 'a')
    log.system('B1', null, 'compact_boundary', {
      logicalParentUuid: l1,
      compactMetadata: { trigger: 'manual', preTokens: 1 },
    })
    log.user('S1', 'B1', '摘要一', { isCompactSummary: true })
    const l2 = turns(log, 1, 4, 'S1', 'b')
    log.user('p1', l2, '保留的话', { origin: { kind: 'human' } }).assistant('pa1', 'p1', '保留的答')
    log.system('B2', null, 'compact_boundary', {
      logicalParentUuid: 'pa1',
      compactMetadata: {
        trigger: 'auto',
        preTokens: 2,
        preservedSegment: { headUuid: 'p1', anchorUuid: 'S2', tailUuid: 'pa1' },
      },
    })
    log.user('S2', 'B2', '摘要二', { isCompactSummary: true })
    turns(log, 1, 3, 'S2', 'c')
    log.save()

    const first = (await readClaudeSession(projects, cwd, id(1), { turns: 2 }))!
    // 最近两轮；还在第三段里，没有碰到边界
    expect(users(first.items).map(u => u.text)).toEqual(['问题 2', '问题 3'])
    expect(first.compacted).toBe(false)
    expect(first.turns).toBe(4 + 4 + 1 + 3)
    expect(first.summary).toBe('摘要二')

    // 再往前 2 轮：第三段的第一轮 + 边界之后的保留段第一轮…… 窗口 = [保留段 p1, 问题 1]：包含 compaction b2
    const second = (await readClaudeSession(projects, cwd, id(1), { turns: 2, before: first.earliestShownUuid! }))!
    expect(second.items.map(i => i.kind)).toEqual(['compaction', 'user', 'assistant', 'user', 'assistant'])
    expect(users(second.items).map(u => u.text)).toEqual(['保留的话', '问题 1'])
    expect(second.items.filter(i => i.kind === 'compaction')).toHaveLength(1)
    expect(second.compacted).toBe(false)
    expect(second.hasEarlier).toBe(true)

    // 再往前：越过 b2（它在第二批里，已经显示）→ 这一批在 b2 之前：第二段的 b3 b4 和 b1 的边界
    const third = (await readClaudeSession(projects, cwd, id(1), { turns: 2, before: second.earliestShownUuid! }))!
    expect(users(third.items).map(u => u.text)).toEqual(['问题 3', '问题 4'])
    expect(third.compacted).toBe(true)
    const fourth = (await readClaudeSession(projects, cwd, id(1), { turns: 2, before: third.earliestShownUuid! }))!
    expect(users(fourth.items).map(u => u.text)).toEqual(['问题 1', '问题 2'])
    // 这一批的起点在 b1 之后，开头带着 b1 的 compaction 条目
    expect(fourth.items[0].kind).toBe('compaction')
    const last = (await readClaudeSession(projects, cwd, id(1), { turns: 50, before: fourth.earliestShownUuid! }))!
    expect(users(last.items).map(u => u.text)).toEqual(['问题 1', '问题 2', '问题 3', '问题 4'])
    expect(last.hasEarlier).toBe(false)
    expect(last.compacted).toBe(true)
    // 所有批次拼起来：每个用户轮只出现一次（保留段没有重复）
    const all = [first, second, third, fourth, last].flatMap(r => users(r.items).map(u => u.id))
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('补上终端里新聊的轮次', () => {
  it('追加一轮后 newerTurns 返回 1（接力行也算）；再补一次返回 0', async () => {
    const log = new Log(id(1))
    turns(log, 1, 3, null)
    log.save()
    const base = (await readClaudeSession(projects, cwd, id(1)))!
    const known = base.at!
    expect((await newerTurns(projects, cwd, id(1), known))!).toMatchObject({ turns: 0, shown: 0, gap: 0, items: [] })
    // 终端里又聊了一轮（有 version、origin human）
    log.rows = []
    log
      .user('t1', known, '终端里新问的', { origin: { kind: 'human' } })
      .assistant('ta1', 't1', '终端里的回答')
      .append()
    let next = (await newerTurns(projects, cwd, id(1), known))!
    expect(next.turns).toBe(1)
    expect(next.items.map(i => i.kind)).toEqual(['user', 'assistant'])
    expect(next.items[0]).toMatchObject({ id: 't1', text: '终端里新问的', engine: 'claude' })
    expect(next.at).toBe('ta1')
    // 再追加接力行
    await seedTranscript(
      projects,
      cwd,
      id(1),
      [{ id: '77777777-2222-4333-8444-555555555555', user: '别的引擎', assistant: '答' }],
      NO_REPLY,
    )
    next = (await newerTurns(projects, cwd, id(1), known))!
    expect(next.turns).toBe(2)
    expect(next.items.map(i => i.kind)).toEqual(['user', 'assistant', 'notice', 'user', 'assistant'])
    // 补到最新之后没有新的了
    expect((await newerTurns(projects, cwd, id(1), next.at!))!).toMatchObject({ turns: 0, items: [] })
    // 不在当前分支上的 uuid
    expect(await newerTurns(projects, cwd, id(1), 'nope')).toBeNull()
  })

  it('超过 50 轮只给最近 50 轮，最前面放一条「中间还有 M 轮没有显示」', async () => {
    const log = new Log(id(1))
    const known = turns(log, 1, 2, null)
    log.save()
    log.rows = []
    turns(log, 100, 65, known, 'n')
    log.append()
    const r = (await newerTurns(projects, cwd, id(1), known!))!
    expect(r.turns).toBe(65)
    expect(r.shown).toBe(50)
    expect(r.gap).toBe(15)
    expect(r.items[0]).toMatchObject({ kind: 'notice', text: NATIVE_TEXT.gap(15) })
    expect(users(r.items)[0].text).toBe('问题 115')
    expect(users(r.items).at(-1)!.text).toBe('问题 164')
  })
})
