// 对话检查点接进宿主（docs/ui/undo-changes.md）：每轮前后拍快照、改动卡片撤回 / 恢复、回退只还原部分文件
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineInfo, ImageAttachment, SessionSettings, SessionSnapshot } from '@pixelsky/protocol'
import type { EngineAdapter, EngineSession, RewindFilesReply, SessionContext } from '../src/adapter'
import { CHECKPOINT_EXPIRED, CheckpointError, type ShadowRepo } from '../src/checkpoints'
import { EngineHost } from '../src/host'
import { ENGINES } from '../src/registry'
import { makeTmp, removeTmp } from './helpers/tmp'

let root: string
let work: string
let hosts: EngineHost[]

beforeEach(() => {
  root = makeTmp('checkpoints-host')
  work = join(root, 'work')
  mkdirSync(work)
  hosts = []
})
afterEach(async () => {
  await Promise.all(hosts.map(h => h.shutdown()))
  removeTmp(root)
})

const until = async (fn: () => boolean, what = 'condition'): Promise<void> => {
  for (let i = 0; i < 1000; i++) {
    if (fn()) return
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`timeout: ${what}`)
}

const read = (path: string): string | null =>
  existsSync(join(work, path)) ? readFileSync(join(work, path), 'utf8') : null
const write = (path: string, text: string): void => writeFileSync(join(work, path), text)

/** 每条消息按 edits 表改文件，然后结束这一轮 */
class EditingSession implements EngineSession {
  constructor(
    readonly ctx: SessionContext,
    private readonly edits: Record<string, Record<string, string>>,
  ) {}
  send(text: string, turnId: string, _id: string, _attachments?: ImageAttachment[]) {
    for (const [path, content] of Object.entries(this.edits[text] ?? {})) write(path, content)
    setTimeout(() => this.ctx.emit({ type: 'turn_completed', turnId, outcome: 'completed', error: null }), 5)
  }
  async interrupt() {}
  answer() {}
  async update(_patch: Partial<SessionSettings>) {}
  async close() {}
}

class EditingAdapter implements EngineAdapter {
  constructor(private readonly edits: Record<string, Record<string, string>>) {}
  async info(): Promise<EngineInfo> {
    return { ...ENGINES.claude, status: 'ready', version: 'fake', path: 'fake', message: null }
  }
  createSession(ctx: SessionContext) {
    return new EditingSession(ctx, this.edits)
  }
  async update() {
    return { ok: true, output: '', version: null }
  }
}

/** 还带引擎自己的检查点（rewindFiles）：记下调用，还原时把 a.txt / keep.txt 改回最初 */
class RewindingAdapter extends EditingAdapter {
  readonly calls: { userItemId: string; dryRun: boolean }[] = []
  createSession(ctx: SessionContext) {
    // 引擎的检查点要有引擎会话
    if (!ctx.record().engineSessionId) ctx.setEngineSessionId('engine-session')
    return super.createSession(ctx)
  }
  async rewindFiles(
    _record: unknown,
    userItemId: string,
    dryRun: boolean,
    beforeRestore?: (files: string[]) => void,
  ): Promise<RewindFilesReply> {
    this.calls.push({ userItemId, dryRun })
    const files = [join(work, 'a.txt'), join(work, 'keep.txt')]
    if (!dryRun) {
      beforeRestore?.(files)
      rmSync(files[0]!, { force: true })
      writeFileSync(files[1]!, 'v0\n')
    }
    return { ok: true, files, insertions: 0, deletions: 2 }
  }
}

function setup(edits: Record<string, Record<string, string>>, adapter: EngineAdapter = new EditingAdapter(edits)) {
  const host = new EngineHost({
    dataDir: join(root, 'data'),
    adapters: { claude: adapter },
    checkpoints: true,
    emit: () => {},
  })
  hosts.push(host)
  const project = host.addProject(work)
  const id = host.createSession({ projectId: project.id }).id
  const send = async (text: string): Promise<string> => {
    await host.send(id, { text, clientMessageId: text })
    // 等这一轮结束、结束时的快照也拍完（files 有值）
    await until(() => {
      const snap = host.open(id)
      const user = snap.items.find(i => i.kind === 'user' && i.text === text)
      return (
        snap.state === 'idle' &&
        !!user &&
        host.checkpoints(id).turns.some(t => t.itemId === user.id && t.files !== null)
      )
    }, `turn ${text}`)
    return host.open(id).items.find(i => i.kind === 'user' && i.text === text)!.id
  }
  return { host, id, send }
}

interface TurnRecord {
  before?: string
  after?: string
  at: number
  endedAt?: number
  lost?: true
}

/** 宿主里的检查点模块（测试里改它的行为、看它记下的数据） */
const internals = (host: EngineHost) =>
  (
    host as unknown as {
      m: {
        checkpoints: {
          states: Map<string, { repo: ShadowRepo; data: { turns: Record<string, TurnRecord> } }>
          beforeTurn(id: string, itemId: string): Promise<void>
          failed(id: string, err: Error): void
        }
      }
    }
  ).m.checkpoints

/** 发一条消息，等这一轮结束、done(这一轮的检查点记录) 为真；返回用户消息 id */
async function sendUntil(
  host: EngineHost,
  id: string,
  text: string,
  done: (turn: TurnRecord | undefined) => boolean,
): Promise<string> {
  await host.send(id, { text, clientMessageId: text })
  let itemId = ''
  await until(() => {
    const snap = host.open(id)
    const user = snap.items.find(i => i.kind === 'user' && i.text === text)
    if (!user || snap.state !== 'idle') return false
    itemId = user.id
    return done(internals(host).states.get(id)?.data.turns[user.id])
  }, `turn ${text}`)
  return itemId
}

// 比 until() 的 10 秒大：负载高时让它自己的「timeout: …」先报出来，而不是 vitest 默认的 5 秒
describe('对话检查点（宿主）', { timeout: 20_000 }, () => {
  it('每轮记下改了哪些文件；改动卡片撤回新建的文件、再恢复', async () => {
    write('keep.txt', 'v0\n')
    const { host, id, send } = setup({ a: { 'a.txt': 'new\n', 'keep.txt': 'v1\n' } })
    const a = await send('a')
    expect(host.checkpoints(id).turns).toEqual([{ itemId: a, files: ['a.txt', 'keep.txt'], at: expect.any(Number) }])

    const result = await host.revertFiles(id, a, [join(work, 'a.txt')], false)
    expect(result).toMatchObject({ kind: 'done', reverted: [join(work, 'a.txt')], skipped: [] })
    expect(read('a.txt')).toBeNull()
    const revertId = result.kind === 'done' ? result.revertId! : ''
    expect(host.checkpoints(id).reverted).toEqual([{ revertId, itemId: a, paths: [join(work, 'a.txt')] }])

    await host.restoreFiles(id, revertId)
    expect(read('a.txt')).toBe('new\n')
    expect(host.checkpoints(id).reverted).toEqual([])
  })

  it('之后又被改过：先返回冲突，确认后才撤回', async () => {
    write('keep.txt', 'v0\n')
    const { host, id, send } = setup({ a: { 'keep.txt': 'v1\n' }, b: { 'keep.txt': 'v2\n' } })
    const a = await send('a')
    await send('b')
    const conflict = await host.revertFiles(id, a, ['keep.txt'], false)
    expect(conflict).toMatchObject({ kind: 'conflict', conflicts: [{ path: 'keep.txt', added: 1, removed: 1 }] })
    expect(conflict.kind === 'conflict' && conflict.conflicts[0].diff).toContain('+v2')
    expect(read('keep.txt')).toBe('v2\n')

    const done = await host.revertFiles(id, a, ['keep.txt'], true)
    expect(done.kind).toBe('done')
    expect(read('keep.txt')).toBe('v0\n')
  })

  it('工作目录外、被排除的文件不能撤回', async () => {
    write('.gitignore', 'secret.env\n')
    const { host, id, send } = setup({ a: { 'secret.env': 'k\n', 'ok.txt': 'ok\n' } })
    const a = await send('a')
    const result = await host.revertFiles(id, a, ['secret.env', join(root, 'outside.txt'), 'ok.txt'], false)
    expect(result).toMatchObject({
      kind: 'done',
      reverted: ['ok.txt'],
      skipped: [
        { path: join(root, 'outside.txt'), reason: 'outside' },
        { path: 'secret.env', reason: 'excluded' },
      ],
    })
    expect(read('secret.env')).toBe('k\n')
  })

  it('回退：预览列出手改过的文件，只还原选中的几个，可以撤销', async () => {
    write('keep.txt', 'v0\n')
    const { host, id, send } = setup({ a: { 'a.txt': 'a\n', 'keep.txt': 'v1\n' }, b: { 'b.txt': 'b\n' } })
    const a = await send('a')
    await send('b')
    write('keep.txt', 'hand\n')
    const preview = await host.rewindPreview(id, a)
    expect(preview.code).toMatchObject({
      ok: true,
      files: ['a.txt', 'b.txt', 'keep.txt'],
      edited: ['keep.txt'],
      checkpoint: true,
    })

    const result = await host.rewind(id, a, { conversation: false, code: true, paths: ['a.txt', 'keep.txt'] })
    expect(result.filesRestored).toBe(2)
    expect(read('a.txt')).toBeNull()
    expect(read('keep.txt')).toBe('v0\n')
    expect(read('b.txt')).toBe('b\n')

    await host.undoRewind(id)
    expect(read('a.txt')).toBe('a\n')
    expect(read('keep.txt')).toBe('hand\n')
  })

  it('回退对话后，被移除的轮次不再当成「最后一轮」：不会把它改过的文件误报成手改', async () => {
    write('keep.txt', 'v0\n')
    const { host, id, send } = setup({ a: { 'keep.txt': 'v1\n' }, b: { 'keep.txt': 'v2\n' } })
    const a = await send('a')
    const b = await send('b')
    await host.rewind(id, b, { conversation: true, code: true })
    expect(read('keep.txt')).toBe('v1\n')
    const preview = await host.rewindPreview(id, a)
    expect(preview.code).toMatchObject({ ok: true, files: ['keep.txt'], edited: [] })
    // 撤回 a 也不该报冲突：现在的内容就是 a 结束时的
    expect(await host.revertFiles(id, a, ['keep.txt'], false)).toMatchObject({ kind: 'done', reverted: ['keep.txt'] })
    expect(read('keep.txt')).toBe('v0\n')
  })

  it('开始打字时先在后台拍第一次（只建仓库，不记成哪一轮的快照）', async () => {
    write('a.txt', 'a\n')
    const { host, id } = setup({})
    const head = join(root, 'data', 'sessions', id, 'checkpoints', 'HEAD')
    expect(existsSync(head)).toBe(false)
    host.prepareCheckpoints(id)
    await until(() => existsSync(join(root, 'data', 'sessions', id, 'checkpoints', 'index')), 'prepared index')
    expect(host.checkpoints(id).turns).toEqual([])
  })

  it('连续超时停用后只是不再拍新的：已有的快照照样能撤回', async () => {
    write('keep.txt', 'v0\n')
    const { host, id, send } = setup({ a: { 'keep.txt': 'v1\n' } })
    const a = await send('a')
    const checkpoints = (host as unknown as { m: { checkpoints: { failed(id: string, err: Error): void } } }).m
      .checkpoints
    for (let i = 0; i < 3; i++) checkpoints.failed(id, new CheckpointError('timeout', '拍快照超时'))
    expect(host.checkpoints(id)).toMatchObject({ disabled: 'slow', turns: [{ itemId: a }] })
    expect(await host.revertFiles(id, a, ['keep.txt'], false)).toMatchObject({ kind: 'done', reverted: ['keep.txt'] })
    expect(read('keep.txt')).toBe('v0\n')
  })

  it('一轮刚结束就删会话：结束后台的 git，会话目录删干净', async () => {
    const { host, id } = setup({ a: { 'a.txt': 'a\n' } })
    await host.send(id, { text: 'a', clientMessageId: 'a' })
    await until(() => host.open(id).state === 'idle' && host.open(id).items.length > 0, 'turn a')
    await host.deleteSession(id)
    expect(existsSync(join(root, 'data', 'sessions', id))).toBe(false)
  })

  it('旧记录里存下的「太慢」不再永久停用', async () => {
    write('a.txt', 'a\n')
    const { host, id, send } = setup({ a: { 'a.txt': 'b\n' } })
    const dir = join(root, 'data', 'sessions', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'checkpoints.json'),
      JSON.stringify({ version: 1, cwd: work, disabled: 'slow', message: '拍快照超时', turns: {} }),
    )
    const a = await send('a')
    expect(host.checkpoints(id)).toMatchObject({ disabled: null, turns: [{ itemId: a, files: ['a.txt'] }] })
  })

  it('快照缺了内容（影子仓库被删过）：预览说快照失效、不再列出，回退代码报失效、不动文件', async () => {
    write('keep.txt', 'v0\n')
    const { host, id, send } = setup({ a: { 'keep.txt': 'v1\n' }, b: { 'keep.txt': 'v2\n' } })
    const a = await send('a')
    const b = await send('b')
    rmSync(join(root, 'data', 'sessions', id, 'checkpoints'), { recursive: true })
    expect((await host.rewindPreview(id, a)).code).toEqual({
      ok: false,
      reason: 'expired',
      message: CHECKPOINT_EXPIRED,
    })
    expect(host.checkpoints(id).turns.map(t => t.itemId)).toEqual([b])
    await expect(host.rewind(id, a, { conversation: false, code: true })).rejects.toThrow(CHECKPOINT_EXPIRED)
    expect(read('keep.txt')).toBe('v2\n')
    // 同时回退对话：对话照样回退，告诉界面代码为什么没恢复
    const result = await host.rewind(id, a, { conversation: true, code: true })
    expect(result.codeSkipped).toBe(CHECKPOINT_EXPIRED)
    expect(read('keep.txt')).toBe('v2\n')
  })

  it('改动卡片撤回时才发现快照失效：跳过并说明，记为失效', async () => {
    write('keep.txt', 'v0\n')
    const { host, id, send } = setup({ a: { 'keep.txt': 'v1\n' } })
    const a = await send('a')
    rmSync(join(root, 'data', 'sessions', id, 'checkpoints'), { recursive: true })
    expect(await host.revertFiles(id, a, ['keep.txt'], false)).toEqual({
      kind: 'done',
      revertId: null,
      reverted: [],
      skipped: [{ path: 'keep.txt', reason: 'no-checkpoint', message: CHECKPOINT_EXPIRED }],
    })
    expect(read('keep.txt')).toBe('v1\n')
    expect(host.checkpoints(id).turns).toEqual([])
    const saved = JSON.parse(readFileSync(join(root, 'data', 'sessions', id, 'checkpoints.json'), 'utf8'))
    expect(saved.turns[a].lost).toBe(true)
  })

  it('后一轮失效了：它结束时的快照照样用来判断手改，它改的文件不误报成手改', async () => {
    write('keep.txt', 'v0\n')
    const { host, id, send } = setup({ a: { 'keep.txt': 'v1\n' }, b: { 'keep.txt': 'v2\n' } })
    const a = await send('a')
    const b = await send('b')
    internals(host).states.get(id)!.data.turns[b]!.lost = true
    expect((await host.rewindPreview(id, a)).code).toMatchObject({ ok: true, files: ['keep.txt'], edited: [] })
    expect(await host.revertFiles(id, a, ['keep.txt'], false)).toMatchObject({ kind: 'conflict' })
  })

  it('开始前的快照没拍到（没拍完、出错）：结束时照样拍，它改的文件不算手改，真手改照样标出', async () => {
    write('keep.txt', 'v0\n')
    const { host, id, send } = setup({ a: { 'keep.txt': 'v1\n' }, b: { 'keep.txt': 'v2\n', 'b.txt': 'b\n' } })
    const a = await send('a')
    const checkpoints = internals(host)
    const beforeTurn = checkpoints.beforeTurn
    checkpoints.beforeTurn = async () => {}
    const b = await sendUntil(host, id, 'b', turn => !!turn?.after)
    checkpoints.beforeTurn = beforeTurn
    expect(checkpoints.states.get(id)!.data.turns[b]).toMatchObject({
      after: expect.any(String),
      endedAt: expect.any(Number),
    })
    expect(checkpoints.states.get(id)!.data.turns[b]!.before).toBeUndefined()
    // 没有开始前的快照：不能回到它之前
    expect(host.checkpoints(id).turns.map(t => t.itemId)).toEqual([a])
    expect((await host.rewindPreview(id, a)).code).toMatchObject({ ok: true, files: ['b.txt', 'keep.txt'], edited: [] })
    write('keep.txt', 'hand\n')
    expect((await host.rewindPreview(id, a)).code).toMatchObject({ ok: true, edited: ['keep.txt'] })
  })

  it('快照停用后拍不了：按修改时间判断，这一轮里 AI 改的不算手改，结束后手改的算', async () => {
    write('keep.txt', 'v0\n')
    const { host, id, send } = setup({ a: { 'keep.txt': 'v1\n' }, b: { 'keep.txt': 'v2\n' } })
    const a = await send('a')
    const checkpoints = internals(host)
    for (let i = 0; i < 3; i++) checkpoints.failed(id, new CheckpointError('timeout', '拍快照超时'))
    const b = await sendUntil(host, id, 'b', turn => !!turn?.endedAt)
    expect(checkpoints.states.get(id)!.data.turns[b]).toEqual({ at: expect.any(Number), endedAt: expect.any(Number) })
    expect((await host.rewindPreview(id, a)).code).toMatchObject({ ok: true, files: ['keep.txt'], edited: [] })
    write('keep.txt', 'hand\n')
    const later = (Date.now() + 10_000) / 1000
    utimesSync(join(work, 'keep.txt'), later, later)
    expect((await host.rewindPreview(id, a)).code).toMatchObject({ ok: true, edited: ['keep.txt'] })
  })

  it('对话最后是中途插入的引导、没送达的消息：它们没有自己的结束记录，用最近结束的那一轮', async () => {
    write('keep.txt', 'v0\n')
    const { host, id, send } = setup({ a: { 'keep.txt': 'v1\n' }, b: { 'keep.txt': 'v2\n' } })
    const a = await send('a')
    const checkpoints = internals(host)
    for (let i = 0; i < 3; i++) checkpoints.failed(id, new CheckpointError('timeout', '拍快照超时'))
    await sendUntil(host, id, 'b', turn => !!turn?.endedAt)
    // 按消息顺序取最后一条就落到它们身上，只能退回和 a 结束时比，b 改的会算成手改
    const runtime = (
      host as unknown as { m: { sessions: { runtime(id: string): { snapshot: SessionSnapshot } } } }
    ).m.sessions.runtime(id)
    runtime.snapshot = {
      ...runtime.snapshot,
      items: [
        ...runtime.snapshot.items,
        { kind: 'user', id: 'steer', text: '换个写法', createdAt: Date.now(), mode: 'guidance' },
        { kind: 'user', id: 'gone', text: 'c', createdAt: Date.now(), dismissed: true },
      ],
    }
    expect((await host.rewindPreview(id, a)).code).toMatchObject({ ok: true, files: ['keep.txt'], edited: [] })
  })

  it('只勾了几个文件、确认时快照失效了：报失效、不改用引擎的检查点（没勾的手改不被改回）；全部还原时才改用', async () => {
    write('keep.txt', 'v0\n')
    const adapter = new RewindingAdapter({ a: { 'a.txt': 'a\n', 'keep.txt': 'v1\n' } })
    const { host, id, send } = setup({}, adapter)
    const a = await send('a')
    write('keep.txt', 'hand\n')
    expect((await host.rewindPreview(id, a)).code).toMatchObject({ ok: true, checkpoint: true })
    // 预览到确认之间快照缺了内容（项目的 git 清理了对象）
    rmSync(join(root, 'data', 'sessions', id, 'checkpoints'), { recursive: true })
    await expect(host.rewind(id, a, { conversation: false, code: true, paths: ['a.txt'] })).rejects.toThrow(
      CHECKPOINT_EXPIRED,
    )
    expect(adapter.calls).toEqual([])
    expect(read('a.txt')).toBe('a\n')
    expect(read('keep.txt')).toBe('hand\n')
    // 同时回退对话：对话照样回退，代码没动、说明原因
    const both = await host.rewind(id, a, { conversation: true, code: true, paths: ['a.txt'] })
    expect(both.codeSkipped).toBe(CHECKPOINT_EXPIRED)
    expect(adapter.calls).toEqual([])
    expect(read('keep.txt')).toBe('hand\n')
    await host.undoRewind(id)
    // 全部还原（没传 paths）：对话检查点失效了才改用引擎自己的
    const all = await host.rewind(id, a, { conversation: false, code: true })
    expect(adapter.calls).toEqual([{ userItemId: a, dryRun: false }])
    expect(all.filesRestored).toBe(2)
    expect(read('a.txt')).toBeNull()
    expect(read('keep.txt')).toBe('v0\n')
  })

  it('撤回时结束快照缺了内容：退回比修改时间，之后手改过的报冲突，没改过的照常撤回', async () => {
    write('keep.txt', 'v0\n')
    write('other.txt', 'o0\n')
    const { host, id, send } = setup({ a: { 'keep.txt': 'v1\n', 'other.txt': 'o1\n' } })
    const a = await send('a')
    // 结束时的树不在了（git 清理掉了）：读它报错，查一遍确认是缺内容
    internals(host).states.get(id)!.data.turns[a]!.after = '0123456789abcdef0123456789abcdef01234567'
    write('keep.txt', 'hand\n')
    const later = (Date.now() + 10_000) / 1000
    utimesSync(join(work, 'keep.txt'), later, later)
    const result = await host.revertFiles(id, a, ['keep.txt', 'other.txt'], false)
    expect(result).toMatchObject({ kind: 'conflict', conflicts: [{ path: 'keep.txt' }] })
    if (result.kind === 'conflict') expect(result.conflicts[0]!.diff).toContain('+hand')
    expect(read('keep.txt')).toBe('hand\n')
    expect(await host.revertFiles(id, a, ['other.txt'], false)).toMatchObject({
      kind: 'done',
      reverted: ['other.txt'],
    })
    expect(read('other.txt')).toBe('o0\n')
  })

  it('回退代码时读快照中途出错：一个文件都不改（以前前面的文件已经被覆盖、撤销里也没有）', async () => {
    write('keep.txt', 'v0\n')
    const { host, id, send } = setup({ a: { 'a.txt': 'a\n', 'keep.txt': 'v1\n' } })
    const a = await send('a')
    write('keep.txt', 'hand\n')
    const repo = internals(host).states.get(id)!.repo
    const blob = repo.blob.bind(repo)
    repo.blob = (tree, path) =>
      path === 'keep.txt' ? Promise.reject(new CheckpointError('failed', 'git 超时了')) : blob(tree, path)
    await host.rewind(id, a, { conversation: false, code: true }).catch(() => null)
    expect(read('a.txt')).toBe('a\n')
    expect(read('keep.txt')).toBe('hand\n')
  })

  it('撤回时读结束快照出了别的错（不是缺内容）：撤回失败，不动文件', async () => {
    write('keep.txt', 'v0\n')
    const { host, id, send } = setup({ a: { 'keep.txt': 'v1\n' } })
    const a = await send('a')
    const repo = internals(host).states.get(id)!.repo
    const after = internals(host).states.get(id)!.data.turns[a]!.after!
    const blob = repo.blob.bind(repo)
    repo.blob = (tree, path) =>
      tree === after ? Promise.reject(new CheckpointError('failed', 'git 出错了')) : blob(tree, path)
    await expect(host.revertFiles(id, a, ['keep.txt'], false)).rejects.toThrow('git 出错了')
    expect(read('keep.txt')).toBe('v1\n')
  })

  // docs/ui/checkpoint-disk.md
  describe('不占满磁盘', () => {
    type Inner = { failed(id: string, err: Error): void; maintain(limit?: number): Promise<number> }
    const inner = (host: EngineHost): Inner => (host as unknown as { m: { checkpoints: Inner } }).m.checkpoints
    const cpDir = (id: string): string => join(root, 'data', 'sessions', id, 'checkpoints')
    /** 在这个会话里发一条，等结束时的快照也拍完 */
    const sendIn = async (host: EngineHost, id: string, text: string): Promise<void> => {
      await host.send(id, { text, clientMessageId: `${id}-${text}` })
      await until(() => {
        const snap = host.open(id)
        const user = snap.items.find(i => i.kind === 'user' && i.text === text)
        return snap.state === 'idle' && !!user && host.checkpoints(id).turns.some(t => t.itemId === user.id && t.files)
      }, `turn ${text}`)
    }

    it('超时按项目算：同一个工作目录里的新会话不从 0 开始', async () => {
      const { host, id } = setup({})
      const other = host.createSession({ projectId: host.projects()[0]!.id }).id
      for (let i = 0; i < 3; i++) inner(host).failed(id, new CheckpointError('timeout', '拍快照超时'))
      expect(host.checkpoints(other).disabled).toBe('slow')
      await host.send(other, { text: 'a', clientMessageId: 'a' })
      await until(() => host.open(other).state === 'idle' && host.open(other).items.length > 0)
      expect(existsSync(cpDir(other))).toBe(false)
    })

    it('磁盘剩余不到 5 GiB：不拍新快照，写明原因', async () => {
      const host = new EngineHost({
        dataDir: join(root, 'data'),
        adapters: { claude: new EditingAdapter({ a: { 'a.txt': 'a\n' } }) },
        checkpoints: true,
        diskFree: async () => 1024 ** 3,
        emit: () => {},
      })
      hosts.push(host)
      const id = host.createSession({ projectId: host.addProject(work).id }).id
      await host.send(id, { text: 'a', clientMessageId: 'a' })
      await until(() => host.open(id).state === 'idle' && host.open(id).items.length > 0)
      expect(host.checkpoints(id)).toMatchObject({ disabled: 'disk-low', turns: [] })
      expect(existsSync(cpDir(id))).toBe(false)
    })

    it('定时清理：清掉半截文件；合计超限时先删最久没用的；清理检查点删掉全部', async () => {
      write('a.txt', 'v0\n')
      const { host, id: old } = setup({ a: { 'a.txt': 'v1\n' }, b: { 'a.txt': 'v2\n' } })
      const recent = host.createSession({ projectId: host.projects()[0]!.id }).id
      await sendIn(host, old, 'a')
      await sendIn(host, recent, 'b')
      // 没有对应会话的目录里留着被结束的 git 写到一半的包
      const orphan = join(cpDir('gone'), 'objects', 'pack')
      mkdirSync(orphan, { recursive: true })
      writeFileSync(join(orphan, 'tmp_pack_AbCdEf'), Buffer.alloc(300_000))
      expect(await inner(host).maintain()).toBe(300_000)
      expect(existsSync(join(orphan, 'tmp_pack_AbCdEf'))).toBe(false)
      expect(host.checkpoints(old).turns).toHaveLength(1)

      // 最久没用的会话占得多：只删它就回到上限以内，最近用的不动
      writeFileSync(join(cpDir(old), 'objects', 'pack', 'pack-junk.pack'), Buffer.alloc(1_000_000))
      await inner(host).maintain(500_000)
      expect(existsSync(cpDir(old))).toBe(false)
      expect(host.checkpoints(old).turns).toEqual([])
      expect(host.checkpoints(recent).turns).toHaveLength(1)

      // 删掉之后这个会话照样能从头拍
      await sendIn(host, old, 'b')
      expect(host.checkpoints(old).turns).toHaveLength(1)

      expect(await host.cleanCheckpoints(true)).toBeGreaterThan(0)
      expect(existsSync(cpDir(old))).toBe(false)
      expect(existsSync(cpDir(recent))).toBe(false)
      expect(host.checkpoints(recent)).toMatchObject({ disabled: null, turns: [] })
    })

    it('清理检查点：正在撤回 / 回退的会话不删；撤回过的文件清理后还能恢复', async () => {
      write('keep.txt', 'v0\n')
      const { host, id } = setup({ a: { 'keep.txt': 'v1\n' } })
      await sendIn(host, id, 'a')
      const a = host.checkpoints(id).turns[0]!.itemId
      const result = await host.revertFiles(id, a, ['keep.txt'], false)
      const revertId = result.kind === 'done' ? result.revertId! : ''
      expect(read('keep.txt')).toBe('v0\n')

      const changing = (host as unknown as { ctx: { changingSessions: Set<string> } }).ctx.changingSessions
      changing.add(id)
      await host.cleanCheckpoints(true)
      expect(existsSync(cpDir(id))).toBe(true)
      changing.delete(id)

      expect(await host.cleanCheckpoints(true)).toBeGreaterThan(0)
      expect(existsSync(cpDir(id))).toBe(false)
      expect(host.checkpoints(id)).toMatchObject({ turns: [], reverted: [{ revertId }] })
      await host.restoreFiles(id, revertId)
      expect(read('keep.txt')).toBe('v1\n')
    })
  })

  it('没打开检查点时不拍快照', async () => {
    const host = new EngineHost({
      dataDir: join(root, 'data'),
      adapters: { claude: new EditingAdapter({ a: { 'a.txt': 'a\n' } }) },
      emit: () => {},
    })
    hosts.push(host)
    const id = host.createSession({ projectId: host.addProject(work).id }).id
    await host.send(id, { text: 'a', clientMessageId: 'a' })
    await until(() => host.open(id).state === 'idle' && host.open(id).items.length > 0)
    expect(host.checkpoints(id)).toEqual({ disabled: null, turns: [], reverted: [] })
    expect(existsSync(join(root, 'data', 'sessions', id, 'checkpoints'))).toBe(false)
  })
})
