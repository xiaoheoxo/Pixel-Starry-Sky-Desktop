// oh-my-pi 的回退和分叉（docs/omp-engine.md §12.6）
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EngineHost } from '../src'
import { OmpAdapter } from '../src/omp'
import { ompAnchor, ompForkFile } from '../src/omp/branch'
import { ompCwd, ompReadNative, ompSessionFile } from '../src/omp/native'
import { makeTmp, removeTmp } from './helpers/tmp'

const FAKE = fileURLToPath(new URL('./fakes/fake-omp.mjs', import.meta.url))
let root: string, host: EngineHost | undefined
beforeEach(() => {
  root = makeTmp('omp-branch')
})
afterEach(async () => {
  await host?.shutdown()
  host = undefined
  removeTmp(root)
})
const wait = async (fn: () => boolean): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if (fn()) return
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error('omp branch test timed out')
}

function setup(extraEnv: Record<string, string> = {}) {
  const log = join(root, 'rpc.jsonl')
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (/^(ANTHROPIC|OPENAI|PIXELSKY_PIXEL)_/i.test(key)) delete env[key]
  const adapter = new OmpAdapter({
    launcher: { command: process.execPath, args: [FAKE] },
    env: { ...env, FAKE_OMP_LOG: log, FAKE_OMP_DIR: join(root, 'sessions'), ...extraEnv },
    dataDir: join(root, 'engine'),
  })
  const h = (host = new EngineHost({
    dataDir: join(root, 'engine'),
    adapters: { omp: adapter },
    emit: () => {},
    idleMs: 10_000,
  }))
  const record = h.createSession({
    projectId: h.addProject(root).id,
    engine: 'omp',
    model: 'fake/fake-omp',
    permissionMode: 'ask',
  })
  const send = async (text: string, id = record.id): Promise<void> => {
    await h.send(id, text)
    await wait(() => h.open(id).state === 'idle')
  }
  const rows = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l))
  return {
    h,
    adapter,
    id: record.id,
    send,
    /** 每轮发出去时 omp 上下文里的用户消息（去掉交接材料，只看最后一行） */
    contexts: () => rows().flatMap(m => (m.type === 'context' ? [m.users as string[]] : [])),
    rows,
    user: (text: string, id = record.id) => h.open(id).items.find(i => i.kind === 'user' && i.text === text)!.id,
    notices: (id = record.id) => h.open(id).items.flatMap(i => (i.kind === 'notice' ? [i.text] : [])),
  }
}

describe('oh-my-pi 回退', () => {
  it('回退后接着聊：在同一个文件里从截断点接，重启进程也不带回退掉的', async () => {
    const t = setup()
    for (const text of ['一', '二', '三']) await t.send(text)
    const file = t.h.open(t.id).record.engineSessionId!
    expect(await t.h.rewind(t.id, t.user('二'))).toMatchObject({ text: '二', undoable: true })
    expect(t.h.open(t.id).record.pendingRewind).toBeTruthy()
    await t.send('四')
    expect(t.contexts().at(-1)).toEqual(['一', '四'])
    expect(t.h.open(t.id).record).toMatchObject({ engineSessionId: file, pendingRewind: null })
    // 换了权限档会换进程：重新打开从最后一条接着
    await t.h.update(t.id, { permissionMode: 'edits' })
    await t.send('五')
    expect(t.contexts().at(-1)).toEqual(['一', '四', '五'])
    // 再往前退一次
    await t.h.rewind(t.id, t.user('四'))
    await t.send('六')
    expect(t.contexts().at(-1)).toEqual(['一', '六'])
    expect(t.notices()).toEqual([])
  })
  it('还没发新消息能撤销；连退两次从前一次的截断点算', async () => {
    const t = setup()
    for (const text of ['一', '二', '三']) await t.send(text)
    await t.h.rewind(t.id, t.user('二'))
    await t.h.undoRewind(t.id)
    expect(t.h.open(t.id).record.pendingRewind).toBeNull()
    await t.send('四')
    expect(t.contexts().at(-1)).toEqual(['一', '二', '三', '四'])
    await t.h.rewind(t.id, t.user('四'))
    await t.h.rewind(t.id, t.user('三'))
    await t.send('五')
    expect(t.contexts().at(-1)).toEqual(['一', '二', '五'])
  })
  it('退到第一条：开新会话，不留旧的上下文', async () => {
    const t = setup()
    await t.send('一')
    const file = t.h.open(t.id).record.engineSessionId
    await t.h.rewind(t.id, t.user('一'))
    expect(t.h.open(t.id).record.engineSessionId).toBeNull()
    await t.send('二')
    expect(t.contexts().at(-1)).toEqual(['二'])
    expect(t.h.open(t.id).record.engineSessionId).not.toBe(file)
  })
  it('回退后旁聊：先移到截断点再问', async () => {
    const t = setup()
    for (const text of ['一', '二']) await t.send(text)
    await t.h.rewind(t.id, t.user('二'))
    const at = t.h.open(t.id).record.pendingRewind
    await t.adapter.sideQuestion(t.h.open(t.id).record, '问', new AbortController().signal)
    const types = t.rows().map(m => (m.type === 'navigate_tree' ? `nav ${m.entryId}` : m.type))
    expect(types.slice(types.indexOf(`nav ${at}`))).toContain('btw')
    expect(t.h.open(t.id).record.pendingRewind).toBe(at)
  })
  it('切终端前落实：不发消息，树上留一条记号', async () => {
    const t = setup()
    for (const text of ['一', '二']) await t.send(text)
    await t.h.rewind(t.id, t.user('二'))
    const at = t.h.open(t.id).record.pendingRewind
    await t.h.prepareTui(t.id)
    const record = t.h.open(t.id).record
    expect(record.pendingRewind).toBeNull()
    const last = readFileSync(record.engineSessionId!, 'utf8').trim().split('\n').at(-1)!
    expect(JSON.parse(last)).toMatchObject({ type: 'custom', parentId: at })
    expect(t.contexts()).toHaveLength(2)
  })
  it('没有轮次标记（用户的参数关掉了扩展）：不带着回退掉的继续，开新会话带交接', async () => {
    const t = setup({ FAKE_OMP_NO_TURN: '1' })
    for (const text of ['一', '二']) await t.send(text)
    await t.h.rewind(t.id, t.user('二'))
    expect(t.h.open(t.id).record).toMatchObject({ engineSessionId: null, pendingRewind: null })
    await t.send('三')
    const [first] = t.contexts().at(-1)!
    expect(t.contexts().at(-1)).toHaveLength(1)
    expect(first).toContain('一')
    expect(first).not.toContain('二')
    expect(t.notices()).toHaveLength(1)
  })
  it('启动时移不过去：换新会话、带上保留的聊天，不清掉就继续', async () => {
    const t = setup()
    for (const text of ['一', '二']) await t.send(text)
    await t.h.rewind(t.id, t.user('二'))
    // 期间会话文件被改过：截断点没了
    const file = t.h.open(t.id).record.engineSessionId!
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('pixelsky.turn', 'x').replaceAll('"id":"', '"id":"z'))
    await t.send('三')
    const users = t.contexts().at(-1)!
    expect(users).toHaveLength(1)
    expect(users[0]).toContain('一')
    expect(users[0]).not.toContain('二')
    expect(t.h.open(t.id).record.pendingRewind).toBeNull()
    expect(t.h.open(t.id).record.engineSessionId).not.toBe(file)
  })
})

describe('oh-my-pi 分叉', () => {
  it('从某条消息分叉：新文件、新会话 id，只带之前的；原会话照旧；分出来的还能回退、再分叉', async () => {
    const t = setup()
    for (const text of ['一', '二', '三']) await t.send(text)
    const file = t.h.open(t.id).record.engineSessionId!
    const { record } = await t.h.forkSession(t.id, t.user('三'))
    expect(record.pendingFork).toMatchObject({ from: file })
    await t.send('四', record.id)
    expect(t.contexts().at(-1)).toEqual(['一', '二', '四'])
    const copy = t.h.open(record.id).record.engineSessionId!
    expect(copy).not.toBe(file)
    expect(t.h.open(record.id).record.pendingFork).toBeNull()
    const head = (f: string) => JSON.parse(readFileSync(f, 'utf8').split('\n')[1])
    expect(head(copy)).toMatchObject({ parentSession: head(file).id, cwd: t.h.open(record.id).record.cwd })
    expect(head(copy).id).not.toBe(head(file).id)
    await t.send('五')
    expect(t.contexts().at(-1)).toEqual(['一', '二', '三', '五'])
    await t.h.rewind(record.id, t.user('二', record.id))
    await t.send('六', record.id)
    expect(t.contexts().at(-1)).toEqual(['一', '六'])
    expect(t.notices(record.id)).toEqual([])
  })
  it('还没启动的分叉：再分叉、回退都从来源的截断点算', async () => {
    const t = setup()
    for (const text of ['一', '二', '三']) await t.send(text)
    const first = (await t.h.forkSession(t.id, t.user('三'))).record
    const second = (await t.h.forkSession(first.id, t.user('二', first.id))).record
    await t.send('四', second.id)
    expect(t.contexts().at(-1)).toEqual(['一', '四'])
    await t.h.rewind(first.id, t.user('二', first.id))
    await t.send('五', first.id)
    expect(t.contexts().at(-1)).toEqual(['一', '五'])
  })
  it('来源回退了还没发消息：带上整个会话分叉，只带到回退点', async () => {
    const t = setup()
    for (const text of ['一', '二']) await t.send(text)
    await t.h.rewind(t.id, t.user('二'))
    const { record } = await t.h.forkSession(t.id, null)
    await t.send('三', record.id)
    expect(t.contexts().at(-1)).toEqual(['一', '三'])
  })
  it('启动失败：复制出来的文件删掉，下次再分叉', async () => {
    const t = setup()
    for (const text of ['一', '二']) await t.send(text)
    const { record } = await t.h.forkSession(t.id, t.user('二'))
    const count = () => readdirSync(join(root, 'sessions')).length
    const before = count()
    await t.h.update(record.id, { model: 'fake/none' })
    await t.send('三', record.id)
    expect(t.h.open(record.id).record.lastOutcome).toBe('failed')
    expect(count()).toBe(before)
    expect(t.h.open(record.id).record.pendingFork).toBeTruthy()
    await t.h.update(record.id, { model: 'fake/fake-omp' })
    t.h.resumeQueue(record.id)
    await t.send('四', record.id)
    expect(t.contexts().at(-1)!.slice(0, 1)).toEqual(['一'])
    expect(t.contexts().at(-1)).not.toContain('二')
  })
  it('来源文件没了：开新会话带交接', async () => {
    const t = setup()
    for (const text of ['一', '二']) await t.send(text)
    const { record } = await t.h.forkSession(t.id, t.user('二'))
    await t.h.shutdown()
    rmSync(record.pendingFork!.from)
    const again = setup()
    await again.send('三', record.id)
    const users = again.contexts().at(-1)!
    expect(users).toHaveLength(1)
    expect(users[0]).toContain('一')
    expect(again.h.open(record.id).record.pendingFork).toBeNull()
  })
})

describe('接着以前的 omp 会话', () => {
  /** 用假 omp 聊几轮，像用户在终端里留下的；返回会话文件和 id */
  async function leftover(cwd = root) {
    const t = setup()
    for (const text of ['一', '二', '三']) await t.send(text)
    const file = t.h.open(t.id).record.engineSessionId!
    await t.h.shutdown()
    rmSync(join(root, 'engine'), { recursive: true, force: true })
    // 假 omp 的会话目录是 <root>/sessions；真的是 <会话目录>/<编码过的工作目录>/，照这个放，换成唯一的会话 id
    const id = '01a2070e-7df1-70f9-9687-f0bd83d92fb1'
    const moved = join(root, 'sessions', `2026-11-23T00-00-00-000Z_${id}.jsonl`)
    const lines = readFileSync(file, 'utf8').split('\n')
    const head = { ...JSON.parse(lines[1]), id, cwd }
    writeFileSync(
      moved,
      [JSON.stringify({ type: 'title', title: '起的标题' }), JSON.stringify(head), ...lines.slice(2)].join('\n'),
    )
    rmSync(file)
    return { file: moved, id }
  }
  const project = (t: ReturnType<typeof setup>) => t.h.open(t.id).record.projectId

  it('列出、原地导入、接着聊：写回同一个文件；占用了不重复导入', async () => {
    const { file, id } = await leftover()
    const t = setup()
    const list = await t.h.nativeSessions(project(t), 'omp')
    expect(list).toMatchObject([{ id, title: '起的标题', firstPrompt: '一', ownerId: null }])
    expect(await t.h.nativeSessionDetails(project(t), 'omp', [id])).toMatchObject([
      { id, lastPrompt: '三', model: 'fake/fake-omp' },
    ])
    const done = (await t.h.importNativeSession(project(t), 'omp', id, {})) as { sessionId: string }
    const record = t.h.open(done.sessionId).record
    expect(record).toMatchObject({ engine: 'omp', engineSessionId: file, title: '起的标题' })
    const texts = () =>
      t.h.open(done.sessionId).items.flatMap(i => (i.kind === 'user' || i.kind === 'assistant' ? [i.text] : []))
    expect(texts()).toEqual(['一', '好的', '二', '好的', '三', '好的'])
    expect(await t.h.nativeSessionAction(done.sessionId, 'check')).toEqual({ added: 0 })
    await t.send('四', done.sessionId)
    expect(t.contexts().at(-1)).toEqual(['一', '二', '三', '四'])
    expect(t.h.open(done.sessionId).record.engineSessionId).toBe(file)
    expect((await t.h.nativeSessions(project(t), 'omp'))[0].ownerId).toBe(done.sessionId)
    expect(await t.h.importNativeSession(project(t), 'omp', id, {})).toEqual({ ownerId: done.sessionId })
    // 导入来的轮次也能回退
    await t.h.rewind(done.sessionId, t.user('二', done.sessionId))
    await t.send('五', done.sessionId)
    expect(t.contexts().at(-1)).toEqual(['一', '五'])
  })
  it.runIf(process.platform === 'win32')('盘符大小写不一样（VS Code 终端里是 d:）：照样接得上', async () => {
    const drive = root[0]
    const other = drive === drive.toLowerCase() ? drive.toUpperCase() : drive.toLowerCase()
    const { file, id } = await leftover(other + root.slice(1))
    const t = setup()
    const done = (await t.h.importNativeSession(project(t), 'omp', id, {})) as { sessionId: string }
    await t.send('四', done.sessionId)
    expect(t.contexts().at(-1)).toEqual(['一', '二', '三', '四'])
    expect(t.h.open(done.sessionId).record.engineSessionId).toBe(file)
    // 还没有会话文件的（分叉）：按磁盘上的大小写
    const real = realpathSync.native(root)
    expect(await ompCwd(null, real.toLowerCase())).toBe(real)
  })

  it('复制一份接着聊：原来的文件一个字节不动', async () => {
    const { file, id } = await leftover()
    const before = readFileSync(file)
    const t = setup()
    const done = (await t.h.importNativeSession(project(t), 'omp', id, { mode: 'copy' })) as { sessionId: string }
    await t.send('四', done.sessionId)
    expect(t.contexts().at(-1)).toEqual(['一', '二', '三', '四'])
    expect(readFileSync(file).equals(before)).toBe(true)
    expect(t.h.open(done.sessionId).record.engineSessionId).not.toBe(file)
  })
  it('分批读：最近几轮、往前加载；压缩的位置显示出来；id 不对、文件没了', async () => {
    const { file } = await leftover()
    const leaf = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1)!).id
    const more = [
      {
        type: 'compaction',
        id: 'k1',
        parentId: leaf,
        timestamp: '2026-11-23T08:00:00.000Z',
        summary: '总结',
        tokensBefore: 9,
      },
      {
        type: 'message',
        id: 'k2',
        parentId: 'k1',
        message: { role: 'user', content: '<pixelsky-handoff>x</pixelsky-handoff>\n\n四' },
      },
    ]
    writeFileSync(file, readFileSync(file, 'utf8') + more.map(m => JSON.stringify(m) + '\n').join(''))
    const read = (await ompReadNative(file, { turns: 2 }))!
    expect(read).toMatchObject({ turns: 4, shown: 2, hasEarlier: true, summary: '总结', at: 'k2', compacted: false })
    const view = (items: { kind: string; text?: string }[]) => items.map(i => i.text ?? i.kind)
    expect(view(read.items as never)).toEqual(['三', '好的', 'compaction', '四'])
    const older = (await ompReadNative(file, { turns: 50, before: read.items[0].id }))!
    expect(view(older.items as never)).toEqual(['一', '好的', '二', '好的'])
    expect(older).toMatchObject({ shown: 2, hasEarlier: false, compacted: true })
    expect((await ompReadNative(file, { maxItems: 3 }))!.shown).toBe(1)
    expect(await ompReadNative(file, { before: 'px-imp-none-u' })).toBeNull()
    expect(await ompSessionFile(root, join(root, 'none.jsonl'))).toBeNull()
    expect(await ompSessionFile(root, '01a2070e-7df1-70f9-9687-000000000000')).toBeNull()
  })
})

describe('截断点', () => {
  const line = (o: unknown) => JSON.stringify(o) + '\n'
  const write = (rows: unknown[]) => {
    const file = join(root, 's.jsonl')
    writeFileSync(file, line({ type: 'title' }) + line({ type: 'session', id: 's' }) + rows.map(line).join(''))
    return file
  }
  const entry = (id: string, parentId: string | null, role?: string, turn?: string) =>
    turn !== undefined
      ? { type: 'custom', customType: 'pixelsky.turn', data: { id: turn }, id, parentId, timestamp: 't' }
      : { type: 'message', id, parentId, timestamp: 't', message: { role, content: 'x'.repeat(2000) } }
  // 一 → 二（退掉了）；从一接着：三
  const rows = [
    entry('a', null, undefined, 'i1'),
    entry('b', 'a', 'user'),
    entry('c', 'b', 'assistant'),
    entry('d', 'c', undefined, 'i2'),
    entry('e', 'd', 'user'),
    entry('f', 'd', undefined, ''),
    entry('g', 'f', undefined, 'i3'),
    entry('h', 'g', 'user'),
    entry('i', 'h', 'assistant'),
  ]
  it('只认当前分支上的；取最早的一条；第一轮之前返回开头', () => {
    const file = write(rows)
    expect(ompAnchor(file, ['i3'])).toEqual({ at: 'g' })
    expect(ompAnchor(file, ['i2', 'i3'])).toEqual({ at: 'd' })
    expect(ompAnchor(file, ['i1', 'i3'])).toEqual({ at: null })
    expect(ompAnchor(file, ['i1'], 'd')).toEqual({ at: null })
    // 自动重连的「继续」也是被移除的那条
    const again = write([...rows, entry('j', 'i', undefined, 'i3-reconnect-x'), entry('k', 'j', 'user')])
    expect(ompAnchor(again, ['i3'])).toEqual({ at: 'g' })
  })
  it('没进过记录的：最后一轮有标记才算没动过，不然按找不到', () => {
    const file = write(rows)
    expect(ompAnchor(file, ['new'])).toEqual({ at: 'i', unchanged: true })
    expect(ompAnchor(file, [])).toEqual({ at: 'i', unchanged: true })
    expect(ompAnchor(file, ['new'], 'g')).toEqual({ at: 'g', unchanged: true })
    const unmarked = write([...rows, entry('j', 'i', 'user'), entry('k', 'j', 'assistant')])
    expect(ompAnchor(unmarked, ['new'])).toBeNull()
    expect(ompAnchor(join(root, 'none.jsonl'), ['i1'])).toBeNull()
  })
  it('终端里聊的、导入的轮次：条目 id 里带着引擎的条目 id，退到那条用户消息之前', () => {
    const file = write([...rows, entry('j', 'i', 'user'), entry('k', 'j', 'assistant')])
    expect(ompAnchor(file, ['px-tui-j-u'])).toEqual({ at: 'j' })
    expect(ompAnchor(file, ['px-imp-b-u', 'px-tui-j-u'])).toEqual({ at: null })
    // 截断点是用户消息：从它的上一条往前算
    expect(ompAnchor(file, [], 'j')).toEqual({ at: 'j', unchanged: true })
  })
  it('复制会话文件：只要写完整的行，子智能体的对话一起；认不出文件头不复制', () => {
    const file = write(rows)
    writeFileSync(file, readFileSync(file, 'utf8') + '{"type":"message","id":"half"')
    mkdirSync(join(root, 's'))
    writeFileSync(join(root, 's', 'A.jsonl'), 'sub')
    mkdirSync(join(root, 'out'))
    const copy = ompForkFile(file, join(root, 'out'), 'D:\\别的 目录')
    const lines = readFileSync(copy, 'utf8').split('\n')
    expect(lines).toHaveLength(2 + rows.length + 1)
    expect(JSON.parse(lines[1])).toMatchObject({ type: 'session', parentSession: 's', cwd: 'D:\\别的 目录' })
    expect(lines.slice(2, -1).map(l => JSON.parse(l))).toEqual(rows)
    expect(readFileSync(join(copy.replace(/\.jsonl$/, ''), 'A.jsonl'), 'utf8')).toBe('sub')
    writeFileSync(file, line({ type: 'message', id: 'x' }))
    expect(() => ompForkFile(file, join(root, 'out'), 'x')).toThrow()
    expect(readdirSync(join(root, 'out')).filter(f => f.endsWith('.jsonl'))).toHaveLength(1)
    expect(existsSync(copy)).toBe(true)
  })
})
