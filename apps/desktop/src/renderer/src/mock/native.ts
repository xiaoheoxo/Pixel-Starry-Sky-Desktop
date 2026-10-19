// 演示模式里「接着终端里的 Claude Code / Codex 会话」（docs/ui/claude-resume.md、codex-resume.md）：每个引擎几行，覆盖选择框的各种状态。
// 第一步的列表里最后一句和模型是空的，第二步（details）才补上，演示逐步补的样子；导入只是跳到一个现成的展示对话
import type { NativeImportResult, NativeSessionDetail, NativeSessionSummary } from '@pixelsky/protocol'
import type { DemoSource } from '@/data/demo'
import { assistant, sessionRecord, snapshot, stats, user, T0, opus, SHOWCASE_PROJECT } from './conversations'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

type Row = Omit<NativeSessionSummary, 'updatedAt'> & { ago: number; last: string }

const CLAUDE_ROWS: Row[] = [
  {
    id: '3f1c2a10-6d7e-4b88-9a31-0c5d8e7a1001',
    title: '修复 Caddy 超时',
    firstPrompt: '测试站上传大文件会 499，帮我看一下 Caddy 的超时',
    lastPrompt: null,
    branch: 'main',
    subdir: null,
    size: 4_800_000,
    model: null,
    source: 'terminal',
    ownerId: null,
    live: null,
    ago: 12 * MIN,
    last: '部署后再看一下 499 还有没有',
  },
  {
    id: '3f1c2a10-6d7e-4b88-9a31-0c5d8e7a1002',
    title: '调手机端布局',
    firstPrompt: '手机端底部输入框被键盘顶起来了',
    lastPrompt: null,
    branch: 'main',
    subdir: 'apps/mobile',
    size: 1_200_000,
    model: null,
    source: 'terminal',
    ownerId: null,
    live: null,
    ago: 4 * DAY,
    last: '再截一张图',
  },
  {
    id: '3f1c2a10-6d7e-4b88-9a31-0c5d8e7a1003',
    title: '规划 /resume',
    firstPrompt: '规划一下怎么在像素星空里接着终端里的 Claude Code 会话',
    lastPrompt: null,
    branch: 'main',
    subdir: null,
    size: 23_000_000,
    model: null,
    source: 'terminal',
    // 已被像素星空的对话占用：点了跳到那个对话
    ownerId: 'demo-claude-tools',
    live: null,
    ago: 2 * HOUR,
    last: '先出规划',
  },
  {
    id: '3f1c2a10-6d7e-4b88-9a31-0c5d8e7a1004',
    title: '发布 0.4.7',
    firstPrompt: '把版本改成 0.4.7-beta，更新说明改名',
    lastPrompt: null,
    branch: 'release/0.4.7',
    subdir: null,
    size: 9_500_000,
    model: null,
    source: 'terminal',
    ownerId: null,
    live: 'terminal',
    ago: 40_000,
    last: '检查一下 CI 有没有过',
  },
  {
    id: '3f1c2a10-6d7e-4b88-9a31-0c5d8e7a1005',
    title: '整理 CC-Panes 项目清单',
    firstPrompt: '把 .ccpanes/projects.csv 里失效的目录去掉',
    lastPrompt: null,
    branch: 'main',
    subdir: null,
    size: 600_000,
    model: null,
    source: 'other',
    ownerId: null,
    live: 'other',
    ago: 3 * MIN,
    last: '好了，帮我提交',
  },
  {
    id: '3f1c2a10-6d7e-4b88-9a31-0c5d8e7a1006',
    title: '重构 extpacks 校验',
    firstPrompt: '扩展包的校验逻辑太散了，抽成一个模块',
    lastPrompt: null,
    branch: 'HEAD',
    subdir: null,
    size: 221 * 1024 * 1024,
    model: null,
    source: 'other',
    ownerId: null,
    live: null,
    ago: 3 * DAY,
    last: '跑一下全量检查',
  },
  {
    id: '3f1c2a10-6d7e-4b88-9a31-0c5d8e7a1007',
    title: '调试模型菜单',
    firstPrompt: '模型菜单里 Opus 不显示',
    lastPrompt: null,
    branch: 'main',
    subdir: null,
    size: 2_100_000,
    model: null,
    source: 'other',
    ownerId: null,
    // 读不到 pid 登记、只看记录修改时间：可能还开着
    live: 'maybe',
    ago: 90_000,
    last: '再试一次',
  },
]

const cid = (n: number): string => `0199c2a1-7b3e-7c40-8a1d-5e2f9b0c300${n}`

// Codex 的 6 行：普通、子文件夹、已在像素星空里、终端里正开着、可能还开着、其他程序（没有「很大」的一行：Codex 不按文件大小读）
const CODEX_ROWS: Row[] = [
  {
    id: cid(1),
    title: '给设置页加深色模式开关',
    firstPrompt: '设置里加一个深色模式开关，跟随系统',
    lastPrompt: null,
    branch: 'main',
    subdir: null,
    size: 1_800_000,
    model: 'gpt-5-codex',
    source: 'terminal',
    ownerId: null,
    live: null,
    ago: 25 * MIN,
    last: '再把切换动画去掉',
  },
  {
    id: cid(2),
    title: '修手机端登录跳转',
    firstPrompt: '手机端登录后没有跳回原页面',
    lastPrompt: null,
    branch: 'fix/m-login',
    subdir: 'apps/mobile',
    size: 900_000,
    model: 'gpt-5',
    source: 'terminal',
    ownerId: null,
    live: null,
    ago: 2 * DAY,
    last: '跑一下手机端的测试',
  },
  {
    id: cid(3),
    title: '梳理引擎适配器接口',
    firstPrompt: '把 Codex 适配器和 Claude 适配器的接口差异列出来',
    lastPrompt: null,
    branch: 'main',
    subdir: null,
    size: 5_200_000,
    model: 'gpt-5-mini',
    source: 'terminal',
    // 已被像素星空的对话占用：点了跳到那个对话
    ownerId: 'demo-claude-tools',
    live: null,
    ago: 3 * HOUR,
    last: '写成一张对照表',
  },
  {
    id: cid(4),
    title: '排查 app-server 启动慢',
    firstPrompt: 'codex app-server 第一次起要一秒多，看看卡在哪',
    lastPrompt: null,
    branch: 'main',
    subdir: null,
    size: 3_100_000,
    model: 'gpt-5-codex',
    source: 'terminal',
    ownerId: null,
    live: 'terminal',
    ago: 30_000,
    last: '加一条耗时日志',
  },
  {
    id: cid(5),
    title: '整理发布说明',
    firstPrompt: '把这周的提交整理成发布说明',
    lastPrompt: null,
    branch: 'release/0.4.8',
    subdir: null,
    size: 700_000,
    model: 'gpt-5',
    source: 'terminal',
    ownerId: null,
    // 锁文件在、但测不了有没有被占着（只有 macOS / Linux 会出现）：可能还开着
    live: 'maybe',
    ago: 100_000,
    last: '把英文版也出一份',
  },
  {
    id: cid(6),
    title: '批量改名 i18n 键',
    firstPrompt: '把 resume.* 的键按引擎拆开',
    lastPrompt: null,
    branch: 'HEAD',
    subdir: null,
    size: 1_500_000,
    model: 'gpt-5-mini',
    source: 'other',
    ownerId: null,
    live: null,
    ago: 5 * DAY,
    last: '跑一下 i18n 测试',
  },
]

const ROWS: Record<'claude' | 'codex', Row[]> = { claude: CLAUDE_ROWS, codex: CODEX_ROWS }
const MODELS: Record<'claude' | 'codex', string[]> = {
  claude: ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
  codex: ['gpt-5-codex', 'gpt-5', 'gpt-5-mini'],
}

export const demoNativeSessions: DemoSource['conversations']['nativeSessions'] = {
  list: (_projectId, engine = 'claude') => {
    const now = Date.now()
    return ROWS[engine].map(({ ago, last: _last, ...row }) => ({ ...row, updatedAt: now - ago }))
  },
  details: (ids, engine = 'claude') => {
    const now = Date.now()
    return ids.flatMap<NativeSessionDetail>(id => {
      const index = ROWS[engine].findIndex(r => r.id === id)
      const row = ROWS[engine][index]
      if (!row) return []
      return [
        {
          id,
          lastPrompt: row.last,
          title: row.title,
          lastActive: now - row.ago,
          model: MODELS[engine][index % MODELS[engine].length],
          branch: row.branch,
          superseded: false,
          skipped: false,
        },
      ]
    })
  },
  import: (nativeId, mode, engine = 'claude'): NativeImportResult => {
    const row = ROWS[engine].find(r => r.id === nativeId)
    if (row?.ownerId) return { ownerId: row.ownerId }
    if (mode === 'inplace' && (row?.live === 'terminal' || row?.live === 'other')) return { live: row.live }
    // Codex 的导入跳到 Codex 的展示对话（分隔条、执行者都是 Codex），不混进 Claude 的
    if (engine === 'codex') return { sessionId: DEMO_CODEX_RESUME_ID, model: MODELS.codex[0], turns: 3, shown: 3 }
    return { sessionId: 'demo-claude-long', model: MODELS[engine][0], turns: 120, shown: 50 }
  },
}

// ---------- 导入 Codex 会话后跳到的展示对话 ----------

export const DEMO_CODEX_RESUME_ID = 'demo-codex-resume'

const codexResumeRecord = sessionRecord(DEMO_CODEX_RESUME_ID, '给设置页加深色模式开关', SHOWCASE_PROJECT, {
  engine: 'codex',
  engineSessionId: CODEX_ROWS[0].id,
  model: 'gpt-5-codex',
  imported: { engine: 'codex', sessionId: CODEX_ROWS[0].id, at: T0 - 5 * MIN, turns: 3, shown: 3, source: 'terminal' },
})

/** 合进 mock/index.ts 的 conversations.snapshots */
export const codexResumeSnapshots = {
  [DEMO_CODEX_RESUME_ID]: snapshot(codexResumeRecord, [
    { kind: 'notice', id: 'cr-n1', level: 'info', text: '接着终端里的 Codex 会话 · 3 轮' },
    user('cr-u1', '设置里加一个深色模式开关，跟随系统', 40),
    assistant('cr-a1', '加好了：开关在「外观」里，默认跟随系统。'),
    stats('cr-s1', 'completed', { durationMs: 9_000, models: { 'gpt-5-codex': opus(900, 320, 0.02) } }),
    user('cr-u2', '再把切换动画去掉', 25),
    assistant('cr-a2', '去掉了，切换时直接换色。'),
    stats('cr-s2', 'completed', { durationMs: 6_000, models: { 'gpt-5-codex': opus(700, 210, 0.01) } }),
  ]),
}
