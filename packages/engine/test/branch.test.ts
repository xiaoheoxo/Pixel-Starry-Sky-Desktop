// 回退恢复代码 / 撤销、分叉、旁聊（docs/ui/rewind-fork-sidechat.md），用假 Claude（模拟记录链和 rewind_files）
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineId, EngineInfo, HostEvent } from '@pixelsky/protocol'
import { ClaudeAdapter, EngineHost } from '../src'
import type { EngineAdapter, EngineSession, SessionContext } from '../src/adapter'
import { ENGINES } from '../src/registry'
import { helpersExited, parseRewindReply, parseSideAnswer, sideQuestionArgs } from '../src/claude/helper'
import { claudeArgs } from '../src/claude/session'
import { sidePrompt } from '../src/host/branch'

const FAKE = fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url))

let root: string
let events: HostEvent[]
let hosts: EngineHost[]

function makeHost(
  extraEnv: NodeJS.ProcessEnv = {},
  extraAdapters: Partial<Record<EngineId, EngineAdapter>> = {},
): EngineHost {
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
      ...extraEnv,
    },
  })
  const host = new EngineHost({
    dataDir: join(root, 'data'),
    emit: e => events.push(e),
    idleMs: 60_000,
    adapters: { claude: adapter, ...extraAdapters },
  })
  hosts.push(host)
  return host
}

class StubCodex implements EngineAdapter {
  readonly enginePicksSessionId = true
  async info(): Promise<EngineInfo> {
    return { ...ENGINES.codex, status: 'ready', version: 'stub', path: 'stub', message: null }
  }
  createSession(ctx: SessionContext): EngineSession {
    let n = 0
    return {
      send(text, turnId) {
        if (!ctx.record().engineSessionId) ctx.setEngineSessionId('codex-thread')
        setTimeout(() => {
          ctx.emit({
            type: 'item_completed',
            item: { kind: 'assistant', id: `cx-${++n}`, text: `codex:${text}`, status: 'completed' },
          })
          ctx.emit({ type: 'turn_completed', turnId, outcome: 'completed', error: null })
        }, 0)
      },
      async interrupt() {},
      answer() {},
      async update() {},
      async close() {},
    }
  }
}

const spawnArgs = (): string[][] =>
  readFileSync(join(root, 'argv.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as string[])
const visible = (): string[][] =>
  readFileSync(join(root, 'chain.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as string[])
const turnsDone = (id: string): number =>
  events.filter(e => e.kind === 'session' && e.sessionId === id && e.event.type === 'turn_completed').length
const userTexts = (host: EngineHost, id: string): string[] =>
  host.open(id).items.flatMap(i => (i.kind === 'user' ? [i.text] : []))

async function waitFor<T>(pick: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = pick()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, 20))
  }
}

async function conversation(host: EngineHost, texts: string[]) {
  const project = host.addProject(mkdtempSync(join(root, 'proj-')))
  const record = host.createSession({ projectId: project.id, permissionMode: 'ask', effort: 'high' })
  for (const [i, text] of texts.entries()) {
    await host.send(record.id, { text, clientMessageId: `m${i}` })
    await waitFor(() => turnsDone(record.id) === i + 1)
  }
  return { record, cwd: project.path }
}

/** 在记录末尾加一条压缩分界，之前的条目 Claude Code 就加载不到了；返回记录文件 */
function compact(cwd: string, sid: string): string {
  const file = join(root, 'claude-projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sid}.jsonl`)
  appendFileSync(
    file,
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'b1', parentUuid: null }) + '\n',
  )
  return file
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pixelsky-branch-'))
  events = []
  hosts = []
})

afterEach(async () => {
  await Promise.all(hosts.map(h => h.shutdown()))
  await helpersExited()
  rmSync(root, { recursive: true, force: true })
})

describe('辅助进程的参数和回复', () => {
  it('rewind_files 回复：文件列表、没有检查点、其他失败', () => {
    expect(parseRewindReply({ canRewind: true, filesChanged: ['/a', 3], insertions: 2, deletions: 1 })).toEqual({
      ok: true,
      files: ['/a'],
      insertions: 2,
      deletions: 1,
    })
    expect(parseRewindReply({ canRewind: false, error: 'No file checkpoint found for this message.' })).toMatchObject({
      ok: false,
      reason: 'no-checkpoint',
    })
    expect(parseRewindReply({ canRewind: false, error: 'disk full' })).toMatchObject({ ok: false, reason: 'failed' })
  })

  it('旁聊：不保存、没有工具、带模型；结果 JSON，is_error 当错误', () => {
    expect(sideQuestionArgs(['--resume', 's'], 'opus')).toEqual([
      '-p',
      '--output-format',
      'json',
      '--resume',
      's',
      '--fork-session',
      '--no-session-persistence',
      '--tools',
      '',
      '--model',
      'opus',
    ])
    expect(parseSideAnswer('noise\n{"type":"result","result":"好","is_error":false}\n')).toBe('好')
    expect(() => parseSideAnswer('{"result":"额度用完","is_error":true}')).toThrow('额度用完')
    expect(sidePrompt('再问', [{ question: '先问', answer: '先答' }])).toMatch(/问：先问\n答：先答\n\n问：再问$/)
  })

  it('分叉的启动参数：从原会话的截断点复制，用新 id 保存', () => {
    const settings = {
      model: null,
      effort: null,
      permissionMode: 'ask' as const,
      ultracode: false,
      fast: false,
      thinkingSummaries: true,
    }
    const args = claudeArgs(settings, 'new', false, undefined, null, { from: 'old', at: 'u1' })
    expect(args.slice(-6)).toEqual([
      '--resume',
      'old',
      '--fork-session',
      '--session-id',
      'new',
      '--resume-session-at=u1',
    ])
  })
})

describe('回退：对话 / 代码 / 两者，撤销', () => {
  it('预览列出要还原的文件；两者都恢复后文件和对话都回去，撤销后都回来', async () => {
    const file = join(root, 'a.txt')
    const host = makeHost({ FAKE_CLAUDE_REWIND: JSON.stringify({ file, content: 'old' }) })
    const { record } = await conversation(host, ['一', '二', '三'])
    writeFileSync(file, 'new')
    const preview = await host.rewindPreview(record.id, 'm1')
    expect(preview.code).toEqual({ ok: true, files: [file], insertions: 1, deletions: 2, undoable: true })

    const result = await host.rewind(record.id, 'm1', { conversation: true, code: true })
    expect(result).toEqual({ text: '二', filesRestored: 1, undoable: true })
    expect(readFileSync(file, 'utf8')).toBe('old')
    expect(userTexts(host, record.id)).toEqual(['一'])
    expect(host.open(record.id).record.pendingRewind).toBeTruthy()
    // 列表里的「最后一句回复」退回到保留的最后一轮
    expect(host.open(record.id).record.lastReply).toBe('收到：一')

    await host.undoRewind(record.id)
    expect(readFileSync(file, 'utf8')).toBe('new')
    expect(userTexts(host, record.id)).toEqual(['一', '二', '三'])
    expect(host.open(record.id).record.pendingRewind).toBeNull()
    expect(host.open(record.id).record.lastReply).toBe('收到：三')
    // 撤销后接着聊，上下文是完整的
    await host.send(record.id, { text: '四', clientMessageId: 'm3' })
    await waitFor(() => turnsDone(record.id) === 4)
    expect(visible().at(-1)).toEqual(['一', '二', '三'])
    await expect(host.undoRewind(record.id)).rejects.toThrow('不能撤销')
  })

  it('辅助进程不加载 hook / 插件 / MCP；还原只起一个进程；拿到回复就返回，不等进程退出（GitHub #35）', async () => {
    const file = join(root, 'c.txt')
    const host = makeHost({
      FAKE_CLAUDE_REWIND: JSON.stringify({ file, content: 'old' }),
      FAKE_CLAUDE_HELPER_LINGER: '1',
    })
    const { record } = await conversation(host, ['一', '二'])
    writeFileSync(file, 'new')
    const helpers = (): string[][] => spawnArgs().filter(a => a.includes('--bare'))
    const started = Date.now()
    await expect(host.rewindPreview(record.id, 'm1')).resolves.toMatchObject({ code: { ok: true, files: [file] } })
    // 辅助进程关了 stdin 也不退（3 秒后才被强制结束），预览不等它
    expect(Date.now() - started).toBeLessThan(2_500)
    expect(helpers()).toHaveLength(1)
    expect(helpers()[0]).toEqual(expect.arrayContaining(['--strict-mcp-config', '--resume']))
    const result = await host.rewind(record.id, 'm1', { conversation: false, code: true })
    expect(result).toMatchObject({ filesRestored: 1, undoable: true })
    expect(readFileSync(file, 'utf8')).toBe('old')
    expect(helpers()).toHaveLength(2)
    await host.undoRewind(record.id)
    expect(readFileSync(file, 'utf8')).toBe('new')
  }, 20_000)

  it('只恢复代码：对话不动；还原时文件不存在，撤销时删掉', async () => {
    const file = join(root, 'b.txt')
    const host = makeHost({ FAKE_CLAUDE_REWIND: JSON.stringify({ file, content: 'restored' }) })
    const { record } = await conversation(host, ['一', '二'])
    const result = await host.rewind(record.id, 'm1', { conversation: false, code: true })
    expect(result).toEqual({ text: '', filesRestored: 1, undoable: true })
    expect(userTexts(host, record.id)).toEqual(['一', '二'])
    expect(readFileSync(file, 'utf8')).toBe('restored')
    await host.undoRewind(record.id)
    expect(existsSync(file)).toBe(false)
  })

  it('没有检查点：预览说明原因；只恢复代码时报错且什么都不改，同时回退对话时对话照样回退（GitHub #82）', async () => {
    const host = makeHost()
    const { record } = await conversation(host, ['一', '二'])
    await expect(host.rewindPreview(record.id, 'm1')).resolves.toMatchObject({
      code: { ok: false, reason: 'no-checkpoint' },
    })
    await expect(host.rewind(record.id, 'm1', { conversation: false, code: true })).rejects.toThrow('检查点')
    expect(userTexts(host, record.id)).toEqual(['一', '二'])
    const result = await host.rewind(record.id, 'm1', { conversation: true, code: true })
    expect(result).toMatchObject({ text: '二', undoable: true, codeSkipped: expect.stringContaining('检查点') })
    expect(result.filesRestored).toBeUndefined()
    expect(userTexts(host, record.id)).toEqual(['一'])
    await host.undoRewind(record.id)
    expect(userTexts(host, record.id)).toEqual(['一', '二'])
  })

  it('辅助进程按当前分支读：记录的 last-prompt 指向当前末端；回退了还没发时截到回退点（GitHub #82）', async () => {
    const file = join(root, 'd.txt')
    const host = makeHost({ FAKE_CLAUDE_REWIND: JSON.stringify({ file, content: 'old' }) })
    const { record, cwd } = await conversation(host, ['一', '二', '三'])
    const sid = host.open(record.id).record.engineSessionId!
    const transcript = join(root, 'claude-projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sid}.jsonl`)
    const entries = (): { type?: string; uuid?: string; leafUuid?: string; lastPrompt?: string }[] =>
      readFileSync(transcript, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
    const leaf = (): string => entries().findLast(e => e.type === 'user' || e.type === 'assistant')!.uuid!
    const lastPrompts = () => entries().filter(e => e.type === 'last-prompt')
    const atArg = (): string | undefined =>
      spawnArgs()
        .filter(a => a.includes('--bare'))
        .at(-1)
        ?.find(a => a.startsWith('--resume-session-at='))

    await host.rewindPreview(record.id, 'm2')
    expect(atArg()).toBeUndefined()
    expect(lastPrompts().at(-1)).toMatchObject({ leafUuid: leaf(), sessionId: sid })
    // 已经指着当前末端：不重复写
    await host.rewindPreview(record.id, 'm1')
    expect(lastPrompts()).toHaveLength(1)

    // 回退了还没发：截到回退点，不动 last-prompt（回退时会话进程退出，自己记了一条旧分支的末端）
    await host.rewind(record.id, 'm1')
    const pending = host.open(record.id).record.pendingRewind!
    const written = lastPrompts().length
    await host.rewindPreview(record.id, 'm0')
    expect(atArg()).toBe(`--resume-session-at=${pending}`)
    expect(lastPrompts()).toHaveLength(written)

    // 接着聊（会话进程还开着）：新分支写在旧分支后面，last-prompt 改指新分支的末端
    await host.send(record.id, { text: '六', clientMessageId: 'm6' })
    await waitFor(() => turnsDone(record.id) === 4)
    await host.rewindPreview(record.id, 'm6')
    expect(atArg()).toBeUndefined()
    expect(lastPrompts().at(-1)?.leafUuid).toBe(leaf())
    expect(lastPrompts()).toHaveLength(written + 1)
  })

  it('这条消息在上下文压缩之前：预览写明是压缩的缘故，同时回退对话时对话照样回退（GitHub #82）', async () => {
    const host = makeHost()
    const { record, cwd } = await conversation(host, ['一', '二'])
    const file = compact(cwd, host.open(record.id).record.engineSessionId!)
    // 压缩之后 Claude Code 会接着写一条摘要
    appendFileSync(file, JSON.stringify({ type: 'user', uuid: 's1', parentUuid: 'b1', isCompactSummary: true }) + '\n')
    await expect(host.rewindPreview(record.id, 'm0')).resolves.toMatchObject({
      code: { ok: false, reason: 'compacted' },
    })
    const result = await host.rewind(record.id, 'm1', { conversation: true, code: true })
    expect(result.codeSkipped).toContain('上下文压缩之前')
    expect(userTexts(host, record.id)).toEqual(['一'])
  })

  it('截断点在上下文压缩之前：复制记录到截断点，换新的引擎会话接上，原记录不动（§2.4）', async () => {
    const host = makeHost()
    const { record, cwd } = await conversation(host, ['一', '二', '三'])
    const sid = host.open(record.id).record.engineSessionId!
    const source = compact(cwd, sid)
    const before = readFileSync(source, 'utf8')
    await host.rewind(record.id, 'm1')
    await host.send(record.id, { text: '改', clientMessageId: 'x' })
    await waitFor(() => turnsDone(record.id) === 4)
    expect(visible().at(-1)).toEqual(['一'])
    const after = host.open(record.id)
    expect(after.record.engineSessionId).not.toBe(sid)
    expect(after.record.pendingRewind).toBeNull()
    expect(after.items.some(i => i.kind === 'notice')).toBe(false)
    // 原记录的消息一条不动（会话进程退出时 Claude Code 自己会在末尾记一条 last-prompt）
    const messages = (text: string): string[] => text.split('\n').filter(l => l && !l.includes('"last-prompt"'))
    expect(messages(readFileSync(source, 'utf8'))).toEqual(messages(before))
  })

  it('回退后发了新消息就不能撤销', async () => {
    const host = makeHost()
    const { record } = await conversation(host, ['一', '二'])
    await host.rewind(record.id, 'm1')
    await host.send(record.id, { text: '改', clientMessageId: 'x' })
    await waitFor(() => turnsDone(record.id) === 3)
    await expect(host.undoRewind(record.id)).rejects.toThrow('不能撤销')
    expect(userTexts(host, record.id)).toEqual(['一', '改'])
  })
})

describe('分叉', () => {
  it('新会话带上这条消息之前的对话，引擎从截断点复制，原会话不变', async () => {
    const host = makeHost()
    const { record } = await conversation(host, ['一', '二', '三'])
    const forked = await host.forkSession(record.id, 'm2')
    expect(forked.text).toBe('三')
    const title = host.open(record.id).record.title
    expect(forked.record).toMatchObject({ title: `${title}（分支）`, forkedFrom: { sessionId: record.id, title } })
    expect(forked.record.pendingFork?.from).toBe(host.open(record.id).record.engineSessionId)
    expect(userTexts(host, forked.record.id)).toEqual(['一', '二'])
    expect(userTexts(host, record.id)).toEqual(['一', '二', '三'])
    // 预览用截断点之前最后一轮的回复，不沿用原会话的
    expect(forked.record.lastReply).toBe('收到：二')
    expect(host.open(record.id).record.lastReply).toBe('收到：三')

    await host.send(forked.record.id, { text: '另一条路', clientMessageId: 'f1' })
    await waitFor(() => turnsDone(forked.record.id) === 1)
    const args = spawnArgs().at(-1)!
    expect(args).toContain('--fork-session')
    expect(args).toContain('--session-id')
    expect(visible().at(-1)).toEqual(['一', '二'])
    expect(host.open(forked.record.id).record.pendingFork).toBeNull()
    expect(userTexts(host, forked.record.id)).toEqual(['一', '二', '另一条路'])
  })

  it('截断点在上下文压缩之前：自己复制记录到截断点，用 --resume 接上（§2.4）', async () => {
    const host = makeHost()
    const { record, cwd } = await conversation(host, ['一', '二', '三'])
    const source = compact(cwd, host.open(record.id).record.engineSessionId!)
    const before = readFileSync(source, 'utf8')
    const forked = await host.forkSession(record.id, 'm2')
    await host.send(forked.record.id, { text: '另一条路', clientMessageId: 'f1' })
    await waitFor(() => turnsDone(forked.record.id) === 1)
    const args = spawnArgs().at(-1)!
    expect(args).not.toContain('--fork-session')
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual([
      '--resume',
      forked.record.engineSessionId,
    ])
    expect(visible().at(-1)).toEqual(['一', '二'])
    expect(host.open(forked.record.id).record.pendingFork).toBeNull()
    expect(host.open(forked.record.id).items.some(i => i.kind === 'notice')).toBe(false)
    expect(readFileSync(source, 'utf8')).toBe(before)
  })

  it('分叉第一条消息：空的新会话，不带截断点', async () => {
    const host = makeHost()
    const { record } = await conversation(host, ['一'])
    const forked = await host.forkSession(record.id, 'm0')
    expect(host.open(forked.record.id).items).toEqual([])
    expect(forked.record.pendingFork).toBeNull()
    expect(forked.record.lastReply).toBeNull()
  })
})

describe('旁聊', () => {
  it('带着主对话的上下文，没有工具，不写记录、不进主对话', async () => {
    const host = makeHost()
    const { record } = await conversation(host, ['一', '二'])
    const before = host.open(record.id).items.length
    const answer = await host.sideQuestion(record.id, '这是什么', [{ question: '前一问', answer: '前一答' }])
    expect(answer).toBe('问：这是什么｜工具=[]｜看到=一,二')
    expect(host.open(record.id).items).toHaveLength(before)
    const args = spawnArgs().at(-1)!
    expect(args).toEqual(expect.arrayContaining(['--fork-session', '--no-session-persistence', '--tools', '']))
  })

  it('回退后接着聊、会话进程还开着时，看到的是新分支（GitHub #82）', async () => {
    const host = makeHost()
    const { record } = await conversation(host, ['一', '二', '三'])
    await host.rewind(record.id, 'm1')
    await host.send(record.id, { text: '六', clientMessageId: 'm6' })
    await waitFor(() => turnsDone(record.id) === 4)
    const answer = await host.sideQuestion(record.id, '现在呢', [])
    expect(answer).toBe('问：现在呢｜工具=[]｜看到=一,六')
  })

  it('还没发过消息时不能用', async () => {
    const host = makeHost()
    const project = host.addProject(mkdtempSync(join(root, 'proj-')))
    const record = host.createSession({ projectId: project.id, permissionMode: 'ask' })
    await expect(host.sideQuestion(record.id, '问', [])).rejects.toThrow('先在主对话里发一条消息')
  })
})

describe('跨引擎接力带图片到 Claude', () => {
  const png = (name: string) => ({
    id: name.replace(/\W/g, '-'),
    name,
    mediaType: 'image/png' as const,
    bytes: 16,
    width: 1,
    height: 1,
    dataBase64: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(8)]).toString('base64'),
  })
  const sent = (): { types: string[]; text: string; images: unknown[] }[] =>
    readFileSync(join(root, 'images.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))

  it('写进记录的用户消息带图片块：Claude 恢复时看得到，回退截断点照样找得到', async () => {
    const host = makeHost({ FAKE_CLAUDE_IMAGES: join(root, 'images.jsonl') }, { codex: new StubCodex() })
    const { record, cwd } = await conversation(host, ['一'])
    await host.update(record.id, { engine: 'codex' })
    const b = '11111111-2222-4333-8444-555555555555'
    await host.send(record.id, { text: '看这张图', clientMessageId: b, attachments: [png('a.png')] })
    await waitFor(() => turnsDone(record.id) === 2)
    await host.update(record.id, { engine: 'claude' })
    await host.send(record.id, { text: '三', clientMessageId: 'c' })
    await waitFor(() => turnsDone(record.id) === 3)
    const sid = host.open(record.id).record.engineSessionId!
    const file = join(root, 'claude-projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sid}.jsonl`)
    const entry = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))
      .find(e => e.uuid === b)
    expect(entry.message.content).toEqual([
      { type: 'text', text: '看这张图（附：a.png）' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png('a.png').dataBase64 } },
    ])
    // 注入成功：当前这条消息不带交接材料和图片
    expect(sent().at(-1)).toMatchObject({ types: ['string'], text: '三', images: [] })
    // 回退到这条消息之前：截断点是它前一条
    await host.rewind(record.id, b)
    expect(host.open(record.id).record.pendingRewind).toBe(entry.parentUuid)
    expect(userTexts(host, record.id)).toEqual(['一'])
  })

  it('没能写进记录（有待执行的回退）：退回文字交接，更早消息的图片排在当前消息图片前面一起发', async () => {
    const host = makeHost({ FAKE_CLAUDE_IMAGES: join(root, 'images.jsonl') }, { codex: new StubCodex() })
    const { record } = await conversation(host, ['一', '二'])
    await host.rewind(record.id, 'm1')
    await host.update(record.id, { engine: 'codex' })
    await host.send(record.id, { text: '三', clientMessageId: 'b', attachments: [png('old.png')] })
    await waitFor(() => turnsDone(record.id) === 3)
    await host.update(record.id, { engine: 'claude' })
    await host.send(record.id, { text: '四', clientMessageId: 'c', attachments: [png('new.png')] })
    await waitFor(() => turnsDone(record.id) === 4)
    const last = sent().at(-1)!
    expect(last.types).toEqual(['text', 'image', 'image'])
    expect(last.images).toHaveLength(2)
    expect(last.text).toContain('下面第 1 张图是之前「三」那条消息附的 old.png')
    expect(last.text.endsWith('\n\n四')).toBe(true)
  })
})
