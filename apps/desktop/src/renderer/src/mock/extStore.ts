// 演示模式下的扩展商店（--demo）：发现页的目录数据和一个假的预加载桥，主进程那边只回空数据。
// 目录接口的搜索、分类、排序、翻页（每页 30 个、next_before 是偏移量）在这里照云端的规则自己算一遍。
import type {
  ExtPackContributes,
  ExtPackContributionKind,
  ExtPackIssue,
  ExtPackManifest,
  ExtStoreCatalogPage,
  ExtStoreCheckReport,
  ExtStoreDetail,
  ExtStoreItem,
  ExtStoreMyExtension,
  ExtStoreMyVersion,
  ExtStorePickUploadResult,
  ExtStorePublisherState,
  ExtStoreUpdates,
  ExtStoreVersion,
} from '@pixelsky/protocol'
import type { DemoSource } from '@/data/demo'
import type { ExtStoreBridge } from '../../../preload/extstore'

const PAGE = 30

/** 图标：纯色圆角方块里放两个字母（data: 地址，渲染层 CSP 放行） */
function icon(label: string, color: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${color}"/>` +
    `<text x="16" y="21" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-size="14" font-weight="700" fill="#fff">${label}</text></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const CODE: ExtPackContributionKind[] = ['grammars', 'themes', 'snippets', 'iconThemes', 'taskTemplates']
const categoriesOf = (kinds: string[]): string[] => [
  ...(kinds.some(k => CODE.includes(k as ExtPackContributionKind)) ? ['code'] : []),
  ...(kinds.some(k => k === 'skills' || k === 'prompts') ? ['ai'] : []),
]

function item(
  id: string,
  name: string,
  publisher: string,
  official: boolean,
  description: string,
  kinds: ExtPackContributionKind[],
  downloads: number,
  version: string,
  updatedAt: string,
  mark: string,
  color: string,
): ExtStoreItem {
  return {
    id,
    name,
    description,
    publisher: { name: publisher, official },
    version,
    iconUrl: icon(mark, color),
    kinds,
    categories: categoriesOf(kinds),
    downloads,
    installs: Math.round(downloads * 0.6),
    updatedAt,
  }
}

/** 按「推荐」排序的顺序：前 3 个是首屏的大卡片 */
const ITEMS: ExtStoreItem[] = [
  item(
    'pixelsky.swift',
    'Swift 支持',
    'pixelsky',
    true,
    'Swift 语法高亮、代码片段、文件图标',
    ['grammars', 'snippets', 'iconThemes'],
    1284,
    '1.2.0',
    '2026-10-15T08:00:00Z',
    'Sw',
    '#f05138',
  ),
  item(
    'enkia.tokyo-night',
    'Tokyo Night',
    'enkia',
    false,
    '深色主题，三种变体',
    ['themes'],
    940,
    '2.0.1',
    '2026-10-12T08:00:00Z',
    'TN',
    '#24283b',
  ),
  item(
    'mei.review-checklist',
    '代码审查清单',
    'mei',
    false,
    '让 AI 按团队清单审查改动',
    ['skills'],
    410,
    '1.0.3',
    '2026-10-09T08:00:00Z',
    '审',
    '#3b6fb5',
  ),
  item(
    'pixelsky.vue',
    'Vue 支持',
    'pixelsky',
    true,
    '.vue 单文件组件高亮（模板 / 脚本 / 样式）、常用片段',
    ['grammars', 'snippets'],
    2036,
    '1.3.0',
    '2026-10-14T08:00:00Z',
    'Vue',
    '#41b883',
  ),
  item(
    'pkief.material-icon',
    'Material 文件图标',
    'pkief',
    false,
    '文件树和标签上换成 Material 风格的图标，800+ 种文件',
    ['iconThemes'],
    1512,
    '4.2.0',
    '2026-10-01T08:00:00Z',
    'Mi',
    '#e8522a',
  ),
  item(
    'chen.gradle-tasks',
    'Gradle 任务',
    'chen',
    false,
    '「任务」视图里列出 build.gradle(.kts) 的任务，点 ▶ 运行',
    ['taskTemplates'],
    688,
    '0.9.2',
    '2026-09-28T08:00:00Z',
    'Gr',
    '#02303a',
  ),
  item(
    'pixelsky.lua',
    'Lua 支持',
    'pixelsky',
    true,
    'Lua 5.4 / LuaJIT 语法高亮和片段',
    ['grammars', 'snippets'],
    612,
    '1.1.0',
    '2026-10-03T08:00:00Z',
    'Lua',
    '#2c2d72',
  ),
  item(
    'acme.docker-snippets',
    'Docker 片段',
    'acme',
    false,
    'Dockerfile 和 compose 常用片段',
    ['snippets'],
    540,
    '1.0.0',
    '2026-09-20T08:00:00Z',
    'Dk',
    '#1d63ed',
  ),
  item(
    'dracula.theme',
    'Dracula',
    'dracula',
    false,
    '经典紫色暗色主题',
    ['themes'],
    531,
    '3.1.0',
    '2026-09-11T08:00:00Z',
    'Dr',
    '#44475a',
  ),
  item(
    'pixelsky.kotlin',
    'Kotlin 支持',
    'pixelsky',
    true,
    'Kotlin / Kotlin Script 语法高亮和片段',
    ['grammars', 'snippets'],
    498,
    '1.0.4',
    '2026-10-06T08:00:00Z',
    'Kt',
    '#7f52ff',
  ),
  item(
    'lin.commit-prompts',
    '提交信息提示词',
    'lin',
    false,
    '按约定式提交（Conventional Commits）写提交信息的提示词',
    ['prompts'],
    377,
    '1.2.0',
    '2026-10-10T08:00:00Z',
    '提',
    '#c2602b',
  ),
  item(
    'hao.go-tasks',
    'Go 任务',
    'hao',
    false,
    'go build / test / vet 一键运行',
    ['taskTemplates'],
    301,
    '0.4.1',
    '2026-08-30T08:00:00Z',
    'Go',
    '#00a7d0',
  ),
  item(
    'sora.solarized',
    'Solarized',
    'sora',
    false,
    '浅色和深色两套 Solarized 配色',
    ['themes'],
    280,
    '1.5.0',
    '2026-07-19T08:00:00Z',
    'So',
    '#b58900',
  ),
  item(
    'wen.sql-skills',
    'SQL 优化技能',
    'wen',
    false,
    '让 AI 分析慢查询、给出索引建议',
    ['skills', 'prompts'],
    222,
    '0.8.0',
    '2026-10-08T08:00:00Z',
    'SQ',
    '#5b6ee1',
  ),
]

/** 演示里已经装好的（发现页显示「已安装」；其中有新版本的显示「更新」） */
const INSTALLED = ['pixelsky.vue', 'acme.docker-snippets']
const UPDATES: ExtStoreUpdates = { 'acme.docker-snippets': { latest: '1.1.0', engineOk: true } }

const GROUP_KINDS: Record<string, string[]> = {
  code: ['grammars', 'themes', 'snippets', 'iconThemes', 'taskTemplates'],
  ai: ['skills', 'prompts'],
}

function catalog(q = '', category = '', sort = 'recommended', before: string | null = null): ExtStoreCatalogPage {
  const text = q.trim().toLowerCase()
  const kinds = category ? (GROUP_KINDS[category] ?? [category]) : null
  let list = ITEMS.filter(
    i =>
      (!text || [i.id, i.name, i.description, i.publisher.name].join('\n').toLowerCase().includes(text)) &&
      (!kinds || i.kinds.some(k => kinds.includes(k))),
  )
  if (sort === 'downloads') list = [...list].sort((a, b) => b.downloads - a.downloads)
  else if (sort === 'updated') list = [...list].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  const offset = Math.max(0, Number(before) || 0)
  const items = list.slice(offset, offset + PAGE)
  return { items, nextBefore: offset + PAGE < list.length ? String(offset + PAGE) : null }
}

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

// ---- 详情：用目录里那一项拼 ----

const DEMO_SHA = 'a'.repeat(64)
const NOW = Date.parse('2026-10-16T08:00:00Z')
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * 86_400_000).toISOString()

/** 往前数两个历史版本（到 0.0.0 为止） */
function earlierVersions(version: string): string[] {
  let [a, b, c] = version.split('.').map(n => Number.parseInt(n, 10) || 0)
  const out: string[] = []
  for (let n = 0; n < 2; n++) {
    if (c > 0) c--
    else if (b > 0) {
      b--
      c = 0
    } else if (a > 0) {
      a--
      b = 9
      c = 0
    } else break
    out.push(`${a}.${b}.${c}`)
  }
  return out
}

const storeVersion = (id: string, version: string, daysAgo: number): ExtStoreVersion => ({
  version,
  publishedAt: iso(daysAgo),
  size: 18_000 + version.length * 1_300,
  sha256: DEMO_SHA,
  signature: 'demo-signature',
  keyId: 'demo-key',
  downloadUrl: `/demo/${id}-${version}.zip`,
})

/** 每种贡献在演示清单里放几条（和详情的 contents 数量对得上） */
const CONTRIBUTION_COUNT: Record<ExtPackContributionKind, number> = {
  grammars: 1,
  themes: 2,
  snippets: 2,
  iconThemes: 1,
  taskTemplates: 1,
  skills: 1,
  prompts: 2,
}

const nth = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1)

function demoContributes(kinds: string[]): ExtPackContributes {
  const out: ExtPackContributes = {}
  for (const kind of kinds as ExtPackContributionKind[]) {
    const n = CONTRIBUTION_COUNT[kind]
    if (!n) continue
    if (kind === 'grammars')
      out.grammars = [
        {
          language: 'Demo',
          scopeName: 'source.demo',
          path: 'grammars/demo.tmLanguage.json',
          samples: ['samples/demo.txt'],
        },
      ]
    else if (kind === 'themes')
      out.themes = nth(n).map(i => ({
        id: `demo-${i}`,
        label: { zh: `演示主题 ${i}`, en: `Demo theme ${i}` },
        uiTheme: i % 2 ? ('dark' as const) : ('light' as const),
        path: `themes/demo-${i}.json`,
      }))
    else if (kind === 'snippets')
      out.snippets = nth(n).map(i => ({ language: i === 1 ? 'typescript' : 'json', path: `snippets/${i}.json` }))
    else if (kind === 'iconThemes')
      out.iconThemes = [{ id: 'demo-icons', label: { zh: '演示图标', en: 'Demo icons' }, path: 'icons/theme.json' }]
    else if (kind === 'taskTemplates')
      out.taskTemplates = [
        { id: 'demo-run', label: { zh: '演示任务', en: 'Demo task' }, files: ['demo.toml'], command: 'demo run' },
      ]
    else if (kind === 'skills') out.skills = [{ path: 'skills/demo/SKILL.md' }]
    else
      out.prompts = nth(n).map(i => ({
        id: `demo-${i}`,
        title: { zh: `演示提示词 ${i}`, en: `Demo prompt ${i}` },
        path: `prompts/demo-${i}.md`,
      }))
  }
  return out
}

function demoDetail(id: string): ExtStoreDetail | null {
  const extension = ITEMS.find(i => i.id === id)
  if (!extension) return null
  const slug = id.split('.').slice(1).join('.')
  const history = earlierVersions(extension.version)
  const versions = [extension.version, ...history].map((v, n) => storeVersion(id, v, n * 21))
  const manifest: ExtPackManifest = {
    id,
    name: extension.name,
    version: extension.version,
    publisher: extension.publisher.name,
    description: extension.description,
    keywords: [extension.publisher.name, slug],
    license: 'MIT',
    repository: `https://github.com/${extension.publisher.name}/${slug}`,
    homepage: null,
    engines: { pixelsky: '>=0.4.0' },
    contributes: demoContributes(extension.kinds),
    main: null,
    permissions: [],
    price: null,
  }
  const readme = [
    `## ${extension.name}`,
    '',
    extension.description,
    '',
    '### 包含什么',
    '',
    ...extension.kinds.map(k => `- ${k}：${CONTRIBUTION_COUNT[k as ExtPackContributionKind] ?? 1} 项`),
    '',
    '### 更新记录',
    '',
    `- ${extension.version}：修复若干问题，补充示例。`,
    ...history.map(v => `- ${v}：小改动。`),
    '',
  ].join('\n')
  return {
    extension,
    latest: versions[0],
    manifest,
    readme,
    contents: extension.kinds.map(kind => ({ kind, count: CONTRIBUTION_COUNT[kind as ExtPackContributionKind] ?? 1 })),
    license: 'MIT',
    repository: manifest.repository ?? null,
    homepage: null,
    versions,
    local: INSTALLED.includes(id) ? { key: id, version: extension.version, source: 'store', enabled: true } : null,
  }
}

// ---- 我的发布：发布者 lin；状态存在模块变量上，重启演示才恢复 ----

const myVersion = (
  version: string,
  status: ExtStoreMyVersion['status'],
  over: Partial<ExtStoreMyVersion> = {},
): ExtStoreMyVersion => ({
  version,
  status,
  sha256: DEMO_SHA,
  size: 21_000,
  hints: 0,
  rulesVersion: 2,
  toolVersion: '1.0.0',
  blocked: false,
  blockReason: '',
  submittedAt: iso(10),
  reviewedAt: status === 'pending' ? null : iso(9),
  rejectReason: null,
  ...over,
})

const myExtension = (
  id: string,
  name: string,
  kinds: string[],
  latestVersion: string | null,
  downloads: number,
  versions: ExtStoreMyVersion[],
): ExtStoreMyExtension => ({
  id,
  name,
  description: '',
  kinds,
  latestVersion,
  downloads,
  installs: Math.round(downloads * 0.6),
  delisted: false,
  delistedBy: '',
  delistReason: '',
  blocked: false,
  blockReason: '',
  createdAt: iso(60),
  updatedAt: iso(2),
  versions,
})

const issue = (
  severity: ExtPackIssue['severity'],
  code: string,
  zh: string,
  en: string,
  over: Partial<ExtPackIssue> = {},
): ExtPackIssue => ({ severity, scope: 'file', code, message: { zh, en }, ...over })

const REJECT_ISSUE = issue('error', 'svg.unsafe', '图标里有脚本，会被拒绝', 'The icon contains a script', {
  upload: 'reject',
  path: 'icons/logo.svg',
})
const HINT_ISSUES = [
  issue('warning', 'prompt.noDescription', '提示词没写 description，用户看不到说明', 'Prompt has no description', {
    upload: 'hint',
    path: 'prompts/commit-1.md',
  }),
  issue('warning', 'manifest.noKeywords', '清单里没有 keywords，搜索时不容易被找到', 'No keywords in the manifest', {
    upload: 'hint',
  }),
]
const NOTE_ISSUE = issue('warning', 'file.unused', '有一个文件清单没引用，只在本地提示', 'An unused file', {
  path: 'docs/notes.txt',
})

const sampleReport = (...issues: ExtPackIssue[]): ExtStoreCheckReport => ({
  incomplete: false,
  issues,
  blocking: issues.filter(i => i.upload === 'reject').length,
  hints: issues.filter(i => i.upload === 'hint').length,
  rulesVersion: 2,
  toolVersion: '1.0.0',
})

const myExtensions: ExtStoreMyExtension[] = [
  myExtension('lin.commit-prompts', '提交信息提示词', ['prompts'], '1.2.0', 377, [
    myVersion('1.0.0', 'approved', { submittedAt: iso(50), reviewedAt: iso(49) }),
    myVersion('1.1.0', 'withdrawn', { submittedAt: iso(30), reviewedAt: null }),
    myVersion('1.2.0', 'approved', { hints: 2, submittedAt: iso(12), reviewedAt: iso(11) }),
    myVersion('1.3.0', 'pending', { hints: 1, submittedAt: iso(0.1) }),
  ]),
  myExtension('lin.git-hooks-skills', 'Git 钩子技能', ['skills'], '0.2.0', 85, [
    myVersion('0.2.0', 'approved', { submittedAt: iso(20), reviewedAt: iso(19) }),
    myVersion('0.3.0', 'rejected', {
      submittedAt: iso(3),
      reviewedAt: iso(2),
      rejectReason: 'SKILL.md 缺少 description，审核没有通过；补上说明后可以再提交。',
    }),
  ]),
  myExtension('lin.night-owl', 'Night Owl 夜猫子', ['themes'], '2.0.0', 1210, [
    myVersion('1.0.0', 'blocked', {
      blocked: true,
      blockReason: '主题里的前景色对比度太低，影响阅读，已被平台停用',
      submittedAt: iso(90),
      reviewedAt: iso(89),
    }),
    myVersion('2.0.0', 'approved', { hints: 1, submittedAt: iso(40), reviewedAt: iso(39) }),
  ]),
]

/** 存着逐条结果的版本（其余回 null，界面显示「这台电脑上没有逐条结果」） */
const savedChecks = new Map<string, ExtStoreCheckReport>([
  ['lin.commit-prompts@1.2.0', sampleReport(...HINT_ISSUES, NOTE_ISSUE)],
  ['lin.commit-prompts@1.3.0', sampleReport(HINT_ISSUES[0])],
  ['lin.git-hooks-skills@0.3.0', sampleReport(REJECT_ISSUE, HINT_ISSUES[1])],
])

const findExtension = (id: string): ExtStoreMyExtension => {
  const ext = myExtensions.find(e => e.id === id)
  if (!ext) throw new Error('演示模式下没有这个扩展')
  return ext
}

const PICKED_ID = 'lin.commit-prompts'
const pickedPrompts = (n: number): NonNullable<ExtPackContributes['prompts']> =>
  nth(n).map(i => ({
    id: `commit-${i}`,
    title: { zh: `提示词 ${i}`, en: `Prompt ${i}` },
    path: `prompts/commit-${i}.md`,
  }))

/** 样例包的版本号：比这个扩展已有的都大（补丁号加一） */
function nextVersion(ext: ExtStoreMyExtension): string {
  let top = [0, 0, 0]
  for (const v of ext.versions) {
    const p = v.version.split('.').map(n => Number.parseInt(n, 10) || 0)
    if (p[0] > top[0] || (p[0] === top[0] && (p[1] > top[1] || (p[1] === top[1] && p[2] > top[2])))) top = p
  }
  return `${top[0]}.${top[1]}.${top[2] + 1}`
}

let pickCount = 0
let lastPick: ExtStorePickUploadResult | null = null

/** 演示的样例包：第一次选带「会被拒绝」的问题（提交灰着），再选一次是改好的（可以提交），如此轮流 */
function samplePick(): ExtStorePickUploadResult {
  const fixed = ++pickCount % 2 === 0
  lastPick = {
    token: 'demo-token',
    id: PICKED_ID,
    version: nextVersion(findExtension(PICKED_ID)),
    report: fixed ? sampleReport(...HINT_ISSUES, NOTE_ISSUE) : sampleReport(REJECT_ISSUE, ...HINT_ISSUES, NOTE_ISSUE),
    contributes: { prompts: pickedPrompts(3), skills: [{ path: 'skills/commit/SKILL.md' }] },
    previousContributes: { prompts: pickedPrompts(2) },
    checks: { permissions: [], prefixOk: true, versionNewer: true },
  }
  return lastPick
}

const unsupported = (): never => {
  throw new Error('演示模式下没有这个功能')
}

const bridge: ExtStoreBridge = {
  catalog: async query => {
    await wait(120)
    return catalog(query.q, query.category, query.sort, query.before)
  },
  detail: async id => {
    await wait(80)
    return demoDetail(id)
  },
  install: async () => unsupported(),
  cancel: async () => {},
  checkUpdates: async () => UPDATES,
  state: async () => ({ site: 'https://demo.pixelsky.test', updates: UPDATES, blocklistAt: null, installing: {} }),
  refreshBlocklist: async () => ({ blocklistAt: null }),
  report: async () => {
    await wait(300)
  },
  publisher: async (): Promise<ExtStorePublisherState> => ({
    publisher: { name: 'lin', official: false, createdAt: iso(60) },
    extensions: structuredClone(myExtensions),
  }),
  register: async name => ({ name, official: false, createdAt: new Date(NOW).toISOString() }),
  pickUpload: async () => {
    await wait(250)
    return samplePick()
  },
  upload: async () => {
    await wait(900)
    const picked = lastPick ?? samplePick()
    lastPick = null
    const ext = findExtension(picked.id)
    ext.versions = [
      ...ext.versions.filter(v => v.version !== picked.version),
      myVersion(picked.version, 'pending', {
        hints: picked.report.hints ?? 0,
        submittedAt: new Date(NOW).toISOString(),
      }),
    ]
    savedChecks.set(`${picked.id}@${picked.version}`, picked.report)
    return { version: picked.version, check: picked.report }
  },
  withdraw: async (id, version) => {
    await wait(300)
    const v = findExtension(id).versions.find(x => x.version === version)
    if (v?.status === 'pending') v.status = 'withdrawn'
  },
  delist: async id => {
    await wait(300)
    Object.assign(findExtension(id), { delisted: true, delistedBy: 'owner', delistReason: '' })
  },
  relist: async id => {
    await wait(300)
    Object.assign(findExtension(id), { delisted: false, delistedBy: '', delistReason: '' })
  },
  publishCheck: async (id, version) => savedChecks.get(`${id}@${version}`) ?? null,
  onChange: () => () => {},
}

export const demoExtStore: DemoSource['extStore'] = { bridge, installed: INSTALLED }
