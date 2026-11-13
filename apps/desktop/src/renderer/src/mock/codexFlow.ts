// 演示：Codex 普通模式下中间的回复直接显示、动作按段收起（docs/ui/codex-flow-slash-feedback.md A，D276）
import type { Item } from '@pixelsky/protocol'
import { assistant, opus, reasoning, sessionRecord, snapshot, stats, user } from './conversations'

export const CODEX_FLOW_PROJECT = 'codex-showcase'

/** 侧栏里的顺序和标题（mock/demo.ts 用） */
export const CODEX_FLOW_SESSIONS = [
  { id: 'demo-codex-flow-done', title: '中间的回复：已结束的两轮' },
  { id: 'demo-codex-flow-running', title: '中间的回复：运行中' },
] as const

const command = (id: string, cmd: string, status: 'completed' | 'running' | 'failed' = 'completed'): Item => ({
  kind: 'command',
  id,
  command: cmd,
  description: null,
  output: status === 'running' ? '' : 'BUILD SUCCESSFUL in 4s',
  exitCode: status === 'running' ? null : status === 'failed' ? 1 : 0,
  status,
})
const read = (id: string, path: string): Item => ({
  kind: 'tool',
  id,
  tool: 'read',
  name: 'read',
  title: path,
  output: '',
  status: 'completed',
})
const search = (id: string, query: string): Item => ({
  kind: 'tool',
  id,
  tool: 'search',
  name: 'search',
  title: query,
  output: '',
  status: 'completed',
})
const edit = (id: string, ...paths: string[]): Item => ({
  kind: 'file_change',
  id,
  changes: paths.map(path => ({
    path,
    kind: 'update' as const,
    diff: '@@ -1 +1 @@\n-old\n+new',
    added: 1,
    removed: 1,
  })),
  status: 'completed',
})

const usage = (ms: number) => ({ durationMs: ms, models: { 'gpt-5-codex': opus(2_400, 900, 0.06, 6) } })

/** 第一轮：读、改、验证，中间说了两段 */
const firstTurn = (p: string, minutesAgo: number): Item[] => [
  user(`${p}-u1`, '把物品候选来源接到 ULK 会话里', minutesAgo),
  reasoning(
    `${p}-r1`,
    '**Inspecting candidate pool**\n\nI need to see how the pool gets its items before wiring the source toggle.',
  ),
  assistant(`${p}-a1`, '我先看一下现在物品候选池是怎么取数据的，再把来源开关接进 ULK 会话。'),
  read(`${p}-t1`, 'src/main/kotlin/CandidatePool.kt'),
  read(`${p}-t2`, 'src/main/kotlin/UlkSession.kt'),
  search(`${p}-t3`, 'randomSource'),
  reasoning(
    `${p}-r2`,
    '**Wiring source toggle into session**\n\nThe toggle should default to off and only record recognised items.',
  ),
  assistant(`${p}-a2`, '候选池只认手动加的物品。我加一个随机来源开关，默认关闭，开启后只记录识别出的物品。'),
  edit(`${p}-e1`, 'src/main/kotlin/UlkSession.kt', 'src/main/kotlin/SourceToggle.kt'),
  edit(`${p}-e2`, 'src/main/resources/config.yml'),
  command(`${p}-c1`, 'gradle :v1_19:compileKotlin'),
  command(`${p}-c2`, 'gradle :v1_20:compileKotlin'),
  assistant(
    `${p}-a3`,
    '来源开关和 ULK 会话候选容器已接入；随机来源默认关闭，开启后只记录识别出的物品，并提供候选容器的事件接口。',
  ),
  stats(`${p}-s1`, 'completed', usage(184_000)),
]

const doneRecord = sessionRecord('demo-codex-flow-done', CODEX_FLOW_SESSIONS[0].title, CODEX_FLOW_PROJECT, {
  engine: 'codex',
  model: 'gpt-5-codex',
})
const runningRecord = sessionRecord('demo-codex-flow-running', CODEX_FLOW_SESSIONS[1].title, CODEX_FLOW_PROJECT, {
  engine: 'codex',
  model: 'gpt-5-codex',
})

/** 合进 mock/index.ts 的 conversations.snapshots */
export const codexFlowSnapshots = {
  'demo-codex-flow-done': snapshot(doneRecord, [
    ...firstTurn('cf', 30),
    user('cf-u2', '三个版本都验证一下', 12),
    reasoning(
      'cf-r3',
      '**Validating candidate sources across versions**\n\nRun the dry-run server and the source tests for each version.',
    ),
    assistant('cf-a4', '我在三个版本上各跑一次服务端试启动和候选来源的测试。'),
    command('cf-c3', 'gradle :v1_19:test --tests CandidateSourceTest'),
    command('cf-c4', 'gradle :v1_20:test --tests CandidateSourceTest'),
    command('cf-c5', 'gradle :v1_21:test --tests CandidateSourceTest'),
    assistant('cf-a5', '三个版本都通过了：随机来源关闭时不记录，开启后只记录识别出的物品。'),
    stats('cf-s2', 'completed', usage(96_000)),
  ]),
  'demo-codex-flow-running': snapshot(
    runningRecord,
    [
      ...firstTurn('cr', 20),
      user('cr-u2', '三个版本都验证一下', 2),
      reasoning(
        'cr-r3',
        '**Validating candidate sources across versions**\n\nRun the dry-run server and the source tests for each version.',
      ),
      assistant('cr-a4', '我在三个版本上各跑一次服务端试启动和候选来源的测试。'),
      command('cr-c3', 'gradle :v1_20:runServer --dry-run'),
      command('cr-c4', 'gradle :v1_21:test --tests CandidateSourceTest', 'running'),
    ],
    { state: 'running' },
  ),
}
