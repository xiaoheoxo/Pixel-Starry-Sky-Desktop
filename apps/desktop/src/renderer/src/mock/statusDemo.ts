// 侧栏对话状态图标的演示数据（docs/ui/sidebar-status-icons.md）：每种状态一个对话——等你回答 / 登录失效 / 找不到模型 / 繁忙 /
// 一般出错 / 工作文件夹没了 / PR 的各种样子。「等你批准」「余额不足」「暂停」用 workbench.ts 里原有的三个对话。
import type { Item, SessionRecord, SessionSnapshot } from '@pixelsky/protocol'
import type { Project } from '@/data/types'
import type { InboxItem } from '@/features/panel/inbox/inboxModel'
import type { SessionStatusState, SessionPr } from '../../../shared/types/session-status'
import { MIN, T0, assistant, failed, sessionRecord, snapshot, stats, user } from './conversations'

const now = Date.now()
const DAY = 24 * 60 * MIN

export const STATUS_PROBLEM_PROJECT = 'pixel-alerts'
export const STATUS_PR_PROJECT = 'pixel-prs'

interface Problem {
  id: string
  title: string
  time?: string
  /** 工作文件夹没了 / PR 有冲突（对话本身空闲）、等你回答、出错 */
  kind: 'folder' | 'conflict' | 'question' | 'error'
  error?: string
}

// 文件夹没了、PR 有冲突的排在前面：它们是空闲的对话，排在第 5 个以后会被收进「还有 N 个对话」
const PROBLEMS: Problem[] = [
  { id: 's-st-folder', title: '迁移旧的构建脚本', time: '2天', kind: 'folder' },
  { id: 's-st-conflict', title: '同步 release 分支的改动', time: '1时', kind: 'conflict' },
  { id: 's-st-question', title: '登录页要不要拆成两步', kind: 'question' },
  { id: 's-st-auth', title: '导出本周的用量报表', kind: 'error', error: '登录已失效，请重新登录' },
  { id: 's-st-route', title: '用新模型重写测试', kind: 'error', error: '找不到所选模型 claude-opus-9，请换一条线路' },
  { id: 's-st-busy', title: '批量重命名组件文件', kind: 'error', error: '请求太频繁（429），请稍后再试' },
  { id: 's-st-error', title: '升级依赖到最新版', kind: 'error', error: '子进程意外退出（代码 1）' },
]

type PrFields = Omit<SessionPr, 'repo' | 'url' | 'head' | 'base' | 'closedAt'> & { closedAt?: string | null }

const iso = (ago: number): string => new Date(now - ago).toISOString()
const PRS: Array<{ id: string; title: string; pr: PrFields }> = [
  {
    id: 's-st-pr-open',
    title: '给导出加 CSV 选项',
    pr: {
      number: 412,
      title: '导出支持 CSV',
      state: 'open',
      ci: 'pass',
      ciFailed: 0,
      conflict: false,
      additions: 86,
      deletions: 12,
    },
  },
  {
    id: 's-st-pr-draft',
    title: '试一下新的缓存策略',
    pr: {
      number: 418,
      title: '[WIP] 新的缓存策略',
      state: 'draft',
      ci: 'pending',
      ciFailed: 0,
      conflict: false,
      additions: 240,
      deletions: 31,
    },
  },
  {
    id: 's-st-pr-merged',
    title: '修复侧栏闪烁',
    pr: {
      number: 405,
      title: '修复侧栏切换时的闪烁',
      state: 'merged',
      ci: 'pass',
      ciFailed: 0,
      conflict: false,
      additions: 14,
      deletions: 6,
      closedAt: iso(3 * 60 * MIN),
    },
  },
  {
    id: 's-st-pr-closed',
    title: '拆分设置页路由',
    pr: {
      number: 398,
      title: '拆分设置页路由',
      state: 'closed',
      ci: null,
      ciFailed: 0,
      conflict: false,
      additions: 120,
      deletions: 88,
      closedAt: iso(2 * DAY),
    },
  },
  {
    id: 's-st-pr-ci',
    title: '升级 Electron 到新版',
    pr: {
      number: 421,
      title: '升级 Electron',
      state: 'open',
      ci: 'fail',
      ciFailed: 2,
      conflict: false,
      additions: 9,
      deletions: 9,
    },
  },
]

const full = (pr: PrFields, head: string): SessionPr => ({
  repo: 'pixelsky/pixel-web',
  url: `https://github.com/pixelsky/pixel-web/pull/${pr.number}`,
  head,
  base: 'main',
  closedAt: null,
  ...pr,
})

export const statusDemoSessionState: SessionStatusState = {
  missingFolders: { 's-st-folder': true },
  prs: {
    's-st-conflict': [
      full(
        {
          number: 417,
          title: '同步 release 分支的改动',
          state: 'open',
          ci: 'pass',
          ciFailed: 0,
          conflict: true,
          additions: 33,
          deletions: 4,
        },
        'sync/release',
      ),
    ],
    ...Object.fromEntries(PRS.map(p => [p.id, [full(p.pr, `feat/${p.id.slice(5)}`)]])),
    // 有快照的对话：概况的 PR 分组和「要处理」里的冲突（docs/ui/session-overview-mockup.html）
    'demo-claude-running': [
      full(
        {
          number: 128,
          title: '草稿存储：写满时提示并保留内容',
          state: 'open',
          ci: null,
          ciFailed: 0,
          conflict: true,
          additions: 128,
          deletions: 34,
        },
        'feat/drafts',
      ),
    ],
    // 出问题的对话也有 PR：问题卡下面附一行，点「查看 PR」切过去
    's-st-busy': [
      full(
        {
          number: 415,
          title: '组件文件统一用 PascalCase',
          state: 'open',
          ci: 'pending',
          ciFailed: 0,
          conflict: false,
          additions: 48,
          deletions: 48,
        },
        'chore/rename-components',
      ),
    ],
    // 一个对话建了好几个 PR：卡里列 3 个，其余折叠
    's-st-pr-open': [
      full(PRS[0].pr, 'feat/pr-open'),
      ...[409, 407, 404, 401].map((number, i) =>
        full(
          {
            number,
            title: ['导出加进度条', '导出文件名带日期', '导出时去掉空行', '导出按钮挪到工具栏'][i],
            state: i < 1 ? 'open' : 'merged',
            ci: 'pass',
            ciFailed: 0,
            conflict: false,
            additions: 10 + i * 7,
            deletions: 2 + i,
            closedAt: i < 1 ? null : iso((i + 1) * 60 * MIN),
          },
          `feat/export-${number}`,
        ),
      ),
    ],
    // 最近任务里的「频道话题支持引用回复」：原来演示数据里 hasPr 的那条
    'r-channel-quote': [
      full(
        {
          number: 389,
          title: '频道话题支持引用回复',
          state: 'open',
          ci: 'pass',
          ciFailed: 0,
          conflict: false,
          additions: 142,
          deletions: 20,
        },
        'feat/quote-reply',
      ),
    ],
  },
  // 对话里只是提到的 PR（看别人仓库的发布说明时出现的链接）：不出图标，卡里折叠列出
  mentioned: {
    's-st-pr-merged': [11233, 11230, 11183, 11173, 10730, 11016, 11150].map(
      n => `https://github.com/earendil-works/pi/pull/${n}`,
    ),
  },
  gh: 'ready',
}

export const statusDemoProjects: Project[] = [
  {
    id: STATUS_PROBLEM_PROJECT,
    name: STATUS_PROBLEM_PROJECT,
    expanded: true,
    sessions: PROBLEMS.map(p => ({ id: p.id, title: p.title, status: 'idle' as const, time: p.time })),
  },
  {
    id: STATUS_PR_PROJECT,
    name: STATUS_PR_PROJECT,
    expanded: true,
    sessions: PRS.map(p => ({ id: p.id, title: p.title, status: 'idle' as const, time: '1天' })),
  },
]

export const statusDemoInbox: InboxItem[] = [
  {
    sessionId: 's-st-question',
    title: '登录页要不要拆成两步',
    project: STATUS_PROBLEM_PROJECT,
    lane: 'waiting',
    at: now - 4 * MIN,
    error: null,
    queue: null,
    signature: 'demo-st-q',
    request: {
      requestId: 'demo-st-req',
      itemId: null,
      kind: 'question',
      title: '需要你确认',
      alwaysScopes: [],
      questions: [
        {
          header: '登录页',
          question: '登录页拆成「账号」「验证码」两步，还是保持一页？',
          multiSelect: false,
          options: [
            { label: '拆成两步', description: '先填账号，再收验证码' },
            { label: '保持一页', description: '改动最小' },
          ],
        },
      ],
    },
  },
  ...PROBLEMS.filter(p => p.error).map(
    (p, i): InboxItem => ({
      sessionId: p.id,
      title: p.title,
      project: STATUS_PROBLEM_PROJECT,
      lane: 'failed',
      at: now - (20 + i * 7) * MIN,
      request: null,
      error: p.error!,
      queue: null,
      signature: `demo-st-f${i}`,
    }),
  ),
]

const record = (id: string, title: string, project: string, patch: Partial<SessionRecord> = {}): SessionRecord =>
  sessionRecord(id, title, project, { updatedAt: T0 - 30 * MIN, ...patch })

const done = (id: string, title: string, project: string): SessionSnapshot =>
  snapshot(record(id, title, project), [
    user(`${id}-u`, title, 90),
    assistant(`${id}-a`, '做好了，改动已经提交到当前分支。'),
    stats(`${id}-s`, 'completed', { durationMs: 38_000, models: {} }),
  ])

function problem(p: Problem): SessionSnapshot {
  const rec = (patch: Partial<SessionRecord> = {}) => record(p.id, p.title, STATUS_PROBLEM_PROJECT, patch)
  if (p.kind === 'question') {
    const request = statusDemoInbox.find(i => i.sessionId === p.id)!.request!
    return snapshot(
      rec({ updatedAt: T0 - 4 * MIN }),
      [user(`${p.id}-u`, p.title, 6), assistant(`${p.id}-a`, '有个取舍想先问你。')],
      { state: 'waiting', turnId: `${p.id}-turn`, pending: [request] },
    )
  }
  if (p.kind === 'error') {
    const items: Item[] = [
      user(`${p.id}-u`, p.title, 25),
      { kind: 'notice', id: `${p.id}-n`, level: 'error', text: p.error!, detail: p.error! },
      failed(`${p.id}-s`),
    ]
    return snapshot(rec({ lastOutcome: 'failed', lastError: p.error!, updatedAt: T0 - 20 * MIN }), items)
  }
  return done(p.id, p.title, STATUS_PROBLEM_PROJECT)
}

export const statusDemoSnapshots: Record<string, SessionSnapshot> = Object.fromEntries(
  [...PROBLEMS.map(problem), ...PRS.map(p => done(p.id, p.title, STATUS_PR_PROJECT))].map(s => [s.record.id, s]),
)
