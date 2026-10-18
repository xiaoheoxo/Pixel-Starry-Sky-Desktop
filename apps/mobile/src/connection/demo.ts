// 演示模式（只在 vite dev 里有，正式构建会整个去掉）：地址加 ?demo 就不连真电脑，用这里的假数据，
// 用来截图看界面（浅色 / 深色、手机 / 平板）。?demo=approval 时第一个会话挂着一个审批。
import {
  emptySnapshot,
  type Item,
  type ProjectRecord,
  type SessionRecord,
  type SessionSummary,
} from '@pixelsky/protocol'
import type { Hello, LinkHooks, LinkState } from './link'
import type { Pairing } from './storage'

export const DEMO_PAIRING: Pairing = {
  deviceId: 'demo-device',
  desktopId: 'demo-desktop',
  desktopName: '演示电脑',
  // 演示用的随机密钥，不对应任何真设备
  desktopKey: 'ab81YO0pXc4u3VX4o7zxC5ILCt7-02ACp3FiU3kmKhU',
  phoneKey: 'ab81YO0pXc4u3VX4o7zxC5ILCt7-02ACp3FiU3kmKhU',
  token: 'psd_demo',
  relay: '',
  fingerprint: '1A2B 3C4D',
  status: 'paired',
  pairedAt: 0,
}

export const demoEnabled = (): boolean =>
  import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).has('demo')

const now = Date.now()
const min = 60_000

const projects: ProjectRecord[] = [
  { id: 'p1', name: '像素星空桌面版', path: 'D:/PixelSky', createdAt: now - 90 * 86400_000 },
  { id: 'p2', name: '官网', path: 'D:/site', createdAt: now - 30 * 86400_000 },
  { id: 'p3', name: '数据脚本', path: 'D:/scripts', createdAt: now - 10 * 86400_000 },
] as unknown as ProjectRecord[]

function record(id: string, title: string, projectId: string, minutesAgo: number, extra: Partial<SessionRecord> = {}) {
  return {
    id,
    projectId,
    cwd: 'D:/PixelSky',
    engine: 'claude',
    engineSessionId: null,
    title,
    createdAt: now - minutesAgo * min - 3600_000,
    updatedAt: now - minutesAgo * min,
    lastOutcome: 'completed',
    lastError: null,
    model: 'claude-sonnet-4-5',
    effort: 'medium',
    permissionMode: 'ask',
    ultracode: false,
    fast: false,
    thinkingSummaries: true,
    archivedAt: null,
    pinnedAt: null,
    ...extra,
  } as SessionRecord
}

const sessions: SessionSummary[] = [
  {
    record: record('s1', '修复浅色模式下代码块看不清', 'p1', 2, {
      lastReply: '测试都过了。接下来要提交这两处改动，需要你允许运行 git commit。',
    }),
    state: 'waiting',
  },
  { record: record('s2', '给设置页加搜索框', 'p1', 1, { lastOutcome: null }), state: 'running' },
  {
    record: record('s3', '官网首页改成深色主题，并把下载按钮放大一点', 'p2', 1, { engine: 'codex', lastOutcome: null }),
    state: 'running',
    queue: { queued: 2, failed: 0, paused: false },
  },
  {
    record: record('s4', '整理上周的用户反馈，按模块分类', 'p1', 25, {
      pinnedAt: now - 3 * 24 * 3600_000,
      lastReply: '一共 37 条，按模块分成 6 类，最多的是同步（11 条）。表格放在 feedback.md 里了。',
    }),
    state: 'idle',
  },
  {
    record: record('s5', '跑一遍数据清洗脚本', 'p3', 48, {
      lastOutcome: 'failed',
      lastError: 'ModuleNotFoundError: pandas',
      lastReply: '脚本跑到第二步失败了：没装 pandas。',
    }),
    state: 'idle',
  },
  {
    record: record('s6', '写发布说明 0.4.11', 'p1', 180, {
      lastReply: '发布说明写好了，分新功能、修复两节，放在 CHANGELOG 最上面。',
    }),
    state: 'idle',
  },
  {
    record: record('s7', '检查依赖有没有安全漏洞', 'p1', 60 * 26, {
      engine: 'codex',
      lastReply: '没有高危漏洞；有 2 个中危，都在开发依赖里，不影响发布。',
    }),
    state: 'idle',
  },
  {
    record: record('s8', '把图片压缩脚本改成并行', 'p3', 60 * 50, {
      lastReply: '改成 4 个进程并行后，1200 张图从 9 分钟降到 2 分半。',
    }),
    state: 'idle',
  },
  {
    record: record('s9', '首页的动画在 Safari 上卡顿', 'p2', 60 * 72, {
      lastReply: '原因是 filter: blur 在 Safari 上不走 GPU，换成预先模糊的图片就不卡了。',
    }),
    state: 'idle',
  },
]

const md = `好的，问题出在 \`tokens.css\` 里浅色主题的代码块底色和文字颜色对比度不够。我改了这几处：

1. 代码块底色从 \`#f7f5f0\` 调成 \`#f1efe9\`，和聊天底色拉开距离；
2. 行内代码换成暖红色，**加粗**也能看清；
3. 表格加了横向滚动。

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| 代码块底色 | #f7f5f0 | #f1efe9 |
| 注释颜色 | #a3a39b | #8b8a82 |

\`\`\`ts
export function applyTheme(pref: ThemePreference): void {
  const resolved = pref === 'system' ? (dark() ? 'dark' : 'light') : pref
  document.documentElement.dataset.theme = resolved // 写到 <html>
}
\`\`\`

> 深色模式没有受影响，我也截图核对过了。

要我顺便把 diff 的红绿色也调一下吗？`

const items: Item[] = [
  { kind: 'user', id: 'u1', text: '浅色模式下代码块看不清，帮我查一下', createdAt: now - 40 * min },
  { kind: 'reasoning', id: 'r1', text: '先看 tokens.css 的浅色变量……', status: 'completed', durationMs: 4200 },
  {
    kind: 'command',
    id: 'c1',
    command: 'rg -n "bg-code" apps/mobile/src',
    description: '找代码块用到的颜色',
    output: 'apps/mobile/src/ui/code.tsx:12: bg-code\n',
    exitCode: 0,
    status: 'completed',
  },
  {
    kind: 'tool',
    id: 't1',
    tool: 'read',
    name: 'Read',
    title: 'apps/mobile/src/styles/tokens.css',
    output: '…',
    status: 'completed',
  },
  {
    kind: 'file_change',
    id: 'f1',
    changes: [
      {
        path: 'apps/mobile/src/styles/tokens.css',
        kind: 'update',
        diff: '@@ -20,3 +20,3 @@\n   --bg-chat: #f7f5f0;\n-  --bg-code: #f7f5f0;\n+  --bg-code: #f1efe9;\n   --text: #20211f;',
        added: 1,
        removed: 1,
      },
      { path: 'apps/mobile/src/ui/Markdown.tsx', kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b', added: 12, removed: 3 },
    ],
    status: 'completed',
  },
  { kind: 'assistant', id: 'a1', text: md, status: 'completed' },
  { kind: 'user', id: 'u2', text: '好，diff 的颜色也调一下，然后跑一遍测试', createdAt: now - 5 * min },
  {
    kind: 'todo',
    id: 'td1',
    steps: [
      { text: '调 diff 的红绿色', status: 'completed' },
      { text: '跑手机端测试', status: 'in_progress' },
      { text: '截图核对浅色 / 深色', status: 'pending' },
    ],
    status: 'in_progress',
  },
  {
    kind: 'command',
    id: 'c2',
    command: 'pnpm --filter @pixelsky/mobile test',
    description: '跑手机端测试',
    output: 'Test Files  15 passed (15)\n     Tests  82 passed (82)',
    exitCode: 0,
    status: 'completed',
  },
  { kind: 'notice', id: 'n1', level: 'warn', text: '有 1 个测试跑得比较慢（3.2 秒）' },
  {
    kind: 'assistant',
    id: 'a2',
    text: '测试都过了。接下来要提交这两处改动，需要你允许运行 `git commit`。',
    status: 'completed',
  },
] as Item[]

function tail(sessionId: string) {
  const summary = sessions.find(s => s.record.id === sessionId) ?? sessions[0]
  const snapshot = emptySnapshot(summary.record, sessionId === 's1' ? items : items.slice(0, 6))
  snapshot.state = summary.state
  if (summary.state === 'running') snapshot.turnId = 'turn-1'
  if (sessionId === 's1' && new URLSearchParams(location.search).get('demo') === 'approval')
    snapshot.pending = [
      {
        requestId: 'req1',
        itemId: null,
        kind: 'command',
        title: '运行命令',
        command: 'git commit -am "浅色模式：代码块和 diff 的颜色"',
        description: '提交这两处改动',
        alwaysScopes: ['session', 'project'],
      },
    ]
  return { snapshot, seq: 1, before: null, truncated: [], total: snapshot.items.length }
}

const change = (path: string, code: string) => ({ path, origPath: null, code, local: path, submodule: false })

/** 假的电脑连接：和 DesktopLink 一样的对外样子，call 直接回假数据 */
export class DemoLink {
  state: LinkState = 'ready'
  hello: Hello = { version: 1, name: '演示电脑', access: 'act', tools: true, queueMoveBefore: true }

  constructor(
    readonly pairing: Pairing,
    private readonly hooks: LinkHooks,
  ) {}

  start(): void {
    this.hooks.onState(this.state)
  }
  stop(): void {}
  wake(): void {}
  away(): void {}

  async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    await new Promise(r => setTimeout(r, 120))
    const reply = (value: unknown) => value as T
    switch (method) {
      case 'hello':
        return reply(this.hello)
      case 'engine:sessions':
        return reply(sessions)
      case 'engine:projects':
        return reply(projects)
      case 'engine:openSessionTail':
        return reply(tail(String(args[0])))
      case 'defaults':
        return reply({ engine: 'claude' })
      case 'search':
        return reply({ results: [], truncated: false })
      case 'engine:catalog':
        return reply({
          models: [
            {
              id: 'claude-opus-4-1',
              label: 'Opus 4.1',
              description: '最强，适合难题',
              efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
              defaultEffort: 'high',
              isDefault: false,
            },
            {
              id: 'claude-sonnet-4-5',
              label: 'Sonnet 4.5',
              description: '日常写代码',
              efforts: ['low', 'medium', 'high'],
              defaultEffort: 'medium',
              isDefault: true,
            },
            {
              id: 'claude-haiku-4-5',
              label: 'Haiku 4.5',
              description: '快、便宜',
              efforts: [],
              defaultEffort: null,
              isDefault: false,
            },
          ],
          outputStyles: [],
        })
      case 'projectTools:gitStatus':
        return reply({
          repo: true,
          missing: false,
          root: 'D:/PixelSky',
          branch: 'main',
          detached: false,
          head: '2345bb2',
          initial: false,
          upstream: 'origin/main',
          ahead: 1,
          behind: 0,
          remotes: ['origin'],
          staged: [change('apps/mobile/src/ui/Markdown.tsx', 'M')],
          unstaged: [change('apps/mobile/src/styles/tokens.css', 'M')],
          untracked: [change('apps/mobile/src/connection/demo.ts', '?')],
          conflicted: [],
          truncated: false,
          operation: null,
          fetchedAt: now - 10 * min,
          busySessions: 1,
        })
      case 'files:list':
        return reply({
          entries: [
            { name: 'apps', kind: 'dir' },
            { name: 'README.md', kind: 'file' },
          ],
        })
      default:
        return reply(null)
    }
  }
}
