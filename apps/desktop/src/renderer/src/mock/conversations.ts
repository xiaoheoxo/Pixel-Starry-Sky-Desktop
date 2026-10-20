// 演示模式里的 Claude 对话展示（docs/ui/demo-conversation.md）：和主进程给界面的会话快照同形，
// 打开这些会话时用真实对话组件显示。一个会话一种状态（空闲 / 运行中 / 正在启动 / 等审批），按内容分开。
// 工具名、审批标题、报错说法照 packages/engine/src/claude 里的写法。
import type {
  AgentRun,
  ApprovalRequest,
  CompactionProgress,
  FileChange,
  ImageAttachment,
  Item,
  QueuedMessage,
  SessionRecord,
  SessionSnapshot,
  TaskOutput,
  TurnUsage,
} from '@pixelsky/protocol'
import type { DemoUpdate } from '@/data/demo'

export const SHOWCASE_PROJECT = 'claude-showcase'

/** 侧栏里的顺序和标题（mock/demo.ts 用） */
export const SHOWCASE_SESSIONS = [
  { id: 'demo-claude-markdown', title: '回复格式：Markdown 全部样式' },
  { id: 'demo-claude-tools', title: '工具调用：命令、文件、搜索、子智能体' },
  { id: 'demo-claude-user', title: '用户消息：图片、引用文件、长消息、引导' },
  { id: 'demo-claude-errors', title: '报错：自有额度' },
  { id: 'demo-claude-platform', title: '报错：平台余额不足' },
  { id: 'demo-claude-send-failed', title: '报错：发送失败（消息队列）' },
  { id: 'demo-claude-running', title: '运行中：进度卡片、后台任务、重试' },
  { id: 'demo-claude-compacting', title: '运行中：压缩上下文（循环播放）' },
  { id: 'demo-claude-steps', title: '运行中：当前步骤（循环播放）' },
  { id: 'demo-claude-compactions', title: '压缩上下文：各种结果' },
  { id: 'demo-claude-starting', title: '正在启动引擎' },
  { id: 'demo-claude-approve-command', title: '审批：运行命令' },
  { id: 'demo-claude-approve-file', title: '审批：修改文件' },
  { id: 'demo-claude-approve-tool', title: '审批：使用 MCP 工具' },
  { id: 'demo-claude-approve-many', title: '审批：同时几项（合并成列表）' },
  { id: 'demo-claude-question', title: '提问：单选和多选' },
  { id: 'demo-claude-plan', title: '计划确认' },
  { id: 'demo-claude-long', title: '长对话：轮次跳转（30 轮）' },
  { id: 'demo-claude-long-120', title: '长对话：只显示最近 20 轮（120 轮）' },
  { id: 'demo-claude-subagents', title: '后台子智能体：改动按子智能体分组' },
  { id: 'demo-claude-subagent-stop', title: '停止：连同后台子智能体' },
  { id: 'demo-claude-subagent-kept', title: '停止：后台子智能体继续运行' },
] as const

type SessionId = (typeof SHOWCASE_SESSIONS)[number]['id']

export const T0 = Date.now()
export const MIN = 60_000
const F = '```'

/** 展示里用到的文件；mock/files.ts 合进演示文件列表，路径链接和改动卡片点得开 */
export const SHOWCASE_FILES: Record<string, string> = {
  'src/session/useDraft.ts': [
    "import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'",
    '',
    '/** 每个会话一份草稿：内存里立即生效，停顿 300ms 后写进 localStorage */',
    'const memory = new Map<string, string>()',
    'const listeners = new Set<() => void>()',
    '',
    'export function draftKey(sessionId: string): string {',
    '  return `draft:${sessionId}`',
    '}',
    '',
    'function read(sessionId: string): string {',
    '  if (memory.has(sessionId)) return memory.get(sessionId)!',
    '  try {',
    "    return localStorage.getItem(draftKey(sessionId)) ?? ''",
    '  } catch {',
    "    return ''",
    '  }',
    '}',
    '',
    'function write(sessionId: string, text: string): void {',
    '  memory.set(sessionId, text)',
    '  for (const listener of listeners) listener()',
    '}',
    '',
    'export function clearDraft(sessionId: string): void {',
    '  memory.delete(sessionId)',
    '  try {',
    '    localStorage.removeItem(draftKey(sessionId))',
    '  } catch {',
    '    /* 隐私模式下 localStorage 不可用，只清内存 */',
    '  }',
    '  for (const listener of listeners) listener()',
    '}',
    '',
    'export function useDraft(sessionId: string): [string, (text: string) => void] {',
    '  const subscribe = useCallback((listener: () => void) => {',
    '    listeners.add(listener)',
    '    return () => listeners.delete(listener)',
    '  }, [])',
    '  const text = useSyncExternalStore(subscribe, () => read(sessionId))',
    '  const timer = useRef<number | undefined>(undefined)',
    '  useEffect(() => () => window.clearTimeout(timer.current), [])',
    '  const setText = useCallback(',
    '    (next: string) => {',
    '      write(sessionId, next)',
    '      window.clearTimeout(timer.current)',
    '      timer.current = window.setTimeout(() => {',
    '        try {',
    '          localStorage.setItem(draftKey(sessionId), next)',
    '        } catch {',
    '          /* 写满了：草稿只留在内存里 */',
    '        }',
    '      }, 300)',
    '    },',
    '    [sessionId],',
    '  )',
    '  return [text, setText]',
    '}',
    '',
  ].join('\n'),
  'src/session/__tests__/useDraft.test.ts': [
    "import { describe, expect, it, vi } from 'vitest'",
    "import { clearDraft, draftKey } from '../useDraft'",
    '',
    "describe('草稿', () => {",
    "  it('按会话分开存', () => {",
    "    expect(draftKey('a')).toBe('draft:a')",
    '  })',
    "  it('清掉时同时删 localStorage', () => {",
    "    const remove = vi.spyOn(Storage.prototype, 'removeItem')",
    "    clearDraft('a')",
    "    expect(remove).toHaveBeenCalledWith('draft:a')",
    '  })',
    '})',
    '',
  ].join('\n'),
  'src/session/SessionView.jsx': [
    "import { Composer } from './Composer'",
    '',
    'export function SessionView({ session }) {',
    '  return (',
    '    <main className="session">',
    '      <Composer sessionId={session.id} />',
    '    </main>',
    '  )',
    '}',
    '',
  ].join('\n'),
}

// ---------- 小工具 ----------

function record(id: SessionId, patch: Partial<SessionRecord> = {}): SessionRecord {
  return sessionRecord(id, SHOWCASE_SESSIONS.find(s => s.id === id)!.title, SHOWCASE_PROJECT, patch)
}

// ---------- 下面几个小工具 mock/workbench.ts 也用 ----------

export function sessionRecord(
  id: string,
  title: string,
  projectId: string,
  patch: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id,
    projectId,
    cwd: 'D:\\work\\pixel-web',
    engine: 'claude',
    engineSessionId: `8f1c2e7a-${id.slice(-4)}-4b1e-9c3d-2a6f0b7d91e4`,
    title,
    createdAt: T0 - 40 * MIN,
    updatedAt: T0 - 2 * MIN,
    lastOutcome: 'completed',
    lastError: null,
    archivedAt: null,
    titleEdited: true,
    platform: null,
    model: 'claude-opus-5-5',
    effort: 'high',
    permissionMode: 'edits',
    ultracode: false,
    fast: false,
    thinkingSummaries: true,
    ...patch,
  }
}

export function snapshot(rec: SessionRecord, items: Item[], patch: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    record: rec,
    state: 'idle',
    items,
    pending: [],
    usage: {
      inputTokens: 18_400,
      outputTokens: 6_200,
      cacheReadTokens: 412_000,
      cacheWriteTokens: 38_000,
      contextTokens: 64_000,
      contextWindow: 200_000,
      costUsd: 0.86,
    },
    flags: { ultracodeAvailable: true, fastAvailable: true, fastState: 'off', fastBlocked: null },
    tasks: [],
    subagents: [],
    runs: { workflows: [], agents: [] },
    suggestion: null,
    queue: [],
    queuePaused: false,
    execution: null,
    turnId: null,
    ...patch,
  }
}

export const user = (
  id: string,
  text: string,
  minutesAgo: number,
  extra: Partial<Extract<Item, { kind: 'user' }>> = {},
): Item => ({
  kind: 'user',
  id,
  text,
  createdAt: T0 - minutesAgo * MIN,
  ...extra,
})
export const assistant = (
  id: string,
  text: string,
  status: Extract<Item, { kind: 'assistant' }>['status'] = 'completed',
): Item => ({
  kind: 'assistant',
  id,
  text,
  status,
})
export const reasoning = (id: string, text: string): Item => ({ kind: 'reasoning', id, text, status: 'completed' })

export function stats(id: string, outcome: 'completed' | 'interrupted' | 'failed', usage: TurnUsage): Item {
  return { kind: 'turn_stats', id, turnId: `${id}-turn`, outcome, usage }
}

export const opus = (input: number, output: number, cost: number, requests = 1): TurnUsage['models'][string] => ({
  input,
  cacheRead: input * 24,
  cacheWrite: Math.round(input * 1.6),
  output,
  costUsd: cost,
  requests,
})

/** unified diff 的正文：行首 + / - / 空格，@@ 行照抄 */
export function change(path: string, kind: FileChange['kind'], lines: string[]): FileChange {
  return {
    path,
    kind,
    diff: lines.join('\n'),
    added: lines.filter(l => l.startsWith('+')).length,
    removed: lines.filter(l => l.startsWith('-')).length,
  }
}

const allAdded = (text: string): string[] => [
  `@@ -0,0 +1,${text.split('\n').length - 1} @@`,
  ...text
    .split('\n')
    .slice(0, -1)
    .map(l => '+' + l),
]

export const ESC = '\u001b['

// ---------- 1 回复格式 ----------

const MARKDOWN_REPLY = `## 草稿按会话保存

现在输入框的草稿只有一份，存在 \`src/session/Composer.jsx:4\` 的组件状态里，切换会话就丢了。改成按会话 id 存，读写都放进 [useDraft.ts](src/session/useDraft.ts#L35)，测试在 \`src/session/__tests__/useDraft.test.ts\`。

### 存在哪里

| 位置 | 存什么 | 什么时候清掉 |
| --- | --- | --- |
| 内存 | 当前会话的草稿 | 发送成功后 |
| \`localStorage\` | 所有会话的草稿（\`draft:<会话 id>\`） | 发送成功后、会话删除时 |
| 不存 | 图片附件 | — |

### 步骤

1. 抽出 \`useDraft(sessionId)\`，返回 \`[text, setText]\`
2. **输入时**写内存，*停顿 300ms* 后写 \`localStorage\`
3. 发送成功后删掉这条草稿
   - 失败时保留，方便重发
   - ~~发送前先清空~~（会丢内容，不这么做）

- [x] 读写函数
- [x] 切换会话时换草稿
- [ ] 会话删除时清理

> 两个窗口打开同一个会话时，后写的为准，不做合并。

> [!NOTE]
> 草稿只存在这台电脑上，不同步。

> [!TIP]
> 想清空所有草稿，在设置 › 数据里点「清除本机草稿」。

> [!IMPORTANT]
> 改完要跑一遍 \`npm test\`。

> [!WARNING]
> \`localStorage\` 每个站点大约 5MB，写满了会抛 \`QuotaExceededError\`。

> [!CAUTION]
> 不要把图片的 Base64 放进草稿，几张图就会占满。

### 大小估算

每个字按 UTF-16 存 2 字节，\\(n\\) 条草稿一共占

$$
S = \\sum_{i=1}^{n} 2 \\cdot \\mathrm{len}(d_i)
$$

一千条、每条 500 字也只有 \\(2 \\times 500 \\times 1000 = 10^6\\) 字节，约 1MB。

### 代码

键名：

${F}ts
export function draftKey(sessionId: string): string {
  return \`draft:\${sessionId}\`
}
${F}

存下来的样子：

${F}json
{ "draft:9f2c": "把输入框的草稿改成按会话保存", "draft:a71e": "" }
${F}

输入框获得焦点时的样式：

${F}css
.composer textarea:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
${F}

只跑草稿相关的测试：

${F}bash
npm test -- src/session --reporter=dot
${F}

完整的 \`useDraft.ts\`（超过 30 行，默认折叠）：

${F}ts
${SHOWCASE_FILES['src/session/useDraft.ts'].trimEnd()}
${F}

没有标语言的代码块：

${F}
draft:9f2c  41 字
draft:a71e   0 字
${F}

参考 React 文档的 [useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore)。

---

需要的话我接着把「会话删除时清理」也做了。`

const markdown = snapshot(record('demo-claude-markdown', { updatedAt: T0 - 3 * MIN }), [
  user('m-u1', '把草稿按会话保存的方案整理成一份说明，后面要给其他人看', 6),
  reasoning(
    'm-r1',
    '用户要一份能给别人看的说明。先确认 useDraft.ts 现在的写法，再按「存在哪里 → 步骤 → 注意事项 → 代码」组织，表格放存储位置，提示块放容易踩的坑。',
  ),
  {
    kind: 'tool',
    id: 'm-t1',
    tool: 'read',
    name: 'Read',
    title: 'src/session/useDraft.ts',
    output: numbered(SHOWCASE_FILES['src/session/useDraft.ts']),
    status: 'completed',
  },
  assistant('m-a1', MARKDOWN_REPLY),
  stats('m-s1', 'completed', { durationMs: 38_000, models: { 'claude-opus-5-5': opus(2_400, 1_850, 0.1162, 2) } }),
])

export function numbered(text: string): string {
  return text
    .split('\n')
    .slice(0, -1)
    .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)
    .join('\n')
}

// ---------- 2 工具调用 ----------

const COMPOSER_DIFF = change('src/session/Composer.jsx', 'update', [
  '@@ -1,3 +1,6 @@',
  '-export function Composer() {',
  '-  return <textarea placeholder="描述你要做的事" />',
  "+import { useDraft } from './useDraft'",
  '+',
  '+export function Composer({ sessionId }) {',
  '+  const [text, setText] = useDraft(sessionId)',
  '+  return <textarea value={text} onChange={e => setText(e.target.value)} placeholder="描述你要做的事" />',
  ' }',
])

const tools = snapshot(
  record('demo-claude-tools', { updatedAt: T0 - 8 * MIN }),
  [
    user('b-u1', '把输入框的草稿改成按会话保存，切换会话时不要丢；顺便补上测试', 22),
    reasoning(
      'b-r1',
      '先看 Composer 现在怎么存草稿，再找所有用到草稿的地方。改动不大：抽一个 useDraft，Composer 改用它，补测试。localStorage 可能写满，要兜底。',
    ),
    assistant('b-a1', '先看看现在草稿是怎么存的，再找找哪些地方用到了。'),
    {
      kind: 'tool',
      id: 'b-t1',
      tool: 'read',
      name: 'Read',
      title: 'src/session/Composer.jsx',
      output: numbered('export function Composer() {\n  return <textarea placeholder="描述你要做的事" />\n}\n'),
      status: 'completed',
    },
    {
      kind: 'tool',
      id: 'b-t2',
      tool: 'search',
      name: 'Grep',
      title: 'draft · src',
      output: 'src/session/Composer.jsx\nsrc/session/SessionView.jsx\nsrc/styles/session.css',
      status: 'completed',
    },
    {
      kind: 'tool',
      id: 'b-t3',
      tool: 'search',
      name: 'Glob',
      title: 'src/**/*.test.{js,jsx,ts}',
      output: 'No files found',
      status: 'completed',
    },
    {
      kind: 'tool',
      id: 'b-t4',
      tool: 'web',
      name: 'WebFetch',
      title: 'https://react.dev/reference/react/useSyncExternalStore',
      output:
        'useSyncExternalStore 订阅外部存储：subscribe(callback) 返回取消订阅函数，getSnapshot 必须在存储没变时返回同一个值，否则会无限重渲染。',
      status: 'completed',
    },
    {
      kind: 'tool',
      id: 'b-t5',
      tool: 'web',
      name: 'WebSearch',
      title: 'localStorage QuotaExceededError 处理',
      output:
        '1. MDN · Storage.setItem() — 存储满时抛出 QuotaExceededError\n2. web.dev · Storage for the web — 各浏览器的配额\n3. Stack Overflow · How to handle localStorage quota exceeded',
      status: 'completed',
    },
    {
      kind: 'tool',
      id: 'b-t6',
      tool: 'mcp',
      name: 'mcp__github__search_issues',
      title: 'github · search_issues',
      output: JSON.stringify(
        {
          total_count: 2,
          items: [
            { number: 214, title: '切换会话后输入框内容没了', state: 'open' },
            { number: 187, title: '草稿能不能自动保存', state: 'closed' },
          ],
        },
        null,
        2,
      ),
      status: 'completed',
    },
    {
      kind: 'tool',
      id: 'b-t7',
      tool: 'read',
      name: 'Read',
      title: 'src/session/draftStore.js',
      output: 'File does not exist. Current working directory: D:\\work\\pixel-web',
      status: 'failed',
    },
    {
      kind: 'tool',
      id: 'b-t8',
      tool: 'task',
      name: 'Agent',
      title: '找出所有用到草稿的地方',
      output:
        '用到草稿的只有两处：Composer.jsx 自己的 state，和 SessionView.jsx 切换会话时重新挂载 Composer（这就是草稿丢失的原因）。没有别的地方读写草稿。',
      status: 'completed',
    },
    {
      kind: 'tool',
      id: 'b-t9',
      tool: 'read',
      name: 'Read',
      title: 'src/session/SessionView.jsx',
      output: numbered(SHOWCASE_FILES['src/session/SessionView.jsx']),
      status: 'completed',
      subagent: 'Explore',
    },
    {
      kind: 'command',
      id: 'b-c0',
      command: 'git log --oneline -3 -- src/session',
      description: '看看最近谁改过 session 目录',
      output: 'a41f0c2 输入框支持粘贴图片\n93be1d7 会话页拆出 Composer\n5c02e88 初始化 pixel-web',
      exitCode: 0,
      status: 'completed',
      subagent: 'Explore',
    },
    {
      kind: 'todo',
      id: 'b-todo1',
      steps: [
        { text: '抽出 useDraft，按会话存草稿', status: 'in_progress' },
        { text: 'Composer 改用 useDraft', status: 'pending' },
        { text: '补测试', status: 'pending' },
        { text: '跑测试和 lint', status: 'pending' },
      ],
      status: 'completed',
    },
    assistant('b-a2', '原因找到了：切换会话时 Composer 重新挂载，组件里的 state 跟着没了。开始改。'),
    {
      kind: 'file_change',
      id: 'b-f1',
      changes: [change('src/session/useDraft.ts', 'add', allAdded(SHOWCASE_FILES['src/session/useDraft.ts']))],
      status: 'completed',
    },
    { kind: 'file_change', id: 'b-f2', changes: [COMPOSER_DIFF], status: 'completed' },
    {
      kind: 'file_change',
      id: 'b-f3',
      changes: [
        change('src/styles/session.css', 'update', [
          '@@ -1,4 +1,8 @@',
          ' .session {',
          '   display: flex;',
          '   flex-direction: column;',
          ' }',
          '+',
          '+.composer textarea:focus-visible {',
          '+  outline: 2px solid var(--accent);',
          '+}',
        ]),
        change('README.md', 'update', [
          '@@ -1,3 +1,5 @@',
          ' # pixel-web',
          ' ',
          '-这是文件面板的演示内容。',
          '+这是文件面板的演示内容。输入框的草稿按会话保存。',
          '+',
          '+草稿只存在这台电脑上，发送成功后清掉。',
        ]),
      ],
      status: 'completed',
    },
    {
      kind: 'file_change',
      id: 'b-f4',
      changes: [
        change('src/session/legacyDraft.js', 'delete', [
          '@@ -1,4 +0,0 @@',
          '-// 旧的草稿存储，没人用了',
          '-export const draft = { text: "" }',
          '-export const setDraft = text => (draft.text = text)',
          '-export const getDraft = () => draft.text',
        ]),
      ],
      status: 'completed',
    },
    {
      kind: 'command',
      id: 'b-c1',
      command: 'mkdir -p src/session/__tests__',
      description: '建测试目录',
      output: '',
      exitCode: 0,
      status: 'completed',
    },
    {
      kind: 'file_change',
      id: 'b-f5',
      changes: [
        change(
          'src/session/__tests__/useDraft.test.ts',
          'add',
          allAdded(SHOWCASE_FILES['src/session/__tests__/useDraft.test.ts']),
        ),
      ],
      status: 'completed',
    },
    {
      kind: 'command',
      id: 'b-c2',
      command: 'npm test -- src/session',
      description: '跑草稿相关的测试',
      output: [
        '',
        `${ESC}1m${ESC}46m RUN ${ESC}49m${ESC}22m ${ESC}36mv3.2.4 ${ESC}39m${ESC}90mD:/work/pixel-web${ESC}39m`,
        '',
        ` ${ESC}32m✓${ESC}39m src/session/__tests__/useDraft.test.ts ${ESC}2m(2 tests)${ESC}22m ${ESC}33m14${ESC}2mms${ESC}22m${ESC}39m`,
        '',
        `${ESC}2m Test Files ${ESC}22m ${ESC}1m${ESC}32m1 passed${ESC}39m${ESC}22m${ESC}90m (1)${ESC}39m`,
        `${ESC}2m      Tests ${ESC}22m ${ESC}1m${ESC}32m2 passed${ESC}39m${ESC}22m${ESC}90m (2)${ESC}39m`,
        `${ESC}2m   Duration ${ESC}22m 612ms`,
      ].join('\n'),
      exitCode: 0,
      status: 'completed',
    },
    {
      kind: 'command',
      id: 'b-c3',
      command: 'npm run lint',
      description: '检查代码风格',
      output: [
        '> pixel-web@0.1.0 lint',
        '> eslint src',
        '',
        `${ESC}4mD:\\work\\pixel-web\\src\\session\\Composer.jsx${ESC}24m`,
        `  ${ESC}2m6:38${ESC}22m  ${ESC}31merror${ESC}39m  'e' is defined but never used  ${ESC}2mno-unused-vars${ESC}22m`,
        `  ${ESC}2m6:78${ESC}22m  ${ESC}33mwarning${ESC}39m  Line exceeds 100 characters  ${ESC}2mmax-len${ESC}22m`,
        '',
        `${ESC}31m${ESC}1m✖ 2 problems (1 error, 1 warning)${ESC}22m${ESC}39m`,
      ].join('\n'),
      exitCode: 1,
      status: 'failed',
    },
    {
      kind: 'file_change',
      id: 'b-f6',
      changes: [
        change('src/session/Composer.jsx', 'update', [
          '@@ -5,2 +5,8 @@',
          '   const [text, setText] = useDraft(sessionId)',
          '-  return <textarea value={text} onChange={e => setText(e.target.value)} placeholder="描述你要做的事" />',
          '+  return (',
          '+    <textarea',
          '+      value={text}',
          '+      onChange={event => setText(event.target.value)}',
          '+      placeholder="描述你要做的事"',
          '+    />',
          '+  )',
        ]),
      ],
      status: 'completed',
    },
    {
      kind: 'command',
      id: 'b-c4',
      command: 'Get-ChildItem src\\session -Recurse -Filter *.test.* | Select-Object Name, Length',
      description: '列出测试文件（PowerShell）',
      output: 'Name               Length\n----               ------\nuseDraft.test.ts      412',
      exitCode: 0,
      status: 'completed',
    },
    {
      kind: 'command',
      id: 'b-c5',
      command: 'npm run dev',
      description: '启动开发服务器看一下效果',
      output: [
        '> pixel-web@0.1.0 dev',
        '> vite',
        '',
        `  ${ESC}32m${ESC}1mVITE${ESC}22m v6.3.5${ESC}39m  ${ESC}2mready in ${ESC}0m${ESC}1m312${ESC}22m${ESC}2m${ESC}0m ms${ESC}22m`,
        '',
        `  ${ESC}32m➜${ESC}39m  ${ESC}1mLocal${ESC}22m:   ${ESC}36mhttp://localhost:${ESC}1m5173${ESC}22m/${ESC}39m`,
      ].join('\n'),
      exitCode: null,
      status: 'interrupted',
    },
    {
      kind: 'command',
      id: 'b-c6',
      command: 'git push origin feat/draft',
      description: '推送到远端',
      output: '',
      exitCode: null,
      status: 'declined',
    },
    {
      kind: 'tool',
      id: 'b-o1',
      tool: 'other',
      name: 'Skill',
      title: 'verify · src/session',
      output: '已加载技能 verify：改完后在浏览器里打开检查。',
      status: 'completed',
    },
    {
      kind: 'tool',
      id: 'b-w1',
      tool: 'task',
      name: 'Workflow',
      title: '三个方向并行审查草稿改动',
      output: '审查完成：正确性 0 个问题，测试 1 个建议（加一条写满 localStorage 的用例），可读性没有问题。',
      status: 'completed',
    },
    {
      kind: 'todo',
      id: 'b-todo2',
      steps: [
        { text: '抽出 useDraft，按会话存草稿', status: 'completed' },
        { text: 'Composer 改用 useDraft', status: 'completed' },
        { text: '补测试', status: 'completed' },
        { text: '跑测试和 lint', status: 'completed' },
      ],
      status: 'completed',
    },
    assistant(
      'b-a3',
      '改好了：\n\n- 新增 `src/session/useDraft.ts`，每个会话一份草稿，停顿 300ms 后写进 `localStorage`，写满时只留在内存里；\n- `src/session/Composer.jsx` 改用 `useDraft(sessionId)`，lint 报的未使用变量已改；\n- 删了没人用的 `legacyDraft.js`；\n- 测试 2 个全部通过。\n\n`git push` 被你拒绝了，没有推送。审查建议加一条写满 `localStorage` 的测试，要加的话说一声。',
    ),
    stats('b-s1', 'completed', {
      durationMs: 184_000,
      models: {
        'claude-opus-5-5': opus(9_800, 4_100, 0.4831, 14),
        'claude-haiku-4-5': {
          input: 3_200,
          cacheRead: 41_000,
          cacheWrite: 2_800,
          output: 900,
          costUsd: 0.0127,
          requests: 6,
        },
      },
    }),
  ],
  {
    runs: {
      agents: [
        agentRun('agent-explore', '找出所有用到草稿的地方', {
          type: 'Explore',
          model: 'claude-haiku-4-5',
          toolUseId: 'b-t8',
          prompt: '在 src 里找出所有读写输入框草稿的地方，说明切换会话时草稿为什么会丢。',
          result: '用到草稿的只有两处：Composer.jsx 自己的 state，和 SessionView.jsx 切换会话时重新挂载 Composer。',
        }),
      ],
      workflows: [
        {
          id: 'wf-review',
          name: 'review',
          description: '三个方向并行审查草稿改动',
          status: 'completed',
          startedAt: T0 - 11 * MIN,
          durationMs: 52_000,
          tokens: 61_000,
          toolCalls: 17,
          phases: [
            { index: 1, title: '审查' },
            { index: 2, title: '核对' },
          ],
          agents: [
            agentRun('wf-correct', '正确性', { phase: 1, result: '没发现问题。' }),
            agentRun('wf-tests', '测试', { phase: 1, result: '建议加一条写满 localStorage 的用例。' }),
            agentRun('wf-read', '可读性', { phase: 1, result: '命名清楚，没有问题。' }),
            agentRun('wf-verify', '核对建议', { phase: 2, result: '测试建议成立，其它两项没有要改的。' }),
          ],
          toolUseId: 'b-w1',
        },
      ],
    },
  },
)

function agentRun(id: string, label: string, patch: Partial<AgentRun> = {}): AgentRun {
  return {
    id,
    label,
    type: '',
    model: 'claude-opus-5-5',
    state: 'completed',
    startedAt: T0 - 12 * MIN,
    durationMs: 18_400,
    tokens: 12_300,
    toolCalls: 6,
    phase: null,
    prompt: label,
    result: '',
    toolUseId: null,
    ...patch,
  }
}

// ---------- 3 用户消息 ----------

function image(id: string, name: string, base64: string, width: number, height: number): ImageAttachment {
  return {
    id,
    name,
    mediaType: 'image/png',
    bytes: Math.round((base64.length * 3) / 4),
    width,
    height,
    dataBase64: base64,
  }
}

const SCREENSHOT_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAPAAAACWCAIAAABvmpKCAAACD0lEQVR42u3dMa6CQBSGURZmYekKaazdC800hMrCgoSGypjYIAkuwUhwyB3Pn28FL6dibnxVP4xSMVX+BAJaAloCWgJaQEtAS0BLQEtAC2gJaAlo6Seg749niKbpJX0MaAENtIAGWkADLaAFNNACGmiFAp3aa/6AFtAS0AIaaAENtIAGWkBLZYI+HE/aN6CBBhpooIEGWkADLaCBBhpooIF2PioBLaCBFtBAC2igBbQEtIAGWs5H3UML6JWg6/NFcQMaaKCBFtBAC2igBbSvHAJaAlpAAy2ggRbQQAtoAe07tLb9Hux8dMvzURaBBlpAAw000EADDbSvHAJaQAMtoIGWhxUvhQJaAlpAAy2ggRbQQAtoCWgBDbSABjp7t3H+h4AGGmiggQYaaKCBBhrovKCdjwINNNBAAw000EALaKCBBhpooIEGGmiggQbaw4qABhpooIEGGmiggQYaaKCBBhpooIEGGmiggQYaaKCBBhpooIEGGmiggZZfTgJae4J2PiqggRbQQAtoCWgBDbSABlpAAy0PKxLQAhpoAQ20gAZaQEtAC2igBTTQAnot6CZ1i5W4JnVAG9BAG9BAG9BAW0bQQc9HgQYaaAMaaAMaaAMaaAPagAbagAbagoD2sGJAA21AA21AAw000AY00AY00AY00Aa0BLSABlpAAy2ggRbQkn8aJKCBFtBAC2ig9X1v0J8iyVot8k4AAAAASUVORK5CYII='
const ERROR_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAALQAAAB4CAIAAADUhU+qAAABPklEQVR42u3doQ2AMBRF0Q6EwJCwAEtUM1M1g7ELCCymEMKnnJc7ATnmp4LU9aN0WvIJBIfgEByCQ3AIDsEhOASH4JDgEByCQ3AIDsEhOASH4BAcla3DpMjBITgEh+AQHIJDcMABBxxwwAEHHHDAITj0DRybxR4cBofBYXAYHAaHwQEHHHDAAQcccMARD0fOs+4Hh+AQHHDAAQccrhXXChxwwAEHHAaHwWFw2E9wlLLoCA444IADDjjggAMO14prBQ6Dw+AwOAwOg8PggAMOOOCAAw444IDD4DA4DA6Dw+AwOAwOOOCA4/Je+aMKHHDAAQcccMABBxwGBxxwwAEHHHDAAQcccMBh3lYMDoPD4DA44IADDjjggOMpHGo4OASH4BAcgkNwCA7BITgEh+CQ4BAcgkNwCA7BITgEh5ptBzRKp8XOuWbuAAAAAElFTkSuQmCC'

const LONG_MESSAGE = `测试里这段一直不稳定，大概十次里失败一次：

${F}ts
it('停顿后写进 localStorage', () => {
  vi.useFakeTimers()
  const { result } = renderHook(() => useDraft('a'))
  act(() => result.current[1]('你好'))
  vi.advanceTimersByTime(299)
  expect(localStorage.getItem('draft:a')).toBeNull()
  vi.advanceTimersByTime(1)
  expect(localStorage.getItem('draft:a')).toBe('你好')
})
${F}

失败时的输出：

${F}
AssertionError: expected null to be '你好'
 ❯ src/session/__tests__/useDraft.test.ts:24:41
${F}

我怀疑是 300ms 的延迟写入和 fake timers 没对上。你看看是不是这样，如果是的话：
1. 先确认 setTimeout 是在 act 里面还是外面注册的
2. 延迟改成常量导出，测试里直接用
3. 别的测试有没有一样的问题
另外 @README.md 里关于草稿的说明也顺手更新一下。`

const userMessages = snapshot(record('demo-claude-user', { updatedAt: T0 - 15 * MIN }), [
  user('c-u1', '/review @src/session/Composer.jsx 重点看草稿那块，截图是现在切换会话后的样子', 34, {
    attachments: [
      image('img-shot', '切换会话后.png', SCREENSHOT_PNG, 240, 150),
      image('img-error', '报错弹窗.png', ERROR_PNG, 180, 120),
    ],
  }),
  assistant(
    'c-a1',
    '看了截图和 `src/session/Composer.jsx`：切换会话后输入框是空的，因为草稿存在组件 state 里，组件重新挂载就没了。第二张图的报错是另一个问题（保存设置时网络断开），和草稿无关。',
  ),
  stats('c-s1', 'completed', { durationMs: 21_000, models: { 'claude-opus-5-5': opus(5_600, 420, 0.0612, 1) } }),
  user('c-u2', LONG_MESSAGE, 30),
  reasoning(
    'c-r2',
    '看测试：advanceTimersByTime(299) 之后断言为空，再走 1ms 断言有值。setTimeout 在 act 外注册的话，时间对不上。',
  ),
  assistant('c-a2', '对，问题在 setTimeout 是在 `act` 外面注册的。先把延迟抽成常量 `DRAFT_DELAY`，再'),
  user('c-g1', '先别改测试，只改实现', 29, { mode: 'guidance' }),
  assistant('c-a3', '好的，只改实现：把写入放进 `useEffect`，保证在 `act` 里注册定时器。正在改', 'interrupted'),
  stats('c-s2', 'interrupted', { durationMs: 47_000, models: { 'claude-opus-5-5': opus(7_100, 680, 0.0874, 2) } }),
  user('c-u3', '继续', 18),
  {
    kind: 'compaction',
    id: 'c-n1',
    status: 'completed',
    trigger: 'auto',
    startedAt: 0,
    durationMs: 31_400,
    preTokens: 184_213,
    postTokens: 12_480,
  },
  {
    kind: 'notice',
    id: 'c-n3',
    level: 'info',
    text: '后台命令已完成：pnpm test --watch',
    task: { kind: 'bash', status: 'completed', label: 'pnpm test --watch' },
  },
  { kind: 'notice', id: 'c-n2', level: 'warn', text: 'Fast 模式暂时不可用：限流冷却中，稍后会自动恢复' },
  assistant(
    'c-a4',
    '继续改好了：写入放进了 `useEffect`，测试连续跑 50 次都通过。`README.md` 里补了一句草稿只存在本机。',
  ),
  stats('c-s3', 'completed', { durationMs: 66_000, models: { 'claude-opus-5-5': opus(6_300, 1_240, 0.1033, 4) } }),
])

// ---------- 4 报错（自有） ----------

export const failed = (id: string): Item =>
  stats(id, 'failed', {
    durationMs: 3_200,
    models: { 'claude-opus-5-5': { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0, requests: 1 } },
  })

const errors = snapshot(
  record('demo-claude-errors', {
    lastOutcome: 'failed',
    lastError: '登录已失效：在终端运行 claude auth login 重新登录',
    updatedAt: T0 - 4 * MIN,
  }),
  [
    // 额度用完自动换了账号（docs/ui/engine-accounts-claude.md §3）：按钮跟着演示账号的当前状态变
    user('d-u0', '把登录页的按钮颜色改成设计变量里的主色', 20),
    {
      kind: 'notice',
      id: 'd-n0',
      level: 'error',
      text: 'Claude 订阅的额度用完了',
      detail: "You've hit your limit · resets 4:45pm",
      error: { kind: 'balance', code: 'usageLimitExceeded' },
    },
    {
      kind: 'notice',
      id: 'account-switch-demo',
      level: 'info',
      text: 'linxia@example.com 的额度用完了，已自动换到 work@company.com 并重新发送这条消息',
      account: {
        engine: 'claude',
        from: 'default',
        to: 'a_0d3f9a1c2b7e',
        fromName: 'linxia@example.com',
        toName: 'work@company.com',
        window: 'five_hour',
        resetsAt: T0 + 2 * 60 * MIN,
      },
    },
    assistant('d-a0', '好的，我把 `LoginForm.tsx` 里写死的颜色换成 `--accent`，悬停色用它的混色。'),
    user('d-u1', '跑一下测试', 14),
    {
      kind: 'notice',
      id: 'd-n1',
      level: 'error',
      text: '服务繁忙，请稍后再试',
      detail: 'HTTP 529\noverloaded_error: Overloaded\nrequest_id: req_011CWfQ7mZ3yX2sB9uK4pLdE',
    },
    failed('d-s1'),
    user('d-u2', '换成 claude-opus-5-5-preview 再试', 10),
    {
      kind: 'notice',
      id: 'd-n2',
      level: 'error',
      text: '找不到所选模型',
      detail: 'HTTP 404\nnot_found_error: model: claude-opus-5-5-preview',
    },
    failed('d-s2'),
    user('d-u3', '换回 claude-opus-5-5', 5),
    {
      kind: 'notice',
      id: 'd-n3',
      level: 'error',
      text: '登录已失效：在终端运行 claude auth login 重新登录',
      detail:
        'HTTP 401\nauthentication_error: OAuth token has expired. Please obtain a new token or refresh your existing token.',
    },
    failed('d-s3'),
  ],
)

// ---------- 5 报错（平台） ----------

const platformRecord = record('demo-claude-platform', {
  platform: { groupId: '11', account: 'linxia@example.com' },
  lastOutcome: 'failed',
  lastError: '账户余额不足，充值后再继续',
  updatedAt: T0 - 6 * MIN,
})

const platform = snapshot(platformRecord, [
  user('e-u1', '总结一下今天草稿相关的改动', 26),
  assistant(
    'e-a1',
    '今天的改动：\n\n1. 新增 `src/session/useDraft.ts`，草稿按会话保存；\n2. `src/session/Composer.jsx` 改用它；\n3. 补了 2 个测试，全部通过。',
  ),
  stats('e-s1', 'completed', {
    durationMs: 14_000,
    settlement: {
      account: 'linxia@example.com',
      requests: [{ id: 'pixelsky-demo-1', model: 'claude-opus-5-5', groupId: '11' }],
      startedAt: T0 - 26 * MIN,
      complete: true,
    },
    models: { 'claude-opus-5-5': { ...opus(3_100, 360, 0.0418, 1), costSource: 'platform', billing: 'balance' } },
  }),
  user('e-u2', '再把写满 localStorage 的测试补上', 7),
  {
    kind: 'notice',
    id: 'e-n1',
    level: 'error',
    text: '账户余额不足，充值后再继续',
    detail: 'HTTP 402\ninsufficient_balance: 余额 $0.00，本次预计 $0.12\n线路：Claude 官方线路（×1）',
  },
  failed('e-s2'),
])

// ---------- 5b 发送失败：消息没能开始，留在消息队列里（重试 / 撤回） ----------

const sendFailed = (
  id: string,
  text: string,
  minutesAgo: number,
  error: string,
  extra: Partial<QueuedMessage> = {},
): QueuedMessage => ({
  id,
  text,
  createdAt: T0 - minutesAgo * MIN,
  settings: { model: 'claude-opus-5-5', effort: 'xhigh', platform: { groupId: '1', account: 'linxia@example.com' } },
  status: 'failed',
  error,
  mode: 'normal',
  direct: true,
  ...extra,
})

const sendFailures = snapshot(
  record('demo-claude-send-failed', {
    platform: { groupId: '1', account: 'linxia@example.com' },
    lastOutcome: 'completed',
    updatedAt: T0 - 4 * MIN,
  }),
  [
    user('sf-u1', '把草稿清理的逻辑也放进会话删除流程里', 32),
    assistant('sf-a1', '改好了：删除会话时一并清掉它的草稿和附件缓存，补了 1 个测试，全部通过。'),
    stats('sf-s1', 'completed', { durationMs: 41_000, models: { 'claude-opus-5-5': opus(6_200, 540, 0.0731, 2) } }),
  ],
  {
    queuePaused: true,
    queue: [
      sendFailed(
        'sf-q1',
        '照截图把设置页的间距也统一一下，然后继续',
        9,
        'API Error: 502 无法连接上游：Post "http://s2amt-app:8080/v1/messages": net/http: timeout awaiting response headers. This is a server-side issue, usually temporary — try again in a moment.',
        { attachments: [image('sf-img', '设置页.png', SCREENSHOT_PNG, 240, 150)] },
      ),
      sendFailed('sf-q2', '继续', 6, '没有权限：当前账号或 API Key 不能用这个模型或资源'),
      sendFailed('sf-q3', '顺便把 README 里草稿那节也更新了', 5, '没有权限：当前账号或 API Key 不能用这个模型或资源'),
      // 换过线路的一条：设置和别的不一样，各行分别显示设置
      sendFailed('sf-q4', '改完跑一遍全部测试', 4, '余额不足，这条线路按余额计费', {
        settings: {
          model: 'claude-opus-5-5',
          effort: 'high',
          platform: { groupId: '2', account: 'linxia@example.com' },
        },
      }),
    ],
  },
)

// ---------- 6 运行中 ----------

const RUNNING_TURN = 'f-turn-2'

const running = snapshot(
  record('demo-claude-running', { lastOutcome: 'completed', updatedAt: T0 }),
  [
    user('f-u1', '先看看草稿功能还差什么', 20),
    assistant('f-a1', '还差三件事：会话删除时清理草稿、写满 `localStorage` 的测试、README 里的说明。'),
    stats('f-s1', 'completed', { durationMs: 19_000, models: { 'claude-opus-5-5': opus(4_200, 380, 0.0507, 1) } }),
    user('f-u2', '三件一起做完，测试和文档可以让子智能体并行做', 3, { turnId: RUNNING_TURN }),
    reasoning('f-r1', '清理我自己做；测试和文档各派一个子智能体并行。先列计划。'),
    {
      kind: 'todo',
      id: 'f-todo',
      steps: [
        { text: '会话删除时清理草稿', status: 'completed' },
        { text: '补写满 localStorage 的测试', status: 'in_progress' },
        { text: '更新 README', status: 'completed' },
        { text: '跑全部测试', status: 'pending' },
      ],
      status: 'completed',
    },
    {
      kind: 'file_change',
      id: 'f-f1',
      changes: [
        change('src/session/SessionView.jsx', 'update', [
          '@@ -1,2 +1,3 @@',
          " import { Composer } from './Composer'",
          "+import { clearDraft } from './useDraft'",
          ' ',
        ]),
      ],
      status: 'completed',
    },
    {
      kind: 'tool',
      id: 'f-t1',
      tool: 'task',
      name: 'Agent',
      title: '补写满 localStorage 的测试',
      output: '',
      status: 'running',
    },
    {
      kind: 'tool',
      id: 'f-t2',
      tool: 'task',
      name: 'Agent',
      title: '更新 README 里的草稿说明',
      output: 'README 已更新：补了「草稿只存在本机、发送成功后清掉」两句。',
      status: 'completed',
    },
    {
      kind: 'tool',
      id: 'f-t3',
      tool: 'read',
      name: 'Read',
      title: 'src/session/__tests__/useDraft.test.ts',
      output: numbered(SHOWCASE_FILES['src/session/__tests__/useDraft.test.ts']),
      status: 'completed',
      subagent: '补写满 localStorage 的测试',
    },
    {
      kind: 'command',
      id: 'f-c1',
      command: 'npm test -- src/session --run',
      description: '跑草稿测试',
      output: `${ESC}1m${ESC}46m RUN ${ESC}49m${ESC}22m ${ESC}36mv3.2.4${ESC}39m\n\n ${ESC}33m❯${ESC}39m src/session/__tests__/useDraft.test.ts ${ESC}2m0/3${ESC}22m`,
      exitCode: null,
      status: 'running',
      subagent: '补写满 localStorage 的测试',
    },
  ],
  {
    state: 'running',
    turnId: RUNNING_TURN,
    execution: { model: 'claude-opus-5-5', effort: 'high', platform: null },
    retry: { turnId: RUNNING_TURN, attempt: 2, maxRetries: 10, retryAt: T0 + 30_000, reason: 'HTTP 529' },
    subagents: [
      { id: 'agent-tests', label: '补写满 localStorage 的测试', status: 'running', message: '正在运行 npm test' },
      { id: 'agent-readme', label: '更新 README 里的草稿说明', status: 'completed', message: 'README 已更新' },
    ],
    runs: {
      workflows: [],
      agents: [
        agentRun('agent-tests', '补写满 localStorage 的测试', {
          type: 'general-purpose',
          state: 'running',
          startedAt: T0 - 2 * MIN,
          durationMs: 0,
          toolUseId: 'f-t1',
          prompt: '给 useDraft 补一条测试：localStorage.setItem 抛 QuotaExceededError 时草稿仍留在内存里。',
        }),
        agentRun('agent-readme', '更新 README 里的草稿说明', {
          type: 'general-purpose',
          toolUseId: 'f-t2',
          durationMs: 24_000,
          result: 'README 已更新：补了「草稿只存在本机、发送成功后清掉」两句。',
        }),
      ],
    },
    tasks: [
      {
        id: 'task-dev',
        kind: 'local_bash',
        description: 'npm run dev',
        message: 'VITE v6.3.5 ready · http://localhost:5173',
      },
      {
        id: 'task-ci',
        kind: 'monitor',
        description: '监视 CI：feat/draft',
        message: '3 个检查里 2 个通过，1 个在运行',
      },
    ],
  },
)

// ---------- 6b 压缩上下文（docs/ui/compaction.md） ----------

const COMPACT_TURN = 'cp-turn-2'
const COMPACT_LIVE = 'cp-c2'

const compactionItem = (
  id: string,
  patch: Partial<Extract<Item, { kind: 'compaction' }>>,
): Extract<Item, { kind: 'compaction' }> => ({
  kind: 'compaction',
  id,
  status: 'completed',
  trigger: 'auto',
  startedAt: T0 - MIN,
  durationMs: 24_600,
  preTokens: 182_904,
  postTokens: 9_870,
  ...patch,
})

/** 正在压缩：开着这个会话时由 animateCompaction 循环「压缩中 7 秒 → 压完（数字递减）→ 停 6 秒」 */
const compacting = snapshot(
  record('demo-claude-compacting', { lastOutcome: 'completed', updatedAt: T0 }),
  [
    user('cp-u1', '把草稿功能的实现和测试从头过一遍', 40),
    assistant('cp-a1', '过完了：实现和测试都对得上，`useDraft` 的防抖和清理时机都有测试覆盖。'),
    stats('cp-s1', 'completed', { durationMs: 212_000, models: { 'claude-opus-5-5': opus(176_000, 6_800, 1.32, 14) } }),
    user('cp-u3', '接着把草稿同步到云端也做了', 0, { turnId: COMPACT_TURN }),
    reasoning('cp-r1', '先看现有的同步接口，再决定草稿走哪条路。'),
    compactionItem(COMPACT_LIVE, {
      status: 'running',
      trigger: null,
      startedAt: T0 - 3_000,
      durationMs: null,
      preTokens: 171_350,
      postTokens: null,
    }),
  ],
  {
    state: 'running',
    turnId: COMPACT_TURN,
    execution: { model: 'claude-opus-5-5', effort: 'high', platform: null },
  },
)

/**
 * 演示模式下让「正在压缩」的那条循环播放：等待上游接通 → 模型读取对话 → 输出摘要（token 往上涨）→ 整理上下文 → 压完
 * （数字递减）→ 停 6 秒；网关进度用快照的 compaction 字段（真实会话里由本机网关报来）
 */
export function animateCompaction(update: DemoUpdate): void {
  const set = (
    patch: Partial<Extract<Item, { kind: 'compaction' }>>,
    progress: CompactionProgress | null = null,
  ): void =>
    update(
      'demo-claude-compacting',
      items =>
        items.map(item => (item.id === COMPACT_LIVE && item.kind === 'compaction' ? { ...item, ...patch } : item)),
      { compaction: progress },
    )
  const OUTPUT = 1_814
  const cycle = (): void => {
    const startedAt = Date.now()
    const base: CompactionProgress = {
      itemId: COMPACT_LIVE,
      requests: 1,
      model: 'claude-haiku-4-5',
      requestedModel: 'claude-opus-5-5',
      requestAt: startedAt + 300,
      connectedAt: null,
      status: null,
      firstTokenAt: null,
      lastContentAt: null,
      lastByteAt: null,
      outputTokens: 0,
      outputExact: false,
      done: false,
      error: null,
    }
    const running = { status: 'running', trigger: null, startedAt, durationMs: null, postTokens: null } as const
    const at = (ms: number, fn: () => void) => window.setTimeout(fn, ms)
    set(running)
    at(300, () => set(running, base))
    const connected = { ...base, connectedAt: startedAt + 1_200, status: 200, lastByteAt: startedAt + 1_200 }
    at(1_200, () => set(running, connected))
    // 4 秒出首字，之后每 250 ms 涨一截，9 秒输出完
    for (let ms = 4_000; ms <= 13_000; ms += 250) {
      const outputTokens = Math.min(OUTPUT, Math.round(((ms - 4_000) / 9_000) * OUTPUT) + 12)
      at(ms, () =>
        set(running, {
          ...connected,
          firstTokenAt: startedAt + 4_000,
          lastContentAt: startedAt + ms,
          lastByteAt: startedAt + ms,
          outputTokens,
        }),
      )
    }
    const finished = {
      ...connected,
      firstTokenAt: startedAt + 4_000,
      lastContentAt: startedAt + 13_000,
      lastByteAt: startedAt + 13_100,
      outputTokens: OUTPUT,
      outputExact: true,
      done: true,
    }
    at(13_100, () => set(running, finished))
    at(14_500, () => {
      set({
        status: 'completed',
        trigger: 'auto',
        durationMs: Date.now() - startedAt,
        postTokens: 11_234,
        model: 'claude-haiku-4-5',
        firstTokenMs: 3_700,
        outputTokens: OUTPUT,
        requests: 1,
      })
      at(6_000, cycle)
    })
  }
  cycle()
}

// ---------- 运行中：当前步骤（docs/ui/conversation-concise.md §7） ----------

const STEPS_ID = 'demo-claude-steps'
const STEPS_TURN = 'st-turn'
const stepsStart: Item[] = [user('st-u1', '把草稿同步到云端，改完跑一遍测试', 0, { turnId: STEPS_TURN })]

/** 开着这个会话时由 animateSteps 一步步往下放：思考 → 长命令（计时）→ 看结果 → 说一句 → 改文件 → 两个子智能体并行 → 回复，停一会儿重来 */
const steps = snapshot(record(STEPS_ID, { lastOutcome: 'completed', updatedAt: T0 }), stepsStart, {
  state: 'running',
  turnId: STEPS_TURN,
  execution: { model: 'claude-opus-5-5', effort: 'high', platform: null },
})

export function animateSteps(update: DemoUpdate): void {
  const at = (ms: number, fn: () => void) => window.setTimeout(fn, ms)
  const put = (id: string, item: Item): void =>
    update(STEPS_ID, items =>
      items.some(i => i.id === id) ? items.map(i => (i.id === id ? item : i)) : [...items, item],
    )
  const cmd = (status: 'running' | 'completed'): Item => ({
    kind: 'command',
    id: 'st-c1',
    command: 'pnpm test --filter sync',
    description: null,
    output:
      status === 'running' ? '' : ' ✓ draftSync.test.ts (12)\n Test Files  1 passed (1)\n      Tests  12 passed (12)',
    exitCode: status === 'running' ? null : 0,
    status,
  })
  const edit = (status: 'running' | 'completed'): Item => ({
    kind: 'file_change',
    id: 'st-f1',
    changes: [
      change('src/sync/draftSync.ts', 'update', [
        '@@ -12,3 +12,5 @@',
        ' export function syncDraft(id) {',
        '+  if (!id) return',
        '+  queue.push(id)',
        ' }',
      ]),
    ],
    status,
  })
  const agent = (id: string, title: string, status: 'running' | 'completed'): Item => ({
    kind: 'tool',
    id,
    tool: 'task',
    name: 'Agent',
    title,
    output: status === 'running' ? '' : '没有发现问题。',
    status,
  })
  const cycle = (): void => {
    // 每次重来都是新的一轮：用户消息的时间换成现在，状态行上「本轮用时」才从头数
    update(STEPS_ID, () => stepsStart.map(it => (it.kind === 'user' ? { ...it, createdAt: Date.now() } : it)), {
      state: 'running',
    })
    // 刚发消息：底部「正在思考…」
    at(2_000, () =>
      put('st-r1', {
        kind: 'reasoning',
        id: 'st-r1',
        text: '先跑一遍同步相关的测试，看现在的状态。',
        status: 'running',
      }),
    )
    at(5_000, () => {
      put('st-r1', {
        kind: 'reasoning',
        id: 'st-r1',
        text: '先跑一遍同步相关的测试，看现在的状态。',
        status: 'completed',
      })
      put('st-c1', cmd('running'))
    })
    // 命令跑 7 秒（3 秒后行上开始计时），跑完看结果 6 秒（5 秒后带上已等的时间）
    at(12_000, () => put('st-c1', cmd('completed')))
    at(18_000, () => put('st-a1', assistant('st-a1', '测试都过了，接着把同步接口改成按会话排队。')))
    at(21_000, () => put('st-f1', edit('running')))
    at(24_000, () => {
      put('st-f1', edit('completed'))
      put('st-t1', agent('st-t1', '审查同步改动', 'running'))
      put('st-t2', agent('st-t2', '补充离线测试', 'running'))
    })
    at(29_000, () => put('st-t2', agent('st-t2', '补充离线测试', 'completed')))
    at(31_000, () => put('st-t1', agent('st-t1', '审查同步改动', 'completed')))
    at(33_000, () => {
      put('st-a2', assistant('st-a2', '草稿同步做好了：按会话排队上传，离线时先存本地，测试全部通过。'))
      put(
        'st-s1',
        stats('st-s1', 'completed', {
          durationMs: 33_000,
          models: { 'claude-opus-5-5': opus(42_000, 2_100, 0.38, 6) },
        }),
      )
      update(STEPS_ID, items => items, { state: 'idle' })
    })
    at(40_000, cycle)
  }
  cycle()
}

/** 各种结果放在一起对照样式 */
const compactions = snapshot(record('demo-claude-compactions', { lastOutcome: 'completed', updatedAt: T0 - 2 * MIN }), [
  user('cq-u1', '/compact', 30, { turnId: 'cq-t1' }),
  compactionItem('cq-c1', { trigger: 'manual', durationMs: 24_600, preTokens: 182_904, postTokens: 9_870 }),
  user('cq-u2', '继续把同步做完', 25, { turnId: 'cq-t2' }),
  assistant('cq-a1', '同步接口改好了，正在补测试。'),
  compactionItem('cq-c2', { durationMs: 41_300, preTokens: 196_420, postTokens: 14_212 }),
  assistant('cq-a2', '测试补完了，全部通过。'),
  stats('cq-s2', 'completed', { durationMs: 318_000, models: { 'claude-opus-5-5': opus(352_000, 9_400, 2.41, 22) } }),
  user('cq-u3', '/compact', 18, { turnId: 'cq-t3' }),
  compactionItem('cq-c3', {
    status: 'failed',
    trigger: 'manual',
    durationMs: 8_200,
    preTokens: 201_877,
    postTokens: null,
    error: 'Conversation too long. Press esc twice to go up a few messages and try again.',
  }),
  stats('cq-s3', 'failed', { durationMs: 8_400, models: { 'claude-opus-5-5': opus(1_200, 40, 0.02, 1) } }),
  user('cq-u4', '/compact', 12, { turnId: 'cq-t4' }),
  compactionItem('cq-c4', {
    status: 'interrupted',
    trigger: null,
    durationMs: 5_100,
    preTokens: 201_877,
    postTokens: null,
  }),
  stats('cq-s4', 'interrupted', { durationMs: 5_300, models: { 'claude-opus-5-5': opus(800, 20, 0.01, 1) } }),
  user('cq-u5', '再试一次压缩', 8, { turnId: 'cq-t5' }),
  // 旧版 Claude Code：只有压缩前大小，没有用时和压缩后大小
  compactionItem('cq-c5', { durationMs: null, preTokens: 201_877, postTokens: null }),
  assistant('cq-a5', '压缩好了，可以继续。'),
  // 压缩后几乎没变小（只有压缩后不比压缩前小时才不显示百分比）
  user('cq-u6', '/compact', 2, { turnId: 'cq-t6' }),
  compactionItem('cq-c6', { trigger: 'manual', durationMs: 3_900, preTokens: 12_480, postTokens: 12_310 }),
])

// ---------- 7 正在启动 ----------

const starting = snapshot(
  record('demo-claude-starting', { updatedAt: T0 }),
  [
    user('g-u1', '草稿功能合进 main 了吗', 12),
    assistant('g-a1', '还没有，`feat/draft` 分支比 main 多 6 个提交，CI 全部通过，可以合。'),
    stats('g-s1', 'completed', { durationMs: 9_000, models: { 'claude-opus-5-5': opus(2_900, 120, 0.0301, 1) } }),
  ],
  {
    state: 'starting',
    queue: [
      {
        id: 'q-start',
        text: '那就合进去，合完删掉远端分支',
        createdAt: T0,
        settings: { model: 'claude-opus-5-5', effort: 'high', platform: null },
        status: 'dispatching',
        error: null,
        mode: 'normal',
        direct: true,
      },
    ],
  },
)

// ---------- 8–12 审批与提问 ----------

function waiting(
  id: SessionId,
  ask: string,
  intro: string,
  item: Item,
  request: ApprovalRequest,
  patch: Partial<SessionRecord> = {},
): SessionSnapshot {
  const turnId = `${id}-turn`
  return snapshot(
    record(id, { updatedAt: T0, ...patch }),
    [user(`${id}-u`, ask, 1, { turnId }), assistant(`${id}-a`, intro), item],
    {
      state: 'waiting',
      turnId,
      pending: [request],
      execution: { model: 'claude-opus-5-5', effort: 'high', platform: null },
    },
  )
}

const ALWAYS: ApprovalRequest['alwaysScopes'] = ['session', 'project', 'user']

const approveCommand = waiting(
  'demo-claude-approve-command',
  '测试都过了，推上去吧',
  '好的，推送 `feat/draft` 并设置上游。',
  {
    kind: 'command',
    id: 'h-c1',
    command: 'git push -u origin feat/draft',
    description: '把 feat/draft 推到远端并设置上游',
    output: '',
    exitCode: null,
    status: 'running',
  },
  {
    requestId: 'req-command',
    itemId: 'h-c1',
    kind: 'command',
    title: '运行命令',
    command: 'git push -u origin feat/draft',
    description: '把 feat/draft 推到远端并设置上游',
    alwaysScopes: ALWAYS,
  },
)

const PENDING_EDIT = change('src/session/Composer.jsx', 'update', [
  '@@ -6,7 +6,9 @@',
  '     <textarea',
  '       value={text}',
  '       onChange={event => setText(event.target.value)}',
  '-      placeholder="描述你要做的事"',
  '+      placeholder="描述你要做的事，@ 引用文件"',
  '+      aria-label="输入框"',
  '+      rows={3}',
  '     />',
  '   )',
  ' }',
])

const approveFile = waiting(
  'demo-claude-approve-file',
  '输入框加上无障碍标签，占位文字提示一下可以 @ 文件',
  '改 `src/session/Composer.jsx` 的占位文字和 `aria-label`。',
  { kind: 'file_change', id: 'i-f1', changes: [PENDING_EDIT], status: 'running' },
  {
    requestId: 'req-file',
    itemId: 'i-f1',
    kind: 'file_change',
    title: '修改文件',
    changes: [PENDING_EDIT],
    alwaysScopes: ALWAYS,
  },
  { permissionMode: 'ask' },
)

const PR_INPUT = {
  owner: 'pixel',
  repo: 'pixel-web',
  title: '输入框草稿按会话保存',
  head: 'feat/draft',
  base: 'main',
  body: '切换会话时草稿不再丢失。\n\n- 新增 useDraft\n- 补测试 3 个',
}

const approveTool = waiting(
  'demo-claude-approve-tool',
  '开个 PR',
  '用 GitHub 的 MCP 工具开 PR。',
  {
    kind: 'tool',
    id: 'j-t1',
    tool: 'mcp',
    name: 'mcp__github__create_pull_request',
    title: 'github · create_pull_request',
    output: '',
    status: 'running',
  },
  {
    requestId: 'req-tool',
    itemId: 'j-t1',
    kind: 'tool',
    title: '使用 mcp__github__create_pull_request',
    toolName: 'mcp__github__create_pull_request',
    description: 'github · create_pull_request',
    input: PR_INPUT,
    alwaysScopes: ALWAYS,
  },
)

// 同时几项：AI 一次并行调用几个要审批的工具（docs/ui/approval-stack.md）
const MANY_GREPS = [
  { id: 'm-g1', pattern: 'providerOf|function providerOf', path: 'D:\\work\\pixel-web\\src\\client\\format.ts' },
  { id: 'm-g2', pattern: 'provider|anthropic|openai|MODEL_|model_name', path: 'D:\\work\\deeperseeker\\app.py' },
  { id: 'm-g3', pattern: 'provider', path: 'D:\\work\\pixel-web\\src\\wire.ts' },
]
const LOG_CLEAN = {
  command: 'Get-ChildItem -Recurse -Filter *.log | Remove-Item',
  wrapper: {
    line: '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Recurse -Filter *.log | Remove-Item"',
    shell: 'powershell',
    extra: ['-NoProfile', '-ExecutionPolicy', 'Bypass'],
  },
}
const approveMany = snapshot(
  record('demo-claude-approve-many', { updatedAt: T0 }),
  [
    user('m-u', '看一下 provider 是从哪里来的，顺便把 PR 开了、推上去', 1, { turnId: 'm-turn' }),
    assistant('m-a', '我在几个项目里同时搜一下 provider 相关的代码，再开 PR、推送分支。'),
    {
      kind: 'tool',
      id: 'm-pr',
      tool: 'mcp',
      name: 'mcp__github__create_pull_request',
      title: 'github · create_pull_request',
      output: '',
      status: 'running',
    },
    ...MANY_GREPS.map(
      (g): Item => ({
        kind: 'tool',
        id: g.id,
        tool: 'mcp',
        name: 'mcp__fastctx__grep',
        title: `fastctx · grep ${g.pattern}`,
        output: '',
        status: 'running',
      }),
    ),
    {
      kind: 'command',
      id: 'm-c',
      command: 'git push -u origin feat/draft',
      description: '把 feat/draft 推到远端并设置上游',
      output: '',
      exitCode: null,
      status: 'running',
    },
    {
      kind: 'command',
      id: 'm-w',
      ...LOG_CLEAN,
      description: null,
      output: '',
      exitCode: null,
      status: 'running',
    },
  ],
  {
    state: 'waiting',
    turnId: 'm-turn',
    execution: { model: 'claude-opus-5-5', effort: 'high', platform: null },
    pending: [
      {
        requestId: 'req-many-pr',
        itemId: 'm-pr',
        kind: 'tool',
        title: '使用 mcp__github__create_pull_request',
        toolName: 'mcp__github__create_pull_request',
        description: 'github · create_pull_request',
        input: PR_INPUT,
        alwaysScopes: ALWAYS,
      },
      ...MANY_GREPS.map(
        (g): ApprovalRequest => ({
          requestId: `req-many-${g.id}`,
          itemId: g.id,
          kind: 'tool',
          title: '使用 mcp__fastctx__grep',
          toolName: 'mcp__fastctx__grep',
          description: 'fastctx · grep',
          input: { pattern: g.pattern, path: g.path, output_mode: 'content', line_numbers: true, head_limit: 60 },
          alwaysScopes: ALWAYS,
        }),
      ),
      {
        requestId: 'req-many-push',
        itemId: 'm-c',
        kind: 'command',
        title: '运行命令',
        command: 'git push -u origin feat/draft',
        description: '把 feat/draft 推到远端并设置上游',
        alwaysScopes: ALWAYS,
      },
      {
        requestId: 'req-many-wrapped',
        itemId: 'm-w',
        kind: 'command',
        title: 'Codex 要运行命令',
        ...LOG_CLEAN,
        alwaysScopes: ALWAYS,
      },
    ],
  },
)

const question = waiting(
  'demo-claude-question',
  '草稿过期要不要清掉？你定个方案',
  '有两点需要你决定。',
  {
    kind: 'tool',
    id: 'k-t1',
    tool: 'other',
    name: 'AskUserQuestion',
    title: '草稿放多久没动就清掉？',
    output: '',
    status: 'running',
  },
  {
    requestId: 'req-question',
    itemId: 'k-t1',
    kind: 'question',
    title: 'Claude 想问你',
    alwaysScopes: [],
    questions: [
      {
        header: '过期',
        question: '草稿放多久没动就清掉？',
        multiSelect: false,
        allowOther: true,
        options: [
          { label: '7 天（推荐）', description: '一周没回来的会话多半不会再用' },
          { label: '30 天', description: '保守一些，占的空间也不大' },
          { label: '不清', description: '只在发送成功或删除会话时清' },
        ],
      },
      {
        header: '提示',
        question: '恢复草稿时要不要提示？',
        multiSelect: true,
        allowOther: true,
        options: [
          { label: '输入框上方一行字（推荐）', description: '「已恢复上次没发出的内容」' },
          { label: '侧栏会话旁的小圆点', description: '有草稿的会话标出来' },
        ],
      },
    ],
  },
)

const PLAN = `## 草稿过期清理

1. \`useDraft.ts\` 存草稿时带上时间：\`{ text, savedAt }\`
2. 启动时扫一遍 \`draft:*\`，超过 7 天的删掉
3. 旧格式（纯字符串）当作刚保存，下次写入时换成新格式

**不改**：发送和删除会话时的清理照旧。

测试：新增 2 条（过期删除、旧格式兼容）。`

const plan = waiting(
  'demo-claude-plan',
  '按 7 天过期做，先给我看计划',
  '计划写好了。',
  {
    kind: 'tool',
    id: 'l-t1',
    tool: 'other',
    name: 'ExitPlanMode',
    title: '草稿过期清理',
    output: PLAN,
    status: 'running',
  },
  {
    requestId: 'req-plan',
    itemId: 'l-t1',
    kind: 'plan',
    title: '计划已就绪，要开始执行吗？',
    plan: PLAN,
    alwaysScopes: [],
  },
  { permissionMode: 'plan' },
)

// 长对话（docs/ui/turn-rail.md）：30 轮来回，看轮次跳转条
const LONG_ASKS = [
  '先看一下输入框草稿现在是怎么存的',
  '切换会话时草稿为什么会丢？',
  '把草稿改成按会话保存',
  '存的时候带上时间',
  '启动时清掉 7 天没动的草稿',
  '旧格式的草稿要兼容',
  '加两个测试：过期删除、旧格式兼容',
  '跑一下测试',
  '恢复草稿时在输入框上方提示一行字',
  '提示几秒后自动消失',
  '侧栏有草稿的会话标个小圆点',
  '小圆点颜色用设计变量',
  '深色模式下再看一眼',
  '窄窗格时提示文字截断',
  '发送成功后清草稿',
  '删除会话时也清掉',
  '多窗口同时开同一个会话会怎样？',
  '用 storage 事件同步',
  '写一下这块的说明文档',
  '文档里加一张存储位置的表',
  '检查一遍有没有遗漏的地方',
  '粘贴大段文字时草稿会卡吗？',
  '存之前加 300ms 防抖',
  '防抖期间关窗口会丢吗？',
  '关窗口前立即写一次',
  '再跑一遍全部测试',
  '构建一下',
  '总结一下这次改了什么',
  '列一下还没做的',
  '好，先这样，提交吧',
]
const long = snapshot(
  record('demo-claude-long', { updatedAt: T0 - 1 * MIN }),
  LONG_ASKS.flatMap((ask, i) => [
    user(`lg-u${i}`, ask, 90 - i * 3),
    assistant(
      `lg-a${i}`,
      [
        `第 ${i + 1} 轮：${ask.replace(/[？?]$/, '')}，已处理。`,
        '',
        '- 改动在 `src/session/useDraft.ts`',
        '- 相关测试 `useDraft.test.ts` 通过',
        '',
        '下一步可以继续。',
      ].join('\n'),
    ),
    stats(`lg-s${i}`, 'completed', {
      durationMs: 8_000 + i * 700,
      models: { 'claude-opus-5-5': opus(900, 320, 0.03) },
    }),
  ]),
)

// 超长对话（docs/ui/turn-rail.md §9）：120 轮，打开时只显示最近 20 轮；第 3 轮有一条可搜索的独特词，第 60 轮带一条引导消息
const long120 = snapshot(
  record('demo-claude-long-120', { updatedAt: T0 - 1 * MIN }),
  Array.from({ length: 120 }, (_, i) => {
    const ask = `${LONG_ASKS[i % LONG_ASKS.length]}（第 ${i + 1} 轮${i === 2 ? '，暗号：蓝鲸夜航' : ''}）`
    return [
      user(`l120-u${i}`, ask, 400 - i * 3),
      ...(i === 59 ? [user('l120-g59', '补充一句：别动旧格式', 400 - i * 3 - 1, { mode: 'guidance' })] : []),
      assistant(
        `l120-a${i}`,
        [`第 ${i + 1} 轮：${LONG_ASKS[i % LONG_ASKS.length]}，已处理。`, '', '- 改动在 `src/session/useDraft.ts`'].join(
          '\n',
        ),
      ),
      stats(`l120-s${i}`, 'completed', {
        durationMs: 8_000 + i * 100,
        models: { 'claude-opus-5-5': opus(900, 320, 0.03) },
      }),
    ]
  }).flat(),
)

// ---------- 后台子智能体：一轮一张改动卡片，按子智能体分组（GitHub #40，docs/ui/subagent-changes.md） ----------

const BG_AGENTS = [
  { id: 'agent-bg-composer', call: 'bg-t1', label: '拆分 Composer 的状态' },
  { id: 'agent-bg-draft', call: 'bg-t2', label: '草稿改用 IndexedDB' },
  { id: 'agent-bg-tests', call: 'bg-t3', label: '补齐草稿的测试' },
] as const

const BG_FAILED = { id: 'agent-bg-lint', call: 'bg-t4', label: '跑全量 lint' } as const
const BG_STOPPED_WF_CALL = 'bg-w1'

const bgEdit = (id: string, agent: (typeof BG_AGENTS)[number] | null, path: string, lines: string[]): Item => ({
  kind: 'file_change',
  id,
  changes: [change(path, 'update', lines)],
  status: 'completed',
  ...(agent ? { subagent: agent.label, subagentCall: agent.call } : {}),
})

const bgAgentCall = (agent: { call: string; label: string }, output: string): Item => ({
  kind: 'tool',
  id: agent.call,
  tool: 'task',
  name: 'Agent',
  title: agent.label,
  output,
  status: 'completed',
})

const BG_EDITS = {
  main: ['@@ -1,3 +1,4 @@', ' # pixel-web', ' ', '+草稿按会话保存，切换会话不会丢。'],
  composerState: [
    '@@ -12,6 +12,4 @@',
    '-  const [text, setText] = useState(draft)',
    '-  const [files, setFiles] = useState([])',
    '+  const { text, setText, files, setFiles } = useComposerState(draft)',
    '   const send = useSend(sessionId)',
  ],
  composerHook: [
    '@@ -8,3 +8,3 @@',
    '-      <Composer sessionId={id} />',
    '+      <Composer sessionId={id} draft={draft} />',
    '     </main>',
  ],
  draftStore: [
    '@@ -1,4 +1,6 @@',
    "-const KEY = 'draft:'",
    "+import { openDB } from './db'",
    '+',
    "+const STORE = 'drafts'",
    ' export async function loadDraft(id) {',
    '-  return localStorage.getItem(KEY + id)',
    '+  return (await openDB()).get(STORE, id)',
  ],
  draftComposer: [
    '@@ -3,3 +3,3 @@',
    "-import { loadDraft } from './draftStorage'",
    "+import { loadDraft } from './draftStore'",
    ' ',
  ],
  draftTest: [
    '@@ -20,2 +20,9 @@',
    ' })',
    '+',
    "+it('IndexedDB 不可用时退回内存', async () => {",
    "+  indexedDB.open = () => { throw new Error('blocked') }",
    "+  await saveDraft('s1', '你好')",
    "+  expect(await loadDraft('s1')).toBe('你好')",
    '+})',
  ],
}

const subagents = snapshot(
  record('demo-claude-subagents', { updatedAt: T0 - 1 * MIN }),
  [
    user('bg-u1', '草稿相关的三块重构分给后台子智能体并行做，做完各自汇报', 9),
    bgEdit('bg-f0', null, 'README.md', BG_EDITS.main),
    bgAgentCall(BG_AGENTS[0], '已在后台启动'),
    bgAgentCall(BG_AGENTS[1], '已在后台启动'),
    bgAgentCall(BG_AGENTS[2], '已在后台启动'),
    // 追踪历史演示：一个失败的子智能体、一个被停掉的编排（只有调用，没有改动）
    bgAgentCall(BG_FAILED, '已在后台启动'),
    {
      kind: 'tool',
      id: BG_STOPPED_WF_CALL,
      tool: 'task',
      name: 'Workflow',
      title: '迁移前后对比',
      output: '已在后台启动',
      status: 'completed',
    },
    assistant('bg-a1', '先把 `useDraft` 从入口导出，三个子智能体已在后台开始，完成后我逐个汇报。'),
    stats('bg-s1', 'completed', { durationMs: 21_000, models: { 'claude-opus-5-5': opus(1_900, 620, 0.0451) } }),
    // 子智能体 1 跑完：它的改动在主会话里，带名字和派出它的调用 id；主智能体被唤醒说一句
    bgEdit('bg-f1', BG_AGENTS[0], 'src/session/Composer.jsx', BG_EDITS.composerState),
    bgEdit('bg-f2', BG_AGENTS[0], 'src/session/SessionView.jsx', BG_EDITS.composerHook),
    {
      kind: 'notice',
      id: 'bg-n1',
      level: 'info',
      text: '子智能体已完成：拆分 Composer 的状态',
      task: { toolUseId: BG_AGENTS[0].call, kind: 'agent', status: 'completed', label: '拆分 Composer 的状态' },
    },
    assistant('bg-a2', '「拆分 Composer 的状态」完成：状态挪进了 `useComposerState`，`SessionView.jsx` 改成传草稿。'),
    stats('bg-s2', 'completed', { durationMs: 3_400, models: { 'claude-opus-5-5': opus(2_100, 140, 0.0213) } }),
    // 子智能体 2：也改了 Composer.jsx（同一个文件在两组里，标题只算一个）
    bgEdit('bg-f3', BG_AGENTS[1], 'src/session/useDraft.ts', BG_EDITS.draftStore),
    bgEdit('bg-f4', BG_AGENTS[1], 'src/session/Composer.jsx', BG_EDITS.draftComposer),
    {
      kind: 'notice',
      id: 'bg-n2',
      level: 'info',
      text: '子智能体已完成：草稿改用 IndexedDB',
      task: { toolUseId: BG_AGENTS[1].call, kind: 'agent', status: 'completed', label: '草稿改用 IndexedDB' },
    },
    assistant('bg-a3', '「草稿改用 IndexedDB」完成，`useDraft.ts` 改成读写 IndexedDB。'),
    stats('bg-s3', 'completed', { durationMs: 2_900, models: { 'claude-opus-5-5': opus(2_300, 120, 0.0198) } }),
    bgEdit('bg-f5', BG_AGENTS[2], 'src/session/__tests__/useDraft.test.ts', BG_EDITS.draftTest),
    {
      kind: 'notice',
      id: 'bg-n3',
      level: 'info',
      text: '子智能体已完成：补齐草稿的测试',
      task: { toolUseId: BG_AGENTS[2].call, kind: 'agent', status: 'completed', label: '补齐草稿的测试' },
    },
    assistant('bg-a4', '三个都完成了：测试补了 IndexedDB 不可用时的退路。改动在下面按子智能体分好组了。'),
    stats('bg-s4', 'completed', { durationMs: 3_100, models: { 'claude-opus-5-5': opus(2_500, 160, 0.0236) } }),
  ],
  {
    runs: {
      workflows: [
        {
          id: 'wf-compare',
          name: 'compare',
          description: '迁移前后对比草稿读写',
          status: 'stopped',
          startedAt: T0 - 7 * MIN,
          durationMs: 38_000,
          tokens: 27_000,
          toolCalls: 8,
          phases: [{ index: 1, title: '对比' }],
          agents: [
            agentRun('wf-cmp-old', '旧读写路径', { phase: 1, durationMs: 21_000, result: '旧路径梳理完成。' }),
            agentRun('wf-cmp-new', '新读写路径', { phase: 1, durationMs: 24_000, result: '新路径梳理完成。' }),
            agentRun('wf-cmp-diff', '逐项对比', { phase: 1, state: 'stopped', durationMs: 9_000, result: '' }),
          ],
          toolUseId: BG_STOPPED_WF_CALL,
        },
      ],
      agents: [
        ...BG_AGENTS.map((a, i) =>
          agentRun(a.id, a.label, {
            type: 'general-purpose',
            toolUseId: a.call,
            startedAt: T0 - (9 - i) * MIN,
            durationMs: (3 + i) * 60_000,
            result: `${a.label}：完成`,
          }),
        ),
        agentRun(BG_FAILED.id, BG_FAILED.label, {
          type: 'general-purpose',
          state: 'failed',
          toolUseId: BG_FAILED.call,
          startedAt: T0 - 3 * MIN,
          durationMs: 47_000,
          result: 'eslint exited with code 2: out of memory while linting src/',
        }),
      ],
    },
  },
)

// ---------- 停止主智能体时连同后台子智能体（docs/ui/subagent-stop.md） ----------

const STOP_AGENTS = [
  { id: 'agent-stop-form', call: 'ss-t1', label: '查设置页的旧表单' },
  { id: 'agent-stop-test', call: 'ss-t2', label: '跑一遍设置页测试' },
] as const
const STOP_DONE = { id: 'agent-stop-field', call: 'ss-t3', label: '整理旧表单字段' } as const

const stopAgentStatus = (a: { id: string; label: string }, status: string, message: string | null = null) => ({
  id: a.id,
  label: a.label,
  status,
  message,
  background: true,
})
const stopAgentRun = (a: { id: string; call: string; label: string }, patch: Partial<AgentRun> = {}): AgentRun =>
  agentRun(a.id, a.label, {
    type: 'general-purpose',
    state: 'running',
    startedAt: T0 - 2 * MIN,
    durationMs: 0,
    toolUseId: a.call,
    ...patch,
  })
const stopTask = (a: { id: string; label: string }, message: string | null = null) => ({
  id: a.id,
  kind: 'local_agent',
  description: a.label,
  message,
})

const subagentStop = snapshot(
  record('demo-claude-subagent-stop', { updatedAt: T0 - 1 * MIN }),
  [
    user('ss-u1', '把设置页的旧表单查一遍，再跑一遍设置页测试', 6),
    assistant('ss-a1', '好，我派两个后台子智能体去查旧表单、跑测试。', 'interrupted'),
    stats('ss-s1', 'interrupted', { durationMs: 12_000, models: { 'claude-opus-5-5': opus(1_800, 240, 0.0211) } }),
    {
      kind: 'notice',
      id: 'ss-n1',
      level: 'info',
      text: '已停止，连同 2 个后台子智能体（查设置页的旧表单、跑一遍设置页测试）',
    },
    user('ss-u2', '重新来，这次把旧表单字段也整理了', 2),
    bgAgentCall(STOP_AGENTS[0], '已在后台启动'),
    bgAgentCall(STOP_AGENTS[1], '已在后台启动'),
    bgAgentCall(STOP_DONE, '已在后台启动'),
    assistant('ss-a2', '三个子智能体都已在后台开始，我先等它们的结果。'),
  ],
  {
    state: 'running',
    turnId: 'ss-turn-2',
    background: 2,
    subagents: [
      stopAgentStatus(STOP_AGENTS[0], 'running', 'Grep form'),
      stopAgentStatus(STOP_AGENTS[1], 'running', 'pnpm test settings'),
      stopAgentStatus(STOP_DONE, 'stopped'),
    ],
    tasks: [stopTask(STOP_AGENTS[0], 'Grep form'), stopTask(STOP_AGENTS[1], 'pnpm test settings')],
    runs: {
      workflows: [],
      agents: [
        stopAgentRun(STOP_AGENTS[0]),
        stopAgentRun(STOP_AGENTS[1], { type: 'Explore' }),
        stopAgentRun(STOP_DONE, { state: 'stopped', durationMs: 31_000 }),
      ],
    },
  },
)

const subagentKept = snapshot(
  record('demo-claude-subagent-kept', { updatedAt: T0 - 1 * MIN }),
  [
    user('sk-u1', '把设置页的旧表单查一遍，再跑一遍设置页测试', 4),
    bgAgentCall({ call: 'sk-t1', label: '查设置页的旧表单' }, '已在后台启动'),
    bgAgentCall({ call: 'sk-t2', label: '跑一遍设置页测试' }, '已在后台启动'),
    assistant('sk-a1', '两个子智能体已在后台开始，正在汇总', 'interrupted'),
    stats('sk-s1', 'interrupted', { durationMs: 9_000, models: { 'claude-opus-5-5': opus(1_600, 180, 0.0187) } }),
  ],
  {
    background: 2,
    subagents: [
      stopAgentStatus({ id: 'agent-keep-form', label: '查设置页的旧表单' }, 'running', 'Grep form'),
      stopAgentStatus({ id: 'agent-keep-test', label: '跑一遍设置页测试' }, 'running', 'pnpm test settings'),
    ],
    tasks: [
      stopTask({ id: 'agent-keep-form', label: '查设置页的旧表单' }, 'Grep form'),
      stopTask({ id: 'agent-keep-test', label: '跑一遍设置页测试' }, 'pnpm test settings'),
    ],
    runs: {
      workflows: [],
      agents: [
        stopAgentRun({ id: 'agent-keep-form', call: 'sk-t1', label: '查设置页的旧表单' }),
        stopAgentRun({ id: 'agent-keep-test', call: 'sk-t2', label: '跑一遍设置页测试' }, { type: 'Explore' }),
      ],
    },
  },
)

export const showcaseSnapshots: Record<string, SessionSnapshot> = Object.fromEntries(
  [
    markdown,
    tools,
    userMessages,
    errors,
    platform,
    sendFailures,
    running,
    compacting,
    steps,
    compactions,
    starting,
    approveCommand,
    approveFile,
    approveTool,
    approveMany,
    question,
    plan,
    long,
    long120,
    subagents,
    subagentStop,
    subagentKept,
  ].map(s => [s.record.id, s]),
)

// ---------- 智能体追踪里的子智能体记录、后台任务输出 ----------

const SUBAGENT_ITEMS: Record<string, Item[]> = {
  'agent-explore': [
    user('x-u1', '在 src 里找出所有读写输入框草稿的地方，说明切换会话时草稿为什么会丢。', 13),
    {
      kind: 'tool',
      id: 'x-t1',
      tool: 'search',
      name: 'Grep',
      title: 'draft · src',
      output: 'src/session/Composer.jsx\nsrc/session/SessionView.jsx',
      status: 'completed',
    },
    {
      kind: 'tool',
      id: 'x-t2',
      tool: 'read',
      name: 'Read',
      title: 'src/session/SessionView.jsx',
      output: numbered(SHOWCASE_FILES['src/session/SessionView.jsx']),
      status: 'completed',
    },
    assistant(
      'x-a1',
      '用到草稿的只有两处：Composer.jsx 自己的 state，和 SessionView.jsx 切换会话时重新挂载 Composer。',
    ),
  ],
  'agent-tests': [
    user('y-u1', '给 useDraft 补一条测试：localStorage.setItem 抛 QuotaExceededError 时草稿仍留在内存里。', 2),
    {
      kind: 'tool',
      id: 'y-t1',
      tool: 'read',
      name: 'Read',
      title: 'src/session/__tests__/useDraft.test.ts',
      output: numbered(SHOWCASE_FILES['src/session/__tests__/useDraft.test.ts']),
      status: 'completed',
    },
    {
      kind: 'command',
      id: 'y-c1',
      command: 'npm test -- src/session --run',
      description: '跑草稿测试',
      output: '',
      exitCode: null,
      status: 'running',
    },
  ],
  'agent-readme': [
    user('z-u1', '在 README 里补一段草稿的说明：只存在本机，发送成功后清掉。', 3),
    {
      kind: 'file_change',
      id: 'z-f1',
      changes: [
        change('README.md', 'update', [
          '@@ -1,3 +1,5 @@',
          ' # pixel-web',
          ' ',
          ' 这是文件面板的演示内容。',
          '+',
          '+草稿只存在这台电脑上，发送成功后清掉。',
        ]),
      ],
      status: 'completed',
    },
    assistant('z-a1', 'README 已更新：补了「草稿只存在本机、发送成功后清掉」两句。'),
  ],
}

// 后台子智能体自己的对话：任务说明 + 它的改动（主会话里同样的条目，不带子智能体名字）
for (const [i, agent] of BG_AGENTS.entries()) {
  const own = subagents.items.filter(it => it.kind === 'file_change' && it.subagentCall === agent.call)
  SUBAGENT_ITEMS[agent.id] = [
    user(`bg-x${i}`, agent.label, 9 - i),
    ...own.map(it =>
      it.kind === 'file_change' ? { kind: it.kind, id: `${it.id}-own`, changes: it.changes, status: it.status } : it,
    ),
    assistant(`bg-xa${i}`, `${agent.label}：完成`),
  ]
}

SUBAGENT_ITEMS[BG_FAILED.id] = [user('bg-xf0', BG_FAILED.label, 3), assistant('bg-xfa', '失败：eslint 内存不足退出。')]

export function showcaseSubagentTranscript(_sessionId: string, agentId: string): Item[] {
  const items = SUBAGENT_ITEMS[agentId]
  if (!items) throw new Error('演示里没有这个智能体的记录')
  return items
}

const TASK_OUTPUT: Record<string, TaskOutput> = {
  'task-dev': {
    output: [
      '> pixel-web@0.1.0 dev',
      '> vite',
      '',
      `  ${ESC}32m${ESC}1mVITE${ESC}22m v6.3.5${ESC}39m  ${ESC}2mready in ${ESC}0m${ESC}1m298${ESC}22m${ESC}2m${ESC}0m ms${ESC}22m`,
      '',
      `  ${ESC}32m➜${ESC}39m  ${ESC}1mLocal${ESC}22m:   ${ESC}36mhttp://localhost:${ESC}1m5173${ESC}22m/${ESC}39m`,
      `${ESC}2m10:42:07${ESC}22m ${ESC}36m${ESC}1m[vite]${ESC}22m${ESC}39m ${ESC}32mhmr update ${ESC}39m${ESC}2m/src/session/Composer.jsx${ESC}22m`,
    ].join('\n'),
    truncated: false,
  },
  'task-ci': {
    output: '✓ lint        32s\n✓ unit tests  1m 04s\n… e2e         运行中（2m 10s）',
    truncated: true,
  },
}

for (const a of [STOP_AGENTS[0], STOP_AGENTS[1], STOP_DONE]) {
  SUBAGENT_ITEMS[a.id] = [user(`${a.id}-u`, a.label, 2), assistant(`${a.id}-a`, '进行中。')]
  TASK_OUTPUT[a.id] = { output: `${a.label}：进行中`, truncated: false }
}
for (const [id, label] of [
  ['agent-keep-form', '查设置页的旧表单'],
  ['agent-keep-test', '跑一遍设置页测试'],
] as const) {
  SUBAGENT_ITEMS[id] = [user(`${id}-u`, label, 3), assistant(`${id}-a`, '进行中。')]
  TASK_OUTPUT[id] = { output: `${label}：进行中`, truncated: false }
}

export function showcaseTaskOutput(_sessionId: string, taskId: string): TaskOutput {
  const output = TASK_OUTPUT[taskId]
  if (!output) throw new Error('演示里没有这个任务的输出')
  return output
}
