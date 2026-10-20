// Claude Code 多账号的目录（docs/ui/engine-accounts-claude.md §2）：每个添加的账号一个 CLAUDE_CONFIG_DIR，
// 登录凭据（.credentials.json / macOS 钥匙串，条目名带目录哈希）和 .claude.json 是它自己的。
//
// 两条规则，满足了就不会和 Claude Code 同时写同一个文件（§2.3）：
// 1. 从不写原目录（~/.claude/、~/.claude.json，或用户设的 CLAUDE_CONFIG_DIR）里的任何文件，只读。
// 2. 账号目录里会被 Claude Code 写的文件，只在这个账号一个 Claude Code 进程都没有时才写：
//    所有起 Claude Code 的地方都经过下面的登记处（holdConfigDir），计数为 0 才同步。
// 对话记录、检查点、技能、插件等文件夹用目录联接接回原目录，里面的文件由 Claude Code 自己写，和多开终端一样。
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { linkDir } from '../accounts-home'
import { logger } from '../log'

const log = logger('engine.claude.accounts')

/** 接回原目录的文件夹 */
export const CLAUDE_SHARED_DIRS = [
  'projects',
  'file-history',
  'sessions',
  'plans',
  'todos',
  'tasks',
  'paste-cache',
  'shell-snapshots',
  'session-env',
  'skills',
  'agents',
  'commands',
  'output-styles',
  'plugins',
] as const

/** 空闲时从原目录三方合并过来的文件（Claude Code 写它们是「写临时文件再改名」，硬链接会断） */
export const CLAUDE_SYNCED_FILES = ['settings.json', 'CLAUDE.md'] as const

/** .claude.json 里每个项目要共用的设置（MCP 服务器本身不在这里：每次启动从原文件读，经 --mcp-config 传） */
export const SHARED_PROJECT_KEYS = [
  'allowedTools',
  'enabledMcpServers',
  'disabledMcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'hasTrustDialogAccepted',
  'hasClaudeMdExternalIncludesApproved',
  'hasClaudeMdExternalIncludesWarningShown',
] as const

/** 账号自己的（各种缓存、登录信息、统计），新建账号时不从原文件带过来 */
const ACCOUNT_KEYS = new Set([
  'oauthAccount',
  'primaryApiKey',
  'customApiKeyResponses',
  'userID',
  'mcpServers',
  'numStartups',
  'firstStartTime',
  'claudeAiMcpEverConnected',
  'subscriptionNoticeCount',
  'hasAvailableSubscription',
  'additionalModelOptionsAnsweredAt',
])
const isAccountKey = (key: string): boolean => ACCOUNT_KEYS.has(key) || /cache/i.test(key)

/** 像素星空自己在账号目录里的文件（Claude Code 不碰）：上次同步时原目录的样子 */
const BASE_DIR = '.pixelsky-base'
/** 会话用的合并 MCP 配置文件的前缀（进程换掉 / 会话关闭时删，意外退出留下的空闲同步时清掉） */
const MCP_FILE_PREFIX = '.pixelsky-mcp-'

/** 原目录：用户自己设了 CLAUDE_CONFIG_DIR 的照用户的 */
export function claudeRealDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** 原来的全局配置：设了 CLAUDE_CONFIG_DIR 在那个目录里，没设在主目录 */
export function claudeGlobalConfig(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json')
}

/**
 * 账号目录要用的环境：配置目录换成账号目录；凭据位置跟着配置目录走（用户设的 CLAUDE_SECURESTORAGE_CONFIG_DIR 会让
 * 所有账号共用一份凭据，去掉）
 */
export function claudeAccountEnv(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, CLAUDE_CONFIG_DIR: dir }
  for (const key of Object.keys(out)) if (key.toUpperCase() === 'CLAUDE_SECURESTORAGE_CONFIG_DIR') delete out[key]
  return out
}

// ---------------------------------------------------------------------------
// 登记处：每个配置目录现在有几个 Claude Code 进程

const holds = new Map<string, number>()
const dirKey = (dir: string): string => {
  const p = resolve(dir)
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/** 起一个用这个配置目录的进程前调，进程结束后调返回的函数（多调无害） */
export function holdConfigDir(dir: string | undefined): () => void {
  if (!dir) return () => undefined
  const key = dirKey(dir)
  holds.set(key, (holds.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const n = (holds.get(key) ?? 1) - 1
    if (n > 0) holds.set(key, n)
    else holds.delete(key)
  }
}

export function configDirBusy(dir: string): boolean {
  return (holds.get(dirKey(dir)) ?? 0) > 0
}

/** 测试用 */
export function resetConfigDirHolds(): void {
  holds.clear()
}

// ---------------------------------------------------------------------------
// 三方合并

type Json = unknown
const isObj = (v: Json): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 键排好序的 JSON，比较用 */
function canon(v: Json): string {
  if (v === undefined) return 'undefined'
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (isObj(v))
    return `{${Object.keys(v)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}
const same = (a: Json, b: Json): boolean => canon(a) === canon(b)

/**
 * base 是上次同步时原目录的样子，ours 是账号这份，theirs 是原目录现在的。
 * 原目录改过的带过来；账号自己改过、原目录没动的保留；两边都改了同一项用原目录的；数组按并集（原目录删掉的项照删）
 */
export function merge3(base: Json, ours: Json, theirs: Json): Json {
  if (same(theirs, base)) return ours
  if (same(ours, base)) return theirs
  if (isObj(ours) && isObj(theirs)) {
    const b = isObj(base) ? base : {}
    const out: Record<string, Json> = {}
    for (const key of new Set([...Object.keys(theirs), ...Object.keys(ours)])) {
      const v = merge3(b[key], ours[key], theirs[key])
      if (v !== undefined) out[key] = v
    }
    return out
  }
  if (Array.isArray(ours) && Array.isArray(theirs)) {
    const b = Array.isArray(base) ? base : []
    const added = ours.filter(x => !b.some(y => same(x, y)) && !theirs.some(y => same(x, y)))
    return [...theirs, ...added]
  }
  return theirs
}

// ---------------------------------------------------------------------------
// 文件读写（只写账号目录）

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 读 JSON；没有这个文件为 undefined，读坏了为 null */
function readJson(path: string): Json | null | undefined {
  const text = readText(path)
  if (text === null) return undefined
  try {
    return JSON.parse(text) as Json
  } catch {
    return null
  }
}

/** 写临时文件再改名；内容一样就不写 */
function writeAtomic(path: string, text: string): void {
  if (readText(path) === text) return
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  try {
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

const jsonText = (v: Json): string => `${JSON.stringify(v, null, 2)}\n`

/** settings.json：原目录读坏了这次不同步；账号这份读坏了按原目录的换掉 */
function syncSettings(real: string, dir: string): void {
  const theirs = readJson(join(real, 'settings.json'))
  if (theirs === null) return
  const basePath = join(dir, BASE_DIR, 'settings.json')
  const ours = readJson(join(dir, 'settings.json'))
  const base = readJson(basePath)
  // 没有底稿（第一次）：当作账号这份就是底稿，原目录的为准
  const merged =
    ours === undefined || ours === null
      ? theirs
      : merge3(base === undefined || base === null ? ours : base, ours, theirs)
  if (merged === undefined) rmSync(join(dir, 'settings.json'), { force: true })
  else writeAtomic(join(dir, 'settings.json'), jsonText(merged))
  if (theirs === undefined) rmSync(basePath, { force: true })
  else writeAtomic(basePath, jsonText(theirs))
}

/** CLAUDE.md：整个文件比较 */
function syncText(real: string, dir: string, name: string): void {
  const theirs = readText(join(real, name))
  const basePath = join(dir, BASE_DIR, name)
  const ours = readText(join(dir, name))
  const base = existsSync(basePath) ? readText(basePath) : ours
  const merged = theirs === base ? ours : theirs
  if (merged === null) rmSync(join(dir, name), { force: true })
  else writeAtomic(join(dir, name), merged)
  if (theirs === null) rmSync(basePath, { force: true })
  else writeAtomic(basePath, theirs)
}

/** .claude.json 里要共用的那部分：每个项目的 SHARED_PROJECT_KEYS */
function sharedView(json: Json): Record<string, Record<string, Json>> {
  const out: Record<string, Record<string, Json>> = {}
  const projects = isObj(json) && isObj(json.projects) ? json.projects : {}
  for (const [path, p] of Object.entries(projects)) {
    if (!isObj(p)) continue
    const picked: Record<string, Json> = {}
    for (const key of SHARED_PROJECT_KEYS) if (p[key] !== undefined) picked[key] = p[key]
    if (Object.keys(picked).length) out[path] = picked
  }
  return out
}

/** 新建账号时的 .claude.json：原文件去掉账号自己的项和 MCP 服务器，项目只留共用的设置 */
export function seedGlobalConfig(original: Json): Record<string, Json> {
  const out: Record<string, Json> = {}
  if (isObj(original))
    for (const [key, v] of Object.entries(original)) if (key !== 'projects' && !isAccountKey(key)) out[key] = v
  out.projects = sharedView(original)
  return out
}

/** 账号 .claude.json 的共用部分换成 merged（项目里别的项不动），并去掉 MCP 服务器（每次启动经 --mcp-config 传） */
export function applySharedView(account: Record<string, Json>, merged: Json): Record<string, Json> {
  const view = isObj(merged) ? merged : {}
  const projects: Record<string, Json> = {}
  const old = isObj(account.projects) ? account.projects : {}
  for (const path of new Set([...Object.keys(old), ...Object.keys(view)])) {
    const kept: Record<string, Json> = {}
    const p = old[path]
    if (isObj(p))
      for (const [key, v] of Object.entries(p))
        if (key !== 'mcpServers' && !(SHARED_PROJECT_KEYS as readonly string[]).includes(key)) kept[key] = v
    const shared = view[path]
    const next = isObj(shared) ? { ...kept, ...shared } : kept
    if (Object.keys(next).length) projects[path] = next
  }
  const { mcpServers: _drop, ...rest } = account
  return { ...rest, projects }
}

function syncGlobalConfig(globalConfig: string, dir: string): void {
  const original = readJson(globalConfig)
  if (original === null) return
  const accountPath = join(dir, '.claude.json')
  const basePath = join(dir, BASE_DIR, 'claude.json')
  const theirs = sharedView(original)
  const account = readJson(accountPath)
  if (!isObj(account)) {
    // 新建账号（或账号这份读坏了）：从原文件带一份，登录后 Claude Code 自己写进登录信息
    writeAtomic(accountPath, jsonText(seedGlobalConfig(original)))
  } else {
    const ours = sharedView(account)
    const base = readJson(basePath)
    const merged = merge3(isObj(base) ? base : ours, ours, theirs)
    writeAtomic(accountPath, jsonText(applySharedView(account, merged)))
  }
  writeAtomic(basePath, jsonText(theirs))
}

/** 意外退出留下的合并 MCP 配置文件 */
function cleanMcpFiles(dir: string): void {
  for (const name of readdirSync(dir)) if (name.startsWith(MCP_FILE_PREFIX)) rmSync(join(dir, name), { force: true })
}

/**
 * 准备账号目录：建目录、接上共享的文件夹、空闲时同步设置。每次以这个账号启动 Claude Code 前都调。
 * 账号有进程在跑时什么都不写（返回 false），等下次。出错只记日志：Claude Code 照样能起，只是那一项这次没同步
 */
export function prepareClaudeAccount(env: NodeJS.ProcessEnv, dir: string): boolean {
  if (configDirBusy(dir)) return false
  const real = claudeRealDir(env)
  mkdirSync(dir, { recursive: true })
  const step = (what: string, fn: () => void): void => {
    try {
      fn()
    } catch (error) {
      log.warn('prepare claude account failed', { what, error: (error as Error).message })
    }
  }
  for (const name of CLAUDE_SHARED_DIRS)
    step(name, () => {
      // 账号目录里已经有真文件夹：不挪进原目录，这一项不共享
      if (!linkDir(real, dir, name, false)) log.warn('account dir has its own folder, not shared', { name })
    })
  step('settings.json', () => syncSettings(real, dir))
  step('CLAUDE.md', () => syncText(real, dir, 'CLAUDE.md'))
  step('.claude.json', () => syncGlobalConfig(claudeGlobalConfig(env), dir))
  step('mcp files', () => cleanMcpFiles(dir))
  return true
}

// ---------------------------------------------------------------------------
// MCP：添加的账号的会话，原文件里的用户级 / 本地级 MCP 服务器每次启动现读

const pathKey = (p: string): string => {
  const s = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/** 原文件里这个目录能用的 MCP 服务器：用户级，再叠本地级（同名本地级为准） */
export function nativeMcpServers(env: NodeJS.ProcessEnv, cwd: string): Record<string, Json> {
  const original = readJson(claudeGlobalConfig(env))
  if (!isObj(original)) return {}
  const out: Record<string, Json> = isObj(original.mcpServers) ? { ...original.mcpServers } : {}
  const projects = isObj(original.projects) ? original.projects : {}
  const want = pathKey(cwd)
  for (const [path, p] of Object.entries(projects))
    if (pathKey(path) === want && isObj(p) && isObj(p.mcpServers)) Object.assign(out, p.mcpServers)
  return out
}

/**
 * 写会话用的 MCP 配置：原文件里的服务器 + 扩展的（同名扩展为准），放在账号目录里（不进原目录），返回路径；
 * 两边都没有返回 null
 */
export function writeAccountMcpFile(dir: string, native: Record<string, Json>, extensionsFile?: string): string | null {
  let extension: Record<string, Json> = {}
  if (extensionsFile) {
    const parsed = readJson(extensionsFile)
    if (isObj(parsed) && isObj(parsed.mcpServers)) extension = parsed.mcpServers
  }
  const servers = { ...native, ...extension }
  if (!Object.keys(servers).length) return null
  const path = join(dir, `${MCP_FILE_PREFIX}${randomUUID()}.json`)
  writeFileSync(path, JSON.stringify({ mcpServers: servers }), { mode: 0o600 })
  return path
}

// ---------------------------------------------------------------------------
// 「始终允许（所有项目）」在添加的账号下：像素星空自己记，所有账号的会话启动时经 --settings 带上（§2.3）

export class ClaudeUserRules {
  constructor(private readonly file: string) {}

  list(): string[] {
    const raw = readJson(this.file)
    const allow = isObj(raw) && Array.isArray(raw.allow) ? raw.allow : []
    return allow.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 2000)
  }

  add(rules: readonly string[]): void {
    const now = this.list()
    const next = [...now, ...rules.filter(r => r && !now.includes(r))]
    if (next.length === now.length) return
    try {
      writeAtomic(this.file, jsonText({ version: 1, allow: next }))
    } catch (error) {
      log.warn('save user rules failed', { error: (error as Error).message })
    }
  }
}

/** updatedPermissions 里「添加允许规则」的项 → 设置文件里的写法（Bash(npm test:*)、Read 等） */
export function allowRuleStrings(permissions: readonly unknown[]): string[] {
  const out: string[] = []
  for (const p of permissions) {
    if (!isObj(p) || p.type !== 'addRules' || p.behavior !== 'allow' || !Array.isArray(p.rules)) continue
    for (const r of p.rules) {
      if (!isObj(r) || typeof r.toolName !== 'string' || !r.toolName) continue
      out.push(typeof r.ruleContent === 'string' && r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)
    }
  }
  return out
}
