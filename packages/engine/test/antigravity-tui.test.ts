// Antigravity 的终端模式：docs/ui/tui-toggle.md §12.2、§12.7
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineId, EngineInfo, Item, SessionRecord, TuiMark } from '@pixelsky/protocol'
import type { EngineAdapter, EngineSession, SessionContext, TuiLaunch } from '../src/adapter'
import { agyTuiArgs, markOf, sinceMark } from '../src/antigravity/tui'
import { EngineHost } from '../src/host'
import type { NativeRead, NativeSessionList, NewerTurns } from '../src/native/types'
import { ENGINES } from '../src/registry'

const record = (over: Partial<SessionRecord> = {}): SessionRecord =>
  ({ engine: 'antigravity', cwd: 'D:\\p', permissionMode: 'ask', model: null, effort: null, ...over }) as SessionRecord

const user = (text: string): Item =>
  ({ kind: 'user', id: 'ag-imp-' + text, text, attachments: [], createdAt: 0, mode: 'normal' }) as Item
const reply = (text: string): Item => ({ kind: 'assistant', id: 'a-' + text, text, createdAt: 0 }) as unknown as Item

describe('agyTuiArgs', () => {
  it('接着同一个会话，模型传系列名、档位单独传，用户追加的参数在前面', () => {
    expect(agyTuiArgs(record({ model: 'gemini-4-argon', effort: 'high' }), 'c1', ['--sandbox'])).toEqual([
      '--sandbox',
      '--conversation',
      'c1',
      '--model',
      'gemini-4-argon',
      '--effort',
      'high',
    ])
  })
  it('权限：询问不带 --mode（命令行不认 default），自动编辑 / 计划给 --mode，完全放行跳过审批', () => {
    const tail = (mode: SessionRecord['permissionMode']) =>
      agyTuiArgs(record({ permissionMode: mode }), 'c', []).slice(2)
    expect(tail('ask')).toEqual([])
    expect(tail('auto')).toEqual([])
    expect(tail('edits')).toEqual(['--mode', 'accept-edits'])
    expect(tail('plan')).toEqual(['--mode', 'plan'])
    expect(tail('full')).toEqual(['--dangerously-skip-permissions'])
  })
})

describe('markOf / sinceMark（回放没有稳定 id：切过去时记位置，切回从那往后取）', () => {
  const before = [user('第一句'), reply('答一'), user('第二句'), reply('答二')]
  const after = [...before, user('终端里问的'), reply('终端里答的')]

  it('记下的位置之后的算终端里新聊的', () => {
    const mark = markOf(before)
    expect(mark).toEqual({ users: 2, last: '第二句' })
    const r = sinceMark(after, mark)
    expect(r?.items.map(i => i.id)).toEqual(['ag-imp-终端里问的', 'a-终端里答的'])
    expect(r).toMatchObject({ turns: 1, shown: 1, gap: 0 })
  })
  it('终端里没说话：没有可补的', () => {
    expect(sinceMark(before, markOf(before))).toMatchObject({ items: [], turns: 0 })
  })
  it('界面替用户发的（提问回答、自动压缩的 /compact）在位置之前：照算，不会当成新的', () => {
    const ask = { kind: 'tool', id: 'q1', name: 'ask_question', status: 'running' } as unknown as Item
    const ui = [user('/compact'), user('改哪个？'), ask, user('A'), reply('改好了')]
    expect(sinceMark(ui, markOf(ui))).toMatchObject({ items: [], turns: 0 })
    expect(sinceMark([...ui, user('终端'), reply('t')], markOf(ui))?.items.map(i => i.id)).toEqual([
      'ag-imp-终端',
      'a-t',
    ])
  })
  it('终端里 /rewind 或 /clear 过：记下的那条不在原处，对不上', () => {
    const mark = markOf(before)
    expect(sinceMark([user('第一句'), reply('x')], mark)).toBeNull()
    expect(sinceMark([user('第一句'), reply('x'), user('换了一句'), reply('y')], mark)).toBeNull()
  })
  it('新建的空会话：全部算新的；空白不同不算变了', () => {
    expect(sinceMark(after, { users: 0, last: '' })?.turns).toBe(3)
    expect(sinceMark(after, { users: 2, last: '  第二句\n' })?.turns).toBe(1)
  })
})

// ---- 宿主：切过去时记位置，切回从那往后补 ----

let root: string
let hosts: EngineHost[]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pixelsky-agy-tui-'))
  hosts = []
})
afterEach(async () => {
  await Promise.all(hosts.map(h => h.shutdown()))
  rmSync(root, { recursive: true, force: true })
})

const until = async (fn: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (fn()) return
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('timeout')
}

class FakeSession implements EngineSession {
  active: string | null = null
  constructor(
    readonly engine: EngineId,
    private readonly ctx: SessionContext,
  ) {}
  send(text: string, turnId: string): void {
    this.active = turnId
    if (!this.ctx.record().engineSessionId) this.ctx.setEngineSessionId('agy-conv')
    setTimeout(() => {
      this.active = null
      this.ctx.emit({
        type: 'item_completed',
        item: { kind: 'assistant', id: 'a-' + turnId, text: 'ok:' + text, status: 'completed' },
      })
      this.ctx.emit({ type: 'turn_completed', turnId, outcome: 'completed', error: null })
    }, 0)
  }
  async interrupt(): Promise<void> {}
  answer(): void {}
  async update(): Promise<void> {}
  async close(): Promise<void> {}
}

/** replay 是 agy 那边现在的回放；marks 记 tuiMark 被调了几次 */
class FakeAgy implements EngineAdapter {
  readonly engine = 'antigravity' as const
  readonly enginePicksSessionId = true
  replay: Item[] = []
  marks = 0
  async info(): Promise<EngineInfo> {
    return { ...ENGINES.antigravity, status: 'ready', version: '0', path: null, message: null }
  }
  createSession(ctx: SessionContext): FakeSession {
    return new FakeSession('antigravity', ctx)
  }
  async nativeSessions(): Promise<NativeSessionList> {
    return { sessions: [] } as unknown as NativeSessionList
  }
  async readNativeSession(): Promise<NativeRead | null> {
    return null
  }
  async tuiMark(): Promise<TuiMark | null> {
    this.marks++
    return markOf(this.replay)
  }
  async newerSinceMark(_cwd: string, _id: string, mark: TuiMark): Promise<NewerTurns | null> {
    return sinceMark(this.replay, mark)
  }
  tuiLaunch(r: SessionRecord): TuiLaunch {
    const id = r.engineSessionId ?? 'agy-new'
    return { command: 'agy', args: ['--conversation', id], env: {}, cwd: r.cwd, engineSessionId: id }
  }
}

function setup() {
  const agy = new FakeAgy()
  const host = new EngineHost({ dataDir: join(root, 'data'), adapters: { antigravity: agy }, emit: () => {} })
  hosts.push(host)
  const project = host.addProject(root)
  const rec = host.createSession({
    projectId: project.id,
    engine: 'antigravity',
    model: 'gemini-4-carbon',
    effort: 'low',
  })
  let n = 0
  const say = async (text: string) => {
    await host.send(rec.id, { text, clientMessageId: `m${++n}` })
    await until(() => host.open(rec.id).state === 'idle' && host.open(rec.id).items.some(i => i.kind === 'assistant'))
  }
  return { agy, host, rec, say }
}

describe('宿主：Antigravity 切终端', () => {
  it('能切；切过去时记下位置，切回补上之后的', async () => {
    const { agy, host, rec, say } = setup()
    await say('界面里问的')
    expect(host.tuiBlock(rec.id)).toBeNull()
    agy.replay = [user('界面里问的'), reply('ok')]
    const launch = await host.prepareTui(rec.id)
    expect(launch.args).toEqual(['--conversation', 'agy-conv'])
    expect(host.open(rec.id).record.tui?.mark).toEqual({ users: 1, last: '界面里问的' })

    agy.replay.push(user('终端里问的'), reply('终端里答的'))
    expect(await host.syncFromTui(rec.id)).toEqual({ added: 1, mismatched: false })
    expect(host.open(rec.id).items.at(-2)).toMatchObject({ kind: 'user', text: '终端里问的', source: 'tui' })
    host.clearTui(rec.id)
  })

  it('回归（审查）：界面里最后一条没发到 agy（回放里没有），终端里聊的照样补上', async () => {
    const { agy, host, rec, say } = setup()
    await say('界面里发了但 agy 没收到')
    agy.replay = []
    await host.prepareTui(rec.id)
    agy.replay = [user('终端里问的'), reply('终端里答的')]
    expect(await host.syncFromTui(rec.id)).toEqual({ added: 1, mismatched: false })
  })

  it('新对话直接切：会话是刚建的，不读回放，切回时全部算新的', async () => {
    const { agy, host, rec } = setup()
    await host.prepareTui(rec.id)
    expect(agy.marks).toBe(0)
    expect(host.open(rec.id).record.tui?.mark).toEqual({ users: 0, last: '' })
    agy.replay = [user('终端'), reply('t')]
    expect(await host.syncFromTui(rec.id)).toEqual({ added: 1, mismatched: false })
  })

  it('终端里 /clear 过（对不上）：不补，按对不上提示', async () => {
    const { agy, host, rec, say } = setup()
    await say('界面里问的')
    agy.replay = [user('界面里问的'), reply('ok')]
    await host.prepareTui(rec.id)
    agy.replay = [user('/clear 之后的'), reply('x')]
    const before = host.open(rec.id).items.length
    expect(await host.syncFromTui(rec.id)).toEqual({ added: 0, mismatched: true })
    expect(host.open(rec.id).items.length).toBe(before)
  })
})
