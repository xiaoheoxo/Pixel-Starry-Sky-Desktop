// 给手机 App（Flutter，apps/app）导出会话相关的共用测试样例（docs/mobile-app.md §5.2）：
// 事件折叠成快照（reduce）、按轮折叠（foldTurns / splitTurns / turnReplies / summarizeProcess）、
// 带代码的错误、Codex 行内标记、diffStat 和几个常量。结果都由这里的 TS 实现算出，Dart 测试（apps/app/test/protocol/）逐项比对。
// 平时只比较，样例不是最新就失败；改了这些函数之后运行 node scripts/export-app-fixtures.mjs 重写（APP_FIXTURES_UPDATE=1）。
// 样例必须确定：随机序列用固定种子的伪随机数生成。
import { describe, it } from 'vitest'
import {
  CHAT_PROJECT_ID,
  ENGINES,
  EFFORTS,
  ERROR_PREFIX,
  PERMISSION_MODES,
  citationName,
  diffStat,
  emptySnapshot,
  foldTurns,
  parseCodedError,
  reduce,
  replaceCodedErrors,
  replaceCodexDirectives,
  splitTurns,
  summarizeProcess,
  turnReplies,
  type EngineEvent,
  type FileChange,
  type FoldOptions,
  type Item,
  type ItemStatus,
  type SessionRecord,
  type SessionSnapshot,
  type TurnEntry,
} from '../src'

// 协议包不带 node 类型（tsconfig 的 types 为空），只在测试里读写文件，同 src/extpacks/text.test.ts
// @ts-expect-error 协议包没有 node 类型
const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
// @ts-expect-error 协议包没有 node 类型
const { join, resolve } = await import('node:path')
// @ts-expect-error 协议包没有 node 类型
const env: Record<string, string | undefined> = process.env
// vitest 在包目录（packages/protocol）里运行
// @ts-expect-error 协议包没有 node 类型
const OUT: string = resolve(process.cwd(), '..', '..', 'apps', 'app', 'test', 'fixtures')
const UPDATE = env.APP_FIXTURES_UPDATE === '1'
const GENERATED_BY =
  '由 packages/protocol/test/app-fixtures.test.ts 生成（node scripts/export-app-fixtures.mjs），不要手改'

function check(name: string, value: unknown): void {
  const text = JSON.stringify(value, null, 1) + '\n'
  const file = join(OUT, name)
  if (UPDATE) {
    mkdirSync(OUT, { recursive: true })
    writeFileSync(file, text)
    return
  }
  const old = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null
  if (old === text) return
  const lines = text.split('\n')
  const at = old === null ? 0 : old.split('\n').findIndex((line: string, i: number) => line !== lines[i]) + 1
  throw new Error(
    `apps/app/test/fixtures/${name} ${old === null ? '不存在' : `不是最新（第 ${at} 行起不同）`}：` +
      '运行 node scripts/export-app-fixtures.mjs 重新导出，再到 apps/app 跑 flutter test',
  )
}

// ---- 固定种子的伪随机数（mulberry32） ----
function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number) => Math.floor(next() * n)
  const pick = <T>(list: readonly T[]): T => list[int(list.length)]
  const chance = (p: number) => next() < p
  return { int, pick, chance }
}
type Rng = ReturnType<typeof rng>

const record: SessionRecord = {
  id: 's1',
  projectId: 'p1',
  cwd: 'D:\\work',
  engine: 'claude',
  engineSessionId: null,
  title: '新会话',
  model: null,
  effort: 'high',
  permissionMode: 'edits',
  ultracode: false,
  fast: false,
  thinkingSummaries: true,
  createdAt: 0,
  updatedAt: 0,
  lastOutcome: null,
}

const STATUSES: ItemStatus[] = ['running', 'completed', 'failed', 'declined', 'interrupted']
const TEXTS = ['', '   ', '好的', '先看一下代码。', 'Done.\n\n```ts\nconst a = 1\n```', '**重点：**改完了', '\n']

function makeChanges(r: Rng): FileChange[] {
  const paths = ['a.ts', 'b/c.ts', 'a.ts', 'README.md']
  return Array.from({ length: 1 + r.int(3) }, () => ({
    path: r.pick(paths),
    kind: r.pick(['add', 'update', 'delete'] as const),
    diff: '@@ -1 +1 @@\n-a\n+b',
    added: r.int(20),
    removed: r.int(10),
  }))
}

function makeItem(r: Rng, id: string, turnId: string): Item {
  const status = r.pick(STATUSES)
  const sub = r.chance(0.2) ? { subagent: r.pick(['explorer', 'worker']) } : {}
  const bg = r.chance(0.15) ? { background: true } : {}
  const review = r.chance(0.2)
    ? {
        review: {
          status: r.pick(['reviewing', 'approved', 'denied', 'timedOut', 'aborted'] as const),
          ...(r.chance(0.5) ? { overridden: true } : {}),
        },
      }
    : {}
  switch (r.int(11)) {
    case 0:
      return {
        kind: 'user',
        id,
        text: r.pick(['你好', '继续', '/compact', '修一下']),
        createdAt: 1,
        ...(r.chance(0.3) ? { mode: r.pick(['normal', 'guidance'] as const) } : {}),
        ...(r.chance(0.1) ? { reconnect: 1 } : {}),
      }
    case 1:
    case 2:
      return { kind: 'assistant', id, text: r.pick(TEXTS), status }
    case 3:
      return { kind: 'reasoning', id, text: r.pick(TEXTS), status }
    case 4:
      return {
        kind: 'command',
        id,
        command: 'npm test',
        description: r.chance(0.5) ? '跑测试' : null,
        output: r.pick(['', 'ok\n', 'FAIL']),
        exitCode: r.chance(0.5) ? 0 : null,
        status,
        ...sub,
        ...bg,
        ...review,
        ...(r.chance(0.1) ? { cutChars: 100 } : {}),
      }
    case 5:
      return { kind: 'file_change', id, changes: makeChanges(r), status, ...sub, ...bg, ...review }
    case 6: {
      const tool = r.pick(['read', 'search', 'web', 'mcp', 'task', 'other'] as const)
      return {
        kind: 'tool',
        id,
        tool,
        name: tool === 'task' ? 'Agent' : 'Read',
        title: 'src/a.ts',
        output: r.pick(['', '内容']),
        status,
        ...sub,
        ...bg,
        ...review,
      }
    }
    case 7: {
      const steps = Array.from({ length: 1 + r.int(4) }, (_, i) => ({
        text: `第 ${i + 1} 步`,
        status: r.pick(['pending', 'in_progress', 'completed'] as const),
      }))
      return { kind: 'todo', id: r.chance(0.5) ? 'todo' : id, steps, status }
    }
    case 8:
      return {
        kind: 'notice',
        id,
        level: r.pick(['info', 'warn', 'error'] as const),
        text: '提示',
        ...(r.chance(0.3)
          ? { task: { kind: 'agent' as const, status: 'completed' as const, label: '探索', summary: '完成' } }
          : {}),
      }
    case 9:
      return {
        kind: 'compaction',
        id,
        status,
        trigger: r.pick(['manual', 'auto', null] as const),
        startedAt: 1,
        durationMs: null,
        preTokens: null,
        postTokens: null,
      }
    default:
      return {
        kind: 'turn_stats',
        id,
        turnId,
        outcome: r.pick(['completed', 'interrupted', 'failed'] as const),
        usage: { durationMs: r.int(5000) } as Extract<Item, { kind: 'turn_stats' }>['usage'],
      }
  }
}

/** 随机事件序列：覆盖 reduce 的每一种事件，也让 foldTurns 遇到各种轮次形状 */
function makeEvents(seed: number, length: number): EngineEvent[] {
  const r = rng(seed)
  const ids: string[] = []
  let turn = 0
  let turnId = 't0'
  let n = 0
  const events: EngineEvent[] = []
  for (let k = 0; k < length; k++) {
    const roll = r.int(100)
    if (roll < 8) {
      turnId = `t${++turn}`
      const user: Item = { kind: 'user', id: `u${turn}`, text: `第 ${turn} 轮`, createdAt: turn }
      ids.push(user.id)
      events.push({ type: 'item_completed', item: user })
      events.push(
        r.chance(0.5)
          ? { type: 'turn_started', turnId, execution: { model: 'm', effort: 'high' } as never }
          : { type: 'turn_started', turnId },
      )
    } else if (roll < 40) {
      const id = ids.length && r.chance(0.25) ? r.pick(ids) : `i${++n}`
      if (!ids.includes(id)) ids.push(id)
      events.push({ type: r.chance(0.5) ? 'item_started' : 'item_completed', item: makeItem(r, id, turnId) })
    } else if (roll < 58) {
      const itemId = ids.length && r.chance(0.9) ? r.pick(ids) : 'missing'
      events.push({
        type: 'item_delta',
        itemId,
        field: r.pick(['text', 'output'] as const),
        delta: r.pick(['字', ' x', '\n']),
      })
    } else if (roll < 62) {
      events.push({
        type: 'turn_completed',
        turnId,
        outcome: r.pick(['completed', 'interrupted', 'failed'] as const),
        error: null,
      })
    } else if (roll < 64) {
      events.push({ type: 'status', state: r.pick(['idle', 'running', 'waiting'] as const) })
    } else if (roll < 67) {
      events.push({
        type: 'context',
        context: r.chance(0.8) ? ({ used: r.int(1000), window: 2000, stale: false } as never) : null,
      })
    } else if (roll < 70) {
      events.push({
        type: 'record',
        record: {
          ...record,
          model: r.pick([null, 'opus', 'sonnet']),
          engine: r.pick(['claude', 'codex'] as const),
          ...(r.chance(0.5) ? { platform: r.pick([{ group: 'a' }, { group: 'b' }, null]) as never } : {}),
          ...(r.chance(0.3) ? { provider: { id: r.pick(['x', 'y']) } as never } : {}),
        },
      })
    } else if (roll < 73) {
      const requestId = `r${r.int(3)}`
      events.push(
        r.chance(0.6)
          ? { type: 'approval_request', request: { requestId, kind: 'command', title: '运行' } as never }
          : { type: 'approval_resolved', requestId },
      )
    } else if (roll < 75) {
      events.push({
        type: 'request_retry',
        retry: r.chance(0.7) ? ({ turnId: r.pick([turnId, 'other']), attempt: 1 } as never) : null,
      })
    } else if (roll < 77) {
      events.push({ type: 'compaction_progress', progress: r.chance(0.5) ? ({ phase: 'summarizing' } as never) : null })
    } else if (roll < 79) {
      events.push({
        type: 'queue',
        items: r.chance(0.5) ? [{ id: 'q1', text: '排队' } as never] : [],
        paused: r.chance(0.3),
      })
    } else if (roll < 81 && ids.length) {
      events.push({ type: 'items_truncated', fromItemId: r.chance(0.8) ? r.pick(ids) : 'missing' })
    } else if (roll < 82) {
      events.push({ type: 'items_reset', items: [makeItem(r, `reset${k}`, turnId)] })
    } else if (roll < 84) {
      events.push({ type: 'background', count: r.int(3) })
    } else if (roll < 86) {
      events.push({ type: 'suggestion', text: r.pick([null, '继续', '提交吧']) })
    } else if (roll < 87) {
      events.push({ type: 'usage', usage: { inputTokens: r.int(100) } as never })
    } else if (roll < 88) {
      events.push({
        type: 'flags',
        flags: { ultracodeAvailable: r.chance(0.5), fastAvailable: null, fastState: 'off', fastBlocked: null },
      })
    } else if (roll < 89) {
      events.push({ type: 'tasks', tasks: [{ id: 'bg1' } as never] })
    } else if (roll < 90) {
      events.push({ type: 'subagents', subagents: [{ id: 'sa1' } as never] })
    } else if (roll < 91) {
      events.push({ type: 'runs', runs: { workflows: [], agents: [{ id: 'a1' } as never] } })
    } else if (roll < 92) {
      events.push({ type: 'commands', commands: [{ name: 'review' } as never] })
    } else if (roll < 93) {
      events.push({ type: 'goal', goal: r.chance(0.5) ? ({ text: '目标' } as never) : null })
    } else if (roll < 94) {
      events.push({ type: 'mcp', report: null })
    } else if (roll < 95) {
      events.push({ type: 'execution', settings: { model: 'x' } as never })
    } else if (roll < 96) {
      events.push({ type: 'input_ack', id: 'q1', state: 'consumed' })
    } else if (roll < 97) {
      events.push({ type: 'request_usage', request: {} as never })
    } else if (roll < 98) {
      events.push({ type: 'request_cache_reset' })
    } else {
      events.push({
        type: 'item_completed',
        item: {
          kind: 'turn_stats',
          id: `stats${turn}`,
          turnId,
          outcome: 'completed',
          usage: { durationMs: 1234 } as never,
        },
      })
    }
  }
  return events
}

/** 随机序列碰不到或很少碰到的路径：逐条手写 */
function handEvents(): { name: string; events: EngineEvent[] }[] {
  const tool = (id: string, extra: object = {}): Item =>
    ({ kind: 'tool', id, tool: 'read', name: 'Read', title: id, output: '', status: 'running', ...extra }) as Item
  const todo = (id: string, statuses: ('pending' | 'in_progress' | 'completed')[]): Item => ({
    kind: 'todo',
    id,
    steps: statuses.map((status, i) => ({ text: `第 ${i + 1} 步`, status })),
    status: 'running',
  })
  const user = (id: string, extra: object = {}): Item =>
    ({ kind: 'user', id, text: id, createdAt: 1, ...extra }) as Item
  return [
    {
      name: '后台子智能体的工具不跟着这一轮收尾',
      events: [
        { type: 'turn_started', turnId: 't1' },
        { type: 'item_started', item: tool('fg') },
        { type: 'item_started', item: tool('bg', { background: true, subagent: 'worker' }) },
        {
          type: 'item_started',
          item: {
            kind: 'command',
            id: 'cmd',
            command: 'x',
            description: null,
            output: '',
            exitCode: null,
            status: 'running',
            background: true,
          },
        },
        { type: 'item_started', item: { kind: 'assistant', id: 'a', text: '', status: 'running' } },
        { type: 'item_started', item: user('u-running') },
        { type: 'turn_completed', turnId: 't1', outcome: 'interrupted', error: null },
        { type: 'turn_completed', turnId: 't1', outcome: 'failed', error: null },
      ],
    },
    {
      name: '计划每一步的开始位置',
      events: [
        { type: 'item_completed', item: user('u1') },
        { type: 'item_started', item: tool('r1') },
        { type: 'item_completed', item: todo('todo', ['in_progress', 'pending']) },
        { type: 'item_started', item: tool('r2') },
        { type: 'item_started', item: tool('sub', { subagent: 'explorer' }) },
        { type: 'item_completed', item: todo('todo', ['in_progress', 'pending']) },
        { type: 'item_completed', item: todo('todo', ['completed', 'in_progress']) },
        { type: 'item_completed', item: user('guide', { mode: 'guidance' }) },
        { type: 'item_completed', item: user('again', { reconnect: 1 }) },
        { type: 'item_completed', item: todo('todo2', ['completed', 'completed']) },
        { type: 'item_completed', item: user('u2') },
        { type: 'item_completed', item: todo('todo3', ['in_progress']) },
        { type: 'item_completed', item: todo('todo3', ['completed']) },
      ],
    },
    {
      name: '换模型、引擎、线路时上下文标成过期',
      events: [
        { type: 'record', record: { ...record, model: 'opus' } },
        { type: 'context', context: { used: 10, window: 100 } as never },
        { type: 'record', record: { ...record, model: 'opus' } },
        { type: 'record', record: { ...record, model: 'opus', platform: { group: 'a' } as never } },
        { type: 'context', context: { used: 10, window: 100 } as never },
        { type: 'record', record: { ...record, model: 'opus', platform: { group: 'a' } as never } },
        { type: 'record', record: { ...record, model: 'opus', platform: null as never } },
        { type: 'context', context: { used: 1, window: 100 } as never },
        {
          type: 'record',
          record: { ...record, model: 'opus', platform: null as never, provider: { id: 'p' } as never },
        },
        { type: 'context', context: { used: 2, window: 100 } as never },
        {
          type: 'record',
          record: {
            ...record,
            model: 'opus',
            platform: null as never,
            provider: { id: 'p' } as never,
            engine: 'codex',
          },
        },
      ],
    },
    {
      name: '重试只认这一轮的、截断、输出截过的不接增量',
      events: [
        { type: 'turn_started', turnId: 't9', execution: { model: 'm' } as never },
        { type: 'request_retry', retry: { turnId: 'other', attempt: 1 } as never },
        { type: 'request_retry', retry: { turnId: 't9', attempt: 2 } as never },
        { type: 'request_retry', retry: null },
        { type: 'item_started', item: tool('cut', { cutChars: 10 }) },
        { type: 'item_delta', itemId: 'cut', field: 'output', delta: '不接' },
        { type: 'item_started', item: tool('ok') },
        { type: 'item_delta', itemId: 'ok', field: 'output', delta: '接上' },
        { type: 'item_delta', itemId: 'ok', field: 'text', delta: '不接' },
        { type: 'items_truncated', fromItemId: 'ok' },
        { type: 'items_truncated', fromItemId: 'cut' },
        { type: 'background', count: 0 },
        { type: 'background', count: 2 },
        { type: 'background', count: 2 },
      ],
    },
  ]
}

/** 随机序列碰不到的形状，手写：生成的图（Codex 生图在一轮中间、云端生图在统计行之后单独一轮） */
function handFoldItems(): Item[][] {
  const user = (id: string): Item => ({ kind: 'user', id, text: id, createdAt: 0 })
  const say = (id: string): Item => ({ kind: 'assistant', id, text: id, status: 'completed' })
  const read = (id: string): Item => ({
    kind: 'tool',
    id,
    tool: 'read',
    name: 'Read',
    title: id,
    output: '',
    status: 'completed',
  })
  const image = (id: string, name: 'imageGeneration' | 'cloudImage'): Item => ({
    kind: 'tool',
    id,
    tool: 'other',
    name,
    title: id,
    output: '',
    status: 'completed',
  })
  const stats = (id: string): Item => ({
    kind: 'turn_stats',
    id,
    turnId: id,
    outcome: 'completed',
    usage: { durationMs: 1234, models: {} },
  })
  return [
    [user('u'), read('r1'), image('g', 'imageGeneration'), read('r2'), say('好了'), stats('s')],
    [user('u'), say('a'), stats('s'), image('c', 'cloudImage')],
    [user('u'), read('r1'), image('g', 'imageGeneration')],
  ]
}

/** foldTurns 的结果只记 id（条目内容由 reduce 的样例覆盖），文件小、差异好读 */
const compactFold = (entries: TurnEntry[]) =>
  entries.map(e =>
    e.type === 'item'
      ? { type: 'item', id: e.item.id }
      : { type: 'process', key: e.key, ids: e.items.map(i => i.id), running: e.running, durationMs: e.durationMs },
  )

const FOLD_OPTIONS: { name: string; options: FoldOptions }[] = [
  { name: 'default', options: {} },
  { name: 'box', options: { subagents: 'box' } },
  { name: 'interleave', options: { interleave: true } },
  { name: 'box+interleave', options: { subagents: 'box', interleave: true } },
]

describe('app fixtures: protocol', () => {
  it('protocol_reduce.json', () => {
    const cases = Array.from({ length: 30 }, (_, i) => {
      const seed = 1000 + i
      const events = makeEvents(seed, 20 + (i % 5) * 10)
      // 每 15 个事件记一次快照：中途的状态也要一致
      const checkpoints: { after: number; snapshot: SessionSnapshot }[] = []
      let s = emptySnapshot(record)
      events.forEach((e, k) => {
        s = reduce(s, e)
        if ((k + 1) % 15 === 0 || k === events.length - 1) checkpoints.push({ after: k + 1, snapshot: s })
      })
      return { seed, start: emptySnapshot(record), events, checkpoints }
    })
    const hand = handEvents().map(({ name, events }) => {
      const checkpoints: { after: number; snapshot: SessionSnapshot }[] = []
      let s = emptySnapshot(record)
      events.forEach((e, k) => {
        s = reduce(s, e)
        checkpoints.push({ after: k + 1, snapshot: s })
      })
      return { seed: name, start: emptySnapshot(record), events, checkpoints }
    })
    check('protocol_reduce.json', { generatedBy: GENERATED_BY, cases: [...hand, ...cases] })
  })

  it('protocol_fold.json', () => {
    const random = Array.from(
      { length: 60 },
      (_, i) => makeEvents(5000 + i, 25 + (i % 5) * 8).reduce(reduce, emptySnapshot(record)).items,
    )
    const cases = [...random, ...handFoldItems()].map(items => {
      return {
        items,
        splitTurns: splitTurns(items).map(t => t.map(x => x.id)),
        fold: FOLD_OPTIONS.flatMap(({ name, options }) =>
          [false, true].map(running => ({
            options: name,
            running,
            entries: compactFold(foldTurns(items, running, options)),
          })),
        ),
        replies: FOLD_OPTIONS.slice(0, 2).map(({ name, options }) => ({
          options: name,
          map: [...turnReplies(items, options)].map(([k, v]) => ({ statsId: k, text: v })),
        })),
        summary: summarizeProcess(items),
      }
    })
    check('protocol_fold.json', { generatedBy: GENERATED_BY, foldOptions: FOLD_OPTIONS, cases })
  })

  it('protocol_text.json', () => {
    const coded = (code: string, params?: Record<string, string | number>) =>
      ERROR_PREFIX + JSON.stringify(params ? { code, params } : { code })
    const errorInputs = [
      '',
      '普通错误',
      coded('files.exists'),
      coded('files.exists', { path: 'a.ts' }),
      `启动失败：${coded('engine.spawn', { code: 2 })}`,
      `${coded('a')}，然后 ${coded('b', { n: 1 })}。`,
      `${coded('files.missing', { path: 'src/{id}.ts' })} 之后`,
      `${ERROR_PREFIX}{坏的 JSON}`,
      `${ERROR_PREFIX}{"code":""}`,
      `${ERROR_PREFIX}{"code":"x","params":[1,2]}`,
      `${ERROR_PREFIX}{"code":"x","params":{"a":true,"b":"s","c":1.5}}`,
      `${ERROR_PREFIX}not json`,
      `  ${coded('trim.me')}  `,
      `${coded('a')}x`,
      `前缀\n${coded('next.line')}\n后缀`,
      `${ERROR_PREFIX}{"code":"x"`,
    ]
    const errors = errorInputs.map(input => ({
      input,
      parsed: parseCodedError(input),
      replaced: replaceCodedErrors(input, info => `[${info.code}|${JSON.stringify(info.params)}]`),
    }))
    const codexInputs = [
      '没有标记',
      '看 :codex-file-citation{path="src/a.ts" purpose="output"} 这个文件',
      ':codex-file-citation{path="C:\\work\\b.ts"}',
      '::codex-file-citation{path=x.ts}',
      ':::codex-file-citation{path="y.ts"}',
      '::::codex-file-citation{path="z.ts"}',
      '\\:codex-file-citation{path="esc.ts"}',
      '\\\\:codex-file-citation{path="esc2.ts"}',
      ':codex-followup[运行测试]{id="1"}',
      '::codex-followup[两个冒号]{id="1"}',
      ':codex-followup[  ]{id="1"}',
      ':codex-followup[嵌套 [括号] 文字]{a=b}',
      ':codex-followup[跨\n行]{a=b}',
      ':codex-followup[转义 \\] 括号]{q="带 \\" 引号"}',
      ':codex-file-citation[不该有]{path="a"}',
      ':codex-file-citation{purpose="no-path"}',
      ':codex-file-citation{path="a" path="b"}',
      ':codex-file-citation{path="未闭合}',
      ":codex-file-citation{path='单引号.ts'}",
      ':codex-file-citation{ path = "空格.ts" }',
      ':codex-file-citation{path="a"\n}',
      '```\n:codex-file-citation{path="代码块里.ts"}\n```\n外面 :codex-file-citation{path="外面.ts"}',
      '行内 `:codex-file-citation{path="行内.ts"}` 和 :codex-file-citation{path="真的.ts"}',
      '没配对的 ``` 在行中间 :codex-file-citation{path="仍然替换.ts"}',
      '~~~\n:codex-followup[不换]{a=b}\n~~~',
      'a:codex-file-citation{path="紧跟字母.ts"}',
      ':codex-file-citation{path="a.ts"}:codex-file-citation{path="b.ts"}',
      ':codex-followup[x]',
      ':codex-file-citation',
      ':codex-file-citation{path=""}',
    ]
    const codex = codexInputs.map(input => ({
      input,
      output: replaceCodexDirectives(input, c => `[[${c.path}|${JSON.stringify(c.attributes)}]]`),
    }))
    const citations = ['a.ts', 'src/a.ts', 'C:\\work\\b.ts', 'dir/', '/', '', 'a\\b/c'].map(path => ({
      path,
      name: citationName(path),
    }))
    const diffs = [[], makeChanges(rng(7)), makeChanges(rng(8))].map(changes => ({ changes, stat: diffStat(changes) }))
    check('protocol_text.json', { generatedBy: GENERATED_BY, errors, codex, citations, diffs })
  })

  it('protocol_constants.json', () => {
    check('protocol_constants.json', {
      generatedBy: GENERATED_BY,
      chatProjectId: CHAT_PROJECT_ID,
      errorPrefix: ERROR_PREFIX,
      permissionModes: PERMISSION_MODES,
      efforts: EFFORTS,
      engines: Object.values(ENGINES).map(e => ({ id: e.id, name: e.name, short: e.short, caps: e.caps })),
    })
  })
})
