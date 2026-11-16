// 像素星空引擎的终端模式：docs/ui/tui-toggle.md §12.3、§12.8
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineInfo, ExtensionLaunch, SessionRecord, TuiMark } from '@pixelsky/protocol'
import type { EngineAdapter, EngineSession, SessionContext, TuiLaunch } from '../src/adapter'
import { EngineHost } from '../src/host'
import type { NativeRead, NativeSessionList, NewerTurns } from '../src/native/types'
import { entries } from '../src/pixel/agents'
import { pixelLaunch } from '../src/pixel/session'
import {
  leafOf,
  markOfFile,
  nodeVersionOk,
  pixelTuiArgs,
  privateNode,
  readSinceMark,
  sinceLeaf,
} from '../src/pixel/tui'
import { ENGINES } from '../src/registry'

const record = (over: Partial<SessionRecord> = {}): SessionRecord =>
  ({ engine: 'pixel', cwd: 'D:\\p', permissionMode: 'ask', model: null, effort: null, ...over }) as SessionRecord

type Entry = Record<string, unknown>
const msg = (id: string, parentId: string | null, role: string, content: unknown): Entry => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-11-16T00:00:00.000Z',
  message: { role, content },
})
const u = (id: string, parent: string | null, text: string) => msg(id, parent, 'user', [{ type: 'text', text }])
const a = (id: string, parent: string, text: string) => msg(id, parent, 'assistant', [{ type: 'text', text }])

describe('pixelTuiArgs', () => {
  it('接上会话文件，模型和思考档走参数', () => {
    expect(
      pixelTuiArgs(record({ model: 'anthropic/claude-x', effort: 'high' }), 'D:\\s\\a.jsonl', [
        '--permission-mode',
        'default',
      ]),
    ).toEqual([
      '--permission-mode',
      'default',
      '--session',
      'D:\\s\\a.jsonl',
      '--model',
      'anthropic/claude-x',
      '--thinking',
      'high',
    ])
    expect(pixelTuiArgs(record({ effort: 'ultra' }), 'f', [])).toEqual(['--session', 'f', '--thinking', 'max'])
  })
  it('经网关的只用网关注册的 pixelsky/<id>，已经带前缀的不重复加', () => {
    const gw = { platform: true } as unknown as Partial<SessionRecord>
    expect(pixelTuiArgs(record({ ...gw, model: 'claude-x' }), 'f', []).slice(2)).toEqual([
      '--model',
      'pixelsky/claude-x',
    ])
    expect(pixelTuiArgs(record({ ...gw, model: 'pixelsky/claude-x' }), 'f', []).slice(2)).toEqual([
      '--model',
      'pixelsky/claude-x',
    ])
  })
})

describe('pixelLaunch（会话进程和终端共用）', () => {
  const ext = {
    env: { EXT: '1' },
    pathDirs: ['D:\\ext\\bin'],
    mcpFile: 'D:\\mcp.json',
    allowTools: ['mcp__a'],
    skillRoots: ['D:\\skills\\s1'],
  } as unknown as ExtensionLaunch
  it('权限档、技能、搜索工具、用户追加的参数；扩展 env、PATH、MCP', () => {
    const r = pixelLaunch({ PATH: 'C:\\bin', PIXELSKY_MCP_FILE: 'old' }, record(), 'full', ext, { args: ['--x'] })
    expect(r.args).toEqual([
      '--permission-mode',
      'bypassPermissions',
      '--skill',
      'D:\\skills\\s1',
      '--tools',
      '+grep,+find,+ls',
      '--x',
    ])
    expect(r.env).toMatchObject({ EXT: '1', PIXELSKY_MCP_FILE: 'D:\\mcp.json', PIXELSKY_ALLOW_TOOLS: 'mcp__a' })
    expect(r.env.PATH?.startsWith('D:\\ext\\bin')).toBe(true)
  })
  it('没有扩展：去掉继承来的 MCP 变量；用户自己选了工具时不追加搜索工具', () => {
    const r = pixelLaunch({ PIXELSKY_MCP_FILE: 'old' }, record(), 'plan', undefined, { args: ['--tools', 'read'] })
    expect(r.args).toEqual(['--permission-mode', 'plan', '--tools', 'read'])
    expect(r.env.PIXELSKY_MCP_FILE).toBeUndefined()
  })
})

describe('leafOf / sinceLeaf（沿 parentId 从当前叶子走回切过去时的叶子）', () => {
  const before = [{ type: 'session', id: 'hdr' }, u('u1', null, '第一句'), a('a1', 'u1', '答一')]
  const mark: TuiMark = { leaf: 'a1' }

  it('直线：记下的叶子之后的都是终端里新聊的', () => {
    expect(leafOf(before)).toBe('a1')
    const after = [...before, u('u2', 'a1', '终端里问的'), a('a2', 'u2', '终端里答的')]
    const r = sinceLeaf(after, mark, 'D:\\p')
    expect(r?.items.map(i => [i.kind, 'text' in i ? i.text : ''])).toEqual([
      ['user', '终端里问的'],
      ['assistant', '终端里答的'],
    ])
    expect(r).toMatchObject({ turns: 1, shown: 1, gap: 0 })
    expect(r?.items[0]!.id).toBe('px-tui-u2-u')
  })
  it('终端里没说话：没有可补的', () => {
    expect(sinceLeaf(before, mark, '')).toMatchObject({ items: [], turns: 0 })
  })
  it('终端里 /tree 回到更早的地方接着聊：不经过记下的叶子，对不上', () => {
    const after = [...before, u('u2', 'u1', '换了个分支'), a('a2', 'u2', 'x')]
    expect(sinceLeaf(after, mark, '')).toBeNull()
  })
  it('记下的叶子不在文件里（文件被换掉）：对不上', () => {
    expect(sinceLeaf([u('x1', null, '别的'), a('x2', 'x1', 'y')], mark, '')).toBeNull()
  })
  it('新对话（叶子为空）：全部算新的；不是 Pixel 的位置不认', () => {
    expect(sinceLeaf(before, { leaf: '' }, '')?.turns).toBe(1)
    expect(sinceLeaf(before, { users: 0, last: '' }, '')).toBeNull()
  })
  it('工具调用和结果合成一张卡', () => {
    const list = [
      ...before,
      u('u2', 'a1', '看看'),
      msg('a2', 'u2', 'assistant', [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'x.ts' } }]),
      {
        ...msg('r1', 'a2', 'toolResult', [{ type: 'text', text: 'ok' }]),
        message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] },
      },
    ]
    const items = sinceLeaf(list, mark, 'D:\\p')!.items
    expect(items).toHaveLength(2)
    expect(items[1]).toMatchObject({ status: 'completed' })
  })
})

describe('找跑终端的 Node', () => {
  it('版本要 22.19 以上', () => {
    expect(nodeVersionOk('v22.19.0\n')).toBe(true)
    expect(nodeVersionOk('v24.1.0')).toBe(true)
    expect(nodeVersionOk('v22.18.1')).toBe(false)
    expect(nodeVersionOk('v20.11.0')).toBe(false)
    expect(nodeVersionOk('')).toBe(false)
  })
  it('私有 Node：目录里有 node 程序才算', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixelsky-node-'))
    try {
      expect(privateNode([dir], true)).toBeNull()
      writeFileSync(join(dir, 'node.exe'), '')
      expect(privateNode([dir], true)).toBe(join(dir, 'node.exe'))
      expect(privateNode([])).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---- 宿主：切过去记叶子，切回沿 parentId 补 ----

let root: string
let hosts: EngineHost[]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pixelsky-pixel-tui-'))
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

const lines = (list: Entry[]) => list.map(e => JSON.stringify(e)).join('\n') + '\n'

class FakeSession implements EngineSession {
  active: string | null = null
  constructor(
    readonly engine: 'pixel',
    private readonly ctx: SessionContext,
    private readonly file: string,
  ) {}
  send(text: string, turnId: string): void {
    this.active = turnId
    this.ctx.setEngineSessionId(this.file)
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

/** 会话文件是真文件，tuiMark / newerSinceMark 照真实 PixelAdapter 读它 */
class FakePixel implements EngineAdapter {
  readonly engine = 'pixel' as const
  constructor(readonly file: string) {}
  async info(): Promise<EngineInfo> {
    return { ...ENGINES.pixel, status: 'ready', version: '0', path: null, message: null }
  }
  createSession(ctx: SessionContext): FakeSession {
    return new FakeSession('pixel', ctx, this.file)
  }
  async nativeSessions(): Promise<NativeSessionList> {
    return { sessions: [] } as unknown as NativeSessionList
  }
  async readNativeSession(): Promise<NativeRead | null> {
    return null
  }
  hasNativeSession(r: SessionRecord): boolean {
    return !r.engineSessionId || entries(r.engineSessionId).length > 0
  }
  async tuiMark(_cwd: string, file: string): Promise<TuiMark | null> {
    return markOfFile(file)
  }
  async newerSinceMark(cwd: string, file: string, mark: TuiMark): Promise<NewerTurns | null> {
    return readSinceMark(file, mark, cwd)
  }
  tuiLaunch(r: SessionRecord): TuiLaunch {
    const file = r.engineSessionId ?? this.file
    return { command: 'node', args: ['pixel.mjs', '--session', file], env: {}, cwd: r.cwd, engineSessionId: file }
  }
}

function setup() {
  mkdirSync(join(root, 'sessions'), { recursive: true })
  const file = join(root, 'sessions', 's.jsonl')
  const pixel = new FakePixel(file)
  const host = new EngineHost({ dataDir: join(root, 'data'), adapters: { pixel }, emit: () => {} })
  hosts.push(host)
  const project = host.addProject(root)
  const rec = host.createSession({ projectId: project.id, engine: 'pixel', model: null, effort: null })
  return { file, host, rec }
}

describe('markOfFile / readSinceMark（回归：大会话不整份解析，只读切过去之后追加的）', () => {
  const base = [{ type: 'session', id: 'hdr' }, u('u1', null, '第一句'), a('a1', 'u1', '答一')]
  it('只读追加的那段：补上新聊的；没追加＝没有可补的，不算对不上', () => {
    const file = join(root, 's.jsonl')
    writeFileSync(file, lines(base))
    const mark = markOfFile(file)
    expect(mark).toEqual({ leaf: 'a1', size: Buffer.byteLength(lines(base)) })
    expect(readSinceMark(file, mark, '')).toMatchObject({ items: [], turns: 0 })
    appendFileSync(file, lines([u('u2', 'a1', '终端'), a('a2', 'u2', 't')]))
    expect(readSinceMark(file, mark, '')?.turns).toBe(1)
  })
  it('终端里 /tree 回到以前的条目接着聊：父条目在读的那段之前，对不上', () => {
    const file = join(root, 's.jsonl')
    writeFileSync(file, lines(base))
    const mark = markOfFile(file)
    appendFileSync(file, lines([u('u2', 'u1', '换分支'), a('a2', 'u2', 'x')]))
    expect(readSinceMark(file, mark, '')).toBeNull()
  })
  it('文件变小了（被重写过）：整份读；没有文件：叶子为空', () => {
    const file = join(root, 's.jsonl')
    writeFileSync(file, lines(base))
    expect(readSinceMark(file, { leaf: 'a1', size: 1e9 }, '')).toMatchObject({ turns: 0 })
    expect(markOfFile(join(root, 'none.jsonl'))).toEqual({ leaf: '', size: 0 })
  })
})

describe('宿主：Pixel 切终端', () => {
  it('能切；切过去记下叶子，切回补上之后的', async () => {
    const { file, host, rec } = setup()
    await host.send(rec.id, { text: '界面里问的', clientMessageId: 'm1' })
    await until(() => host.open(rec.id).state === 'idle' && host.open(rec.id).items.some(i => i.kind === 'assistant'))
    writeFileSync(file, lines([u('u1', null, '界面里问的'), a('a1', 'u1', 'ok')]))
    expect(host.tuiBlock(rec.id)).toBeNull()
    await host.prepareTui(rec.id)
    expect(host.open(rec.id).record.tui?.mark).toMatchObject({ leaf: 'a1' })

    writeFileSync(
      file,
      lines([u('u1', null, '界面里问的'), a('a1', 'u1', 'ok'), u('u2', 'a1', '终端里问的'), a('a2', 'u2', '答')]),
    )
    expect(await host.syncFromTui(rec.id)).toEqual({ added: 1, mismatched: false })
    expect(host.open(rec.id).items.at(-2)).toMatchObject({ kind: 'user', text: '终端里问的', source: 'tui' })
    host.clearTui(rec.id)
  })

  it('新对话直接切、终端里一句没说：预留的会话文件没写出来，切回清掉 id', async () => {
    const { file, host, rec } = setup()
    await host.prepareTui(rec.id)
    expect(host.open(rec.id).record).toMatchObject({ engineSessionId: file, tui: { mark: { leaf: '', size: 0 } } })
    expect(await host.syncFromTui(rec.id)).toEqual({ added: 0, mismatched: false })
    expect(host.open(rec.id).record.engineSessionId).toBeNull()
  })

  it('新对话切过去聊了：全部补上，id 留着', async () => {
    const { file, host, rec } = setup()
    await host.prepareTui(rec.id)
    writeFileSync(file, lines([{ type: 'session', id: 'hdr' }, u('u1', null, '终端'), a('a1', 'u1', 't')]))
    expect(await host.syncFromTui(rec.id)).toEqual({ added: 1, mismatched: false })
    expect(host.open(rec.id).record.engineSessionId).toBe(file)
  })
})
