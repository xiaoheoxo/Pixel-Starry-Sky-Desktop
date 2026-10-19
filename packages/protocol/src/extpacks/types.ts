// 扩展包（extension pack）的共享类型和常量：主进程、预加载、渲染进程都用这一份。
// 纯 TS，不依赖 node 类型。

export type ExtText = string | { zh: string; en?: string }
export type ExtLocale = 'zh-CN' | 'en-US'

export interface ExtGrammar {
  language?: string
  aliases?: string[]
  extensions?: string[]
  filenames?: string[]
  filenamePatterns?: string[]
  firstLine?: string | null
  scopeName: string
  path: string
  configuration?: string
  embeddedLanguages?: Record<string, string>
  injectTo?: string[]
  samples: string[]
}
export interface ExtTheme {
  id: string
  label: ExtText
  uiTheme: 'dark' | 'light'
  path: string
}
export interface ExtSnippets {
  language: string
  path: string
}
export interface ExtIconTheme {
  id: string
  label: ExtText
  path: string
  partial?: boolean
}
export interface ExtTaskDef {
  name: string
  description?: ExtText
  when?: string
}
export interface ExtTaskExtract {
  pattern: string
  flags?: string
  name: number
  description?: number | { commentBefore: string }
}
export interface ExtTaskRunner {
  windows?: string
  default: string
  fallback?: string
  when?: string
}
export interface ExtTaskTemplate {
  id: string
  label: ExtText
  icon?: string
  files: string[]
  tasks?: ExtTaskDef[]
  extract?: ExtTaskExtract[]
  runner?: ExtTaskRunner
  command: string
  cwd?: string
}
export interface ExtSkill {
  path: string
  engines?: Array<'claude' | 'codex'>
}
export interface ExtPrompt {
  id: string
  title: ExtText
  description?: ExtText
  path: string
  where?: Array<'composer' | 'editor'>
  requires?: 'selection'
}
export interface ExtPackContributes {
  grammars?: ExtGrammar[]
  themes?: ExtTheme[]
  snippets?: ExtSnippets[]
  iconThemes?: ExtIconTheme[]
  taskTemplates?: ExtTaskTemplate[]
  skills?: ExtSkill[]
  prompts?: ExtPrompt[]
}
export type ExtPackContributionKind = keyof ExtPackContributes
export interface ExtPackManifest {
  id: string
  name: string
  version: string
  publisher: string
  description: string
  icon?: string
  keywords?: string[]
  license: string
  repository?: string | null
  homepage?: string | null
  engines: { pixelsky: string }
  l10n?: { en?: { name?: string; description?: string } }
  contributes: ExtPackContributes
  main: null
  permissions: unknown[]
  price: null
}
export type ExtPackSource = 'builtin' | 'folder' | 'store'
export interface ExtPackIssue {
  severity: 'error' | 'warning'
  /** pack: 整个扩展不加载；contribution: 该条贡献不生效；file: 该文件不使用 / 不提供 */
  scope: 'pack' | 'contribution' | 'file'
  /** 稳定的代码，例如 'manifest.unknownField' */
  code: string
  message: { zh: string; en: string }
  path?: string
  contribution?: { kind: ExtPackContributionKind; index: number }
  /** 以后上传检查对它的处理（给作者的提示）；undefined = 只在本地提示 */
  upload?: 'reject' | 'hint'
  /** 已知时的位置：file = 扩展内的路径；pointer = 该 JSON 文件内的 RFC 6901 指针；line / column 从 1 起（UTF-16 列） */
  loc?: { file: string; pointer?: string; line?: number; column?: number }
}
export type ExtPackInactive = Partial<Record<ExtPackContributionKind, number[]>>
/** overrideBuiltin 存语法的覆盖键 = `grammar.language ?? grammar.scopeName` */
export interface ExtPackOptions {
  overrideBuiltin?: string[]
}
export interface ExtPackSkillInfo {
  name: string
  description: string
  engines: Array<'claude' | 'codex'>
  index: number
}
export interface ExtPackInfo {
  key: string
  id: string | null
  source: ExtPackSource
  path: string
  enabled: boolean
  addedAt: number
  revision: number
  status: 'ok' | 'warning' | 'error'
  manifest: ExtPackManifest | null
  /** enabled && status !== 'error' && !blocked && !shadowedBy（见 computeLive） */
  live: boolean
  /** 被 scope:'contribution' 错误停用的贡献的清单下标；生效 = live 且下标不在里面 */
  inactive: ExtPackInactive
  issues: ExtPackIssue[]
  options: ExtPackOptions
  skills: ExtPackSkillInfo[]
  /** 来源是 store 时的安装回执（版本、时间、校验值、签名钥匙、装自哪个站点） */
  store?: { version: string; installedAt: number; sha256: string; keyId: string; site: string }
  /** 被平台停用（停用名单命中）：不生效，不能打开；reason 是名单里的原因，at 是读到名单的时间 */
  blocked?: { reason: string; at: string }
  /** 同 id 有更优先的来源在用（开发中的文件夹 > 商店 > 内置）：值是生效那一份的来源；不算错误，灰显 */
  shadowedBy?: ExtPackSource
}
export interface ExtPackState {
  revision: number
  loading: boolean
  packs: ExtPackInfo[]
}
export interface ExtTaskTemplateWire {
  packKey: string
  packId: string
  /** 清单下标 */
  index: number
  template: ExtTaskTemplate
}
export interface ExtPackFileEntry {
  path: string
  size: number
  kind: 'file' | 'symlink'
}
/** 一个扩展的文件来源：文件夹、zip、内存都实现它 */
export interface ExtPackFiles {
  /** 正斜杠相对路径，按 UTF-16 码元排序，不含目录；文件夹 / 内存来源已套用 extPackSkipped */
  entries: ExtPackFileEntry[]
  /** 到扫描上限（文件数 / 字节）就停了 */
  truncated: boolean
  /** 普通文件的字节数；不存在 / 不是普通文件（含符号链接）返回 null。与 entries / 上限无关（读清单用） */
  stat(path: string): number | null
  /** 普通文件的前 maxBytes 字节；不存在 / 不是普通文件 / 路径不安全 / 读失败返回 null */
  read(path: string, maxBytes: number): Uint8Array | null
  /** 来源自己发现的问题（zip 层）；checkPack 放在最前面 */
  preIssues?: ExtPackIssue[]
}
export interface CheckPackOptions {
  source: ExtPackSource
  /** 不传 = 上传级别：不判断 manifest.engineUnmet */
  appVersion?: string
  /** 语法引擎的问题；undefined = 没跑引擎，有语法时报 grammar.regexUnchecked */
  grammar?: ExtPackIssue[]
  /** 是否扫 svg 内容（svg.unsafe）；默认 source !== 'builtin'。商店扩展启动加载时传 false（安装时已扫过） */
  scanSvg?: boolean
}
export interface ExtPackCheck {
  id: string | null
  manifest: ExtPackManifest | null
  /** 只含普通文件：路径 → 字节数 */
  files: Map<string, number>
  /** 已按来源过滤、去重，保持产生顺序 */
  issues: ExtPackIssue[]
  status: ExtPackInfo['status']
  inactive: ExtPackInactive
  skills: ExtPackSkillInfo[]
}
export type ExtCheckLevel = 'upload' | 'dev'
export type ExtIssueOutcome = 'reject' | 'hint' | 'note'
/** readText：文件不存在或太大返回 null；按 UTF-8 严格解码并去掉 BOM（编码问题由校验器通过 readBytes 报告） */
export interface ExtPackReader {
  exists(path: string): boolean
  size(path: string): number | null
  readText(path: string): string | null
  readBytes(path: string, maxBytes: number): Uint8Array | null
  list(prefix: string): string[]
}

export const EXT_MANIFEST = 'pixelsky-extension.json'
export const EXT_ASSET_SCHEME = 'pixelsky-ext'
export const EXT_LIMITS = {
  fileBytes: 2 * 1024 * 1024,
  packBytes: 10 * 1024 * 1024,
  files: 500,
  filesWithIcons: 3000,
  scanFiles: 5000,
  scanBytes: 50 * 1024 * 1024,
  samplesBytes: 200 * 1024,
  iconBytes: 32 * 1024,
  pathChars: 128,
  promptChars: 8000,
  snippetsPerFile: 500,
  snippetPrefixChars: 30,
  tasksPerFile: 200,
  extractBytes: 1024 * 1024,
  manifestBytes: 256 * 1024,
  textBytes: 256 * 1024,
  lineChars: 10_000,
  lineMs: 30,
  /** 语法性能检查：把样例循环补到这么多行再测 */
  stressLines: 5000,
  /** 语法性能检查：单行分词的时间上限 */
  sampleMs: 1000,
  /** 一个样例分词超过这么久还没完成，当作卡死 */
  hangMs: 10_000,
  /** 最慢一行超过 lineMs 的这个比例，给「接近上限」提示 */
  nearRatio: 0.5,
} as const

/** 规则语义变化时加一；写进命令行的 JSON 和共享用例的期望 */
export const EXT_RULES_VERSION = 2

/** 软件内置的 26 个语言 id（authoring-spec §4.5） */
export const EXT_BUILTIN_LANGUAGE_IDS: readonly string[] = [
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
  'json',
  'css',
  'html',
  'markdown',
  'python',
  'rust',
  'go',
  'yaml',
  'toml',
  'shellscript',
  'sql',
  'java',
  'kotlin',
  'scala',
  'groovy',
  'c',
  'cpp',
  'csharp',
  'xml',
  'properties',
  'ini',
  'dockerfile',
]
/** 语法可以写出名字、但这里没有对应 TextMate 语法的内置作用域（不支持 → 警告） */
export const EXT_BUILTIN_SCOPES: readonly string[] = [
  'source.js',
  'source.ts',
  'source.css',
  'text.html.basic',
  'source.json',
  'source.python',
  'source.shell',
  'source.sql',
  'text.html.markdown',
]
/** 内置任务已经认领的文件名（Gradle 自 0.4 起内置，spec §8 由 WP1 更新） */
export const EXT_RESERVED_TASK_FILES: readonly string[] = [
  'package.json',
  'Makefile',
  'makefile',
  'GNUmakefile',
  'Cargo.toml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
]
export const EXT_RESERVED_TASK_IDS: readonly string[] = ['npm', 'make', 'cargo', 'gradle']
