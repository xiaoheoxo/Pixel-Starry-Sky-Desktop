// Git 面板的演示数据（docs/ui/git-panel.md），只在 `pnpm dev:demo` 显示
import type {
  GitBranch,
  GitCommit,
  GitCommitDetail,
  GitCommitFile,
  GitCompareTarget,
  GitCompareResult,
  GitDiff,
  GitFileChange,
  GitLogPage,
  GitLogQuery,
  GitModule,
  GitRefLabel,
  GitRefs,
  GitStatus,
} from '../../../shared/types/project-tools'
import { CODING_FILES } from './coding'

const file = (path: string, code: GitFileChange['code'], origPath: string | null = null): GitFileChange => ({
  path,
  origPath,
  code,
  local: path,
  submodule: false,
})
/** 带改动行数的（Git 面板开着「改动行数」时有，docs/ui/git-panel.md §10.1） */
const counted = (path: string, code: GitFileChange['code'], insertions: number, deletions: number): GitFileChange => ({
  ...file(path, code),
  insertions,
  deletions,
})

/** 按模块分组用（docs/ui/git-panel.md §10）：仓库根 + 两个子模块 */
export const demoGitModules: GitModule[] = [
  { dir: '', name: 'pixel-web', kind: 'npm' },
  { dir: 'apps/mobile', name: 'pixel_mobile', kind: 'Flutter' },
  { dir: 'packages/ui', name: '@pixel/ui', kind: 'npm' },
]

export const demoGitStatus: GitStatus = {
  repo: true,
  missing: false,
  root: 'D:/pixel-web',
  branch: 'feat/settings-form',
  detached: false,
  head: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  initial: false,
  upstream: 'origin/feat/settings-form',
  ahead: 4,
  behind: 2,
  remotes: ['origin'],
  conflicted: [],
  staged: [counted('src/settings/AccountForm.tsx', 'M', 24, 8), counted('src/settings/fields/useField.ts', 'A', 61, 0)],
  unstaged: [
    counted('src/settings/AccountForm.tsx', 'M', 6, 2),
    counted('src/settings/AppearanceForm.tsx', 'M', 18, 11),
    counted('src/legacy/OldForm.tsx', 'D', 0, 142),
    counted('src/session/SessionHeader.tsx', 'M', 3, 3),
    counted('src/machines/store.ts', 'M', 40, 7),
    counted('packages/ui/src/Button.tsx', 'M', 12, 4),
    counted('packages/ui/package.json', 'M', 1, 1),
    counted('apps/mobile/lib/settings_page.dart', 'M', 27, 9),
  ],
  untracked: [
    file('docs/表单迁移.md', '?'),
    file('src/machines/MachineSwitch.tsx', '?'),
    file('apps/mobile/build/app/outputs/app-debug.apk', '?'),
    file('apps/mobile/build/app/outputs/output-metadata.json', '?'),
  ],
  truncated: false,
  operation: null,
  fetchedAt: Date.now() - 6 * 60_000,
  busySessions: 0,
}

export const demoGitBranches: GitBranch[] = [
  {
    name: 'feat/settings-form',
    remote: false,
    upstream: 'origin/feat/settings-form',
    current: true,
    worktree: null,
    committedAt: Date.now() - 3600_000,
  },
  {
    name: 'main',
    remote: false,
    upstream: 'origin/main',
    current: false,
    worktree: null,
    committedAt: Date.now() - 86400_000,
  },
  {
    name: 'pixelsky/review-ui',
    remote: false,
    upstream: null,
    current: false,
    worktree: 'D:/pixel-web-copies/review-ui',
    committedAt: Date.now() - 2 * 86400_000,
  },
  {
    name: 'origin/main',
    remote: true,
    upstream: null,
    current: false,
    worktree: null,
    committedAt: Date.now() - 86400_000,
  },
  {
    name: 'origin/release/0.1',
    remote: true,
    upstream: null,
    current: false,
    worktree: null,
    committedAt: Date.now() - 5 * 86400_000,
  },
]

const before = `import { useState } from 'react'

export function AccountForm() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const valid = email.includes('@')
  return (
    <form>
      <input value={name} onChange={e => setName(e.target.value)} />
      <input value={email} onChange={e => setEmail(e.target.value)} />
      {!valid && <p className="error">邮箱格式不对</p>}
      <button disabled={!valid}>保存</button>
    </form>
  )
}
`
const after = `import { useField } from './fields/useField'

export function AccountForm() {
  const name = useField('')
  const email = useField('', value => value.includes('@') ? null : '请输入有效的邮箱')
  return (
    <form>
      <input {...name.props} />
      <input {...email.props} />
      {email.error && <p className="error">{email.error}</p>}
      <button disabled={!!email.error}>保存</button>
    </form>
  )
}
`
export function demoGitDiff(path: string): GitDiff {
  const coding = CODING_FILES[path]
  if (coding) return { path, original: coding.before, modified: coding.after, binary: false, tooLarge: false }
  if (path.endsWith('AccountForm.tsx'))
    return { path, original: before, modified: after, binary: false, tooLarge: false }
  if (path.endsWith('useField.ts'))
    return {
      path,
      original: '',
      modified:
        "import { useState } from 'react'\n\nexport function useField(initial: string, validate?: (value: string) => string | null) {\n  const [value, setValue] = useState(initial)\n  const error = validate?.(value) ?? null\n  return { value, error, props: { value, onChange: (e: { target: { value: string } }) => setValue(e.target.value) } }\n}\n",
      binary: false,
      tooLarge: false,
    }
  if (path.endsWith('OldForm.tsx'))
    return {
      path,
      original: 'export function OldForm() {\n  return null\n}\n',
      modified: null,
      binary: false,
      tooLarge: false,
    }
  return { path, original: '', modified: '# 表单迁移\n\n- [x] 账号\n- [ ] 外观\n', binary: false, tooLarge: false }
}

// ---------------------------------------------------------------------------
// 提交历史（docs/ui/git-panel.md §9）：功能分支领先 2 个、落后 1 个（和上面的状态一致），
// 基础分支 main 上有一次合并和两个标签，另有一个远端发布分支
// ---------------------------------------------------------------------------
const hash = (seed: string): string => (seed.repeat(40) + '0'.repeat(40)).slice(0, 40)
const HOUR = 3600_000,
  DAY = 24 * HOUR
type DemoCommit = GitCommit & { files: GitCommitFile[] }
const changed = (path: string, code: GitCommitFile['code'], ins: number | null, del: number | null, orig?: string) => ({
  path,
  origPath: orig ?? null,
  code,
  insertions: ins,
  deletions: del,
  local: code === 'D' ? null : path,
})
function demoCommit(
  id: string,
  parents: string[],
  ago: number,
  author: [string, string],
  message: string,
  refs: GitRefLabel[],
  files: GitCommitFile[],
): DemoCommit {
  const [subject, ...rest] = message.split('\n')
  const at = Date.now() - ago
  return {
    hash: hash(id),
    parents: parents.map(hash),
    author: author[0],
    email: author[1],
    authoredAt: at,
    committedAt: at,
    subject,
    body: rest.join('\n').replace(/^\n+/, ''),
    refs,
    stat: {
      files: files.length,
      insertions: files.reduce((n, f) => n + (f.insertions ?? 0), 0),
      deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
    },
    files,
  }
}
const ME: [string, string] = ['陈默', 'chenmo@pixel.dev'],
  LIN: [string, string] = ['林夏', 'linxia@pixel.dev'],
  BOT: [string, string] = ['Claude', 'noreply@anthropic.com']
const HISTORY: DemoCommit[] = [
  demoCommit(
    'e2',
    ['e1'],
    25 * 60_000,
    LIN,
    '表单提示文字统一用 muted 色',
    [{ kind: 'remote', name: 'origin/feat/settings-form' }],
    [changed('src/settings/settings.css', 'M', 3, 3)],
  ),
  demoCommit(
    'e1',
    ['c8'],
    40 * 60_000,
    LIN,
    '修正表单之间的间距',
    [],
    [changed('src/settings/settings.css', 'M', 6, 4)],
  ),
  demoCommit(
    'a1b2c3d4e5f6',
    ['u3'],
    HOUR,
    ME,
    '表单字段改用 useField\n\n账号表单和外观表单共用一套字段状态和校验，去掉重复的 useState。',
    [{ kind: 'branch', name: 'feat/settings-form', current: true }],
    [
      changed('src/settings/AccountForm.tsx', 'M', 8, 9),
      changed('src/settings/fields/useField.ts', 'A', 6, 0),
      changed('src/legacy/OldForm.tsx', 'D', 0, 3),
    ],
  ),
  demoCommit(
    'u3',
    ['u2'],
    2 * HOUR,
    ME,
    '外观表单补上主题预览',
    [],
    [changed('src/settings/AppearanceForm.tsx', 'M', 10, 2)],
  ),
  demoCommit(
    'u2',
    ['c9'],
    2.5 * HOUR,
    ME,
    '字段错误提示加无障碍标记',
    [],
    [changed('src/settings/fields/useField.ts', 'M', 5, 1)],
  ),
  demoCommit(
    'c9',
    ['c8'],
    3 * HOUR,
    BOT,
    '账号表单加邮箱校验提示',
    [],
    [changed('src/settings/AccountForm.tsx', 'M', 4, 1)],
  ),
  demoCommit(
    'l1',
    ['c8'],
    DAY + 8 * HOUR,
    LIN,
    '试验：设置页改成两栏布局',
    [{ kind: 'branch', name: 'feat/layout' }],
    [changed('src/settings/SettingsPage.tsx', 'M', 20, 6)],
  ),
  demoCommit(
    'c8',
    ['c7'],
    DAY + 2 * HOUR,
    ME,
    '设置页拆成独立表单',
    [],
    [
      changed('src/settings/AccountForm.tsx', 'A', 15, 0),
      changed('src/settings/AppearanceForm.tsx', 'A', 22, 0),
      changed('src/settings/SettingsPage.tsx', 'M', 5, 41),
    ],
  ),
  demoCommit(
    'c7',
    ['b3'],
    2 * DAY,
    ME,
    '新增设置页路由\n\n- /settings/account\n- /settings/appearance\n\n旧的 /preferences 跳转到 /settings/account。',
    [],
    [changed('src/routes.tsx', 'M', 12, 2), changed('src/settings/SettingsPage.tsx', 'A', 48, 0)],
  ),
  demoCommit(
    'b4',
    ['b3', 'f1'],
    2 * DAY + 5 * HOUR,
    LIN,
    "Merge branch 'fix/login-redirect'",
    [
      { kind: 'branch', name: 'main' },
      { kind: 'remote', name: 'origin/main' },
    ],
    [changed('src/auth/redirect.ts', 'A', 18, 0), changed('src/auth/LoginPage.tsx', 'M', 3, 1)],
  ),
  demoCommit(
    'f1',
    ['b3'],
    3 * DAY,
    LIN,
    '登录后跳回原来的页面',
    [],
    [changed('src/auth/redirect.ts', 'A', 18, 0), changed('src/auth/LoginPage.tsx', 'M', 3, 1)],
  ),
  demoCommit(
    'b3',
    ['b2'],
    5 * DAY,
    ME,
    '升级到 React 19',
    [{ kind: 'tag', name: 'v0.2.0' }],
    [
      changed('package.json', 'M', 2, 2),
      changed('pnpm-lock.yaml', 'M', 310, 287),
      changed('public/logo.png', 'M', null, null),
    ],
  ),
  demoCommit(
    'b2',
    ['b1'],
    9 * DAY,
    ME,
    '首页改成按需加载',
    [{ kind: 'remote', name: 'origin/release/0.1' }],
    [changed('src/Home.tsx', 'M', 9, 3), changed('src/lazy.ts', 'R', 1, 1, 'src/loadable.ts')],
  ),
  demoCommit(
    'b1',
    [],
    20 * DAY,
    ME,
    '初始化项目',
    [{ kind: 'tag', name: 'v0.1.0' }],
    [changed('package.json', 'A', 24, 0), changed('src/Home.tsx', 'A', 30, 0), changed('src/loadable.ts', 'A', 8, 0)],
  ),
]
const strip = ({ files: _files, ...commit }: DemoCommit): GitCommit => commit
const byHash = (h: string) => HISTORY.find(c => c.hash === h)

function demoLog(query: GitLogQuery): GitLogPage {
  // 自动范围不含远端发布分支独有的提交（这里没有），全部 / 自选都用整份
  const q = query.search?.trim().toLowerCase() ?? ''
  // 单文件历史（§9.15）：改过这个文件的提交（演示数据里跟着 src/lazy.ts ← src/loadable.ts 的改名）
  const path = query.path?.replace(/\\/g, '/')
  const names = new Set(path ? [path] : [])
  // 「自动」范围不含别的本地分支独有的提交
  const visible = query.scope === 'all' ? HISTORY : HISTORY.filter(c => c.hash !== hash('l1'))
  const source: DemoCommit[] = path
    ? visible.flatMap(c => {
        const f = c.files.find(x => names.has(x.path))
        if (!f) return []
        if (f.origPath) names.add(f.origPath)
        return [{ ...c, file: f }]
      })
    : visible
  const list = q
    ? source.filter(
        c =>
          c.subject.toLowerCase().includes(q) ||
          c.body.toLowerCase().includes(q) ||
          c.author.toLowerCase().includes(q) ||
          c.hash.startsWith(q),
      )
    : source
  return {
    commits: list
      .slice(query.skip, query.skip + query.limit)
      .map(c => ({ ...strip(c), ...(path ? { stat: null } : {}) })),
    more: list.length > query.skip + query.limit,
    shallow: false,
    ...(path ? { path } : {}),
  }
}

function demoShow(h: string): GitCommitDetail {
  const c = byHash(h)
  if (!c) throw new Error('找不到这个提交')
  return { commit: strip(c), from: c.parents[0] ?? null, to: c.hash, files: c.files, truncated: false }
}

function demoCompare(target: GitCompareTarget): GitCompareResult {
  // 和分支 / 标签比较（§9.6 第二期）：演示里按「本分支相对 main」给一份
  const kind = typeof target === 'string' ? target : 'base'
  const pick = {
    outgoing: ['a1b2c3d4e5f6', 'u3', 'u2', 'c9'],
    incoming: ['e2', 'e1'],
    base: ['a1b2c3d4e5f6', 'c9', 'c8', 'c7'],
  }[kind]
  const files = new Map<string, GitCommitFile>()
  for (const id of [...pick].reverse()) for (const f of byHash(hash(id))!.files) files.set(f.path, f)
  return {
    from: hash(kind === 'base' ? 'b3' : 'c8'),
    to: hash(kind === 'incoming' ? 'e2' : 'a1b2c3d4e5f6'),
    files: [...files.values()],
    truncated: false,
    commits: pick.length,
  }
}

function demoCommitDiff(input: { path: string }): GitDiff {
  const { path } = input
  if (path.endsWith('.png')) return { path, original: null, modified: null, binary: true, tooLarge: false }
  if (path.endsWith('.css'))
    return {
      path,
      original: '.form {\n  display: grid;\n  gap: 8px;\n}\n\n.form + .form {\n  margin-top: 12px;\n}\n',
      modified:
        '.form {\n  display: grid;\n  gap: 12px;\n}\n\n.form + .form {\n  margin-top: 24px;\n  padding-top: 16px;\n  border-top: 1px solid var(--line);\n}\n',
      binary: false,
      tooLarge: false,
    }
  return demoGitDiff(path)
}

export const demoGitHistory = {
  refs: {
    head: hash('a1b2c3d4e5f6'),
    branch: 'feat/settings-form',
    upstream: 'origin/feat/settings-form',
    base: 'main',
    local: ['feat/settings-form', 'feat/layout', 'main', 'pixelsky/review-ui'],
    remote: ['origin/feat/settings-form', 'origin/main', 'origin/release/0.1'],
    tags: ['v0.1.0', 'v0.2.0'],
  } satisfies GitRefs,
  log: demoLog,
  show: demoShow,
  compare: demoCompare,
  diff: demoCommitDiff,
}
