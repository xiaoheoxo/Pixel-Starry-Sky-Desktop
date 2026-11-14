// 从本机其他软件导入 MCP 和技能（docs/ui/extension-remaining-plan.md §H，示意图 docs/ui/import-from-apps-mockup.html）。
// 只读别人的配置文件，不改不删；导入的是副本。扫描结果给界面时密钥只有名字，真正导入时主进程按条目重新读原文件取值。
// 各软件的位置以它们的文档为准（2026-11 核对）；不存在的文件不算错误，读坏了只让那一个软件显示「读不了」。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { mcpConfig, object } from '@pixelsky/engine'
import { parseJsonc } from '@pixelsky/protocol'
import {
  IMPORT_APP_NAMES,
  type ImportApp,
  type ImportAppScan,
  type ImportItem,
  type McpConfig,
} from '@pixelsky/protocol'
import { projectKeys } from './native'

/** 主进程里的完整一项（含原值） */
export interface ImportFull extends ImportItem {
  config?: McpConfig
  dir?: string
  enabled: boolean
}

interface Where {
  home: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  project: string | null
}

/** 系统的应用配置目录：Windows %APPDATA%、macOS ~/Library/Application Support、Linux ~/.config */
function appData({ home, env, platform }: Where): string {
  if (platform === 'win32') return env.APPDATA ?? join(home, 'AppData', 'Roaming')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support')
  return env.XDG_CONFIG_HOME ?? join(home, '.config')
}

const SECRET_KEY = /(token|key|secret|password|auth|credential)/i

/** 给人看的命令行或地址 */
function detailOf(c: McpConfig): string {
  return c.type === 'stdio' ? [c.command ?? '', ...(c.args ?? [])].join(' ') : (c.url ?? '')
}

/** VS Code / Cursor 的 ${env:VAR} 换成我们认的 ${VAR}；${input:…} 留着，标「要自己填」 */
function normalizeVars(c: McpConfig): { config: McpConfig; needsInput: boolean } {
  let needsInput = false
  const fix = (s: string): string => {
    if (/\$\{input:/.test(s)) needsInput = true
    return s.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}')
  }
  const map = (r?: Record<string, string>): Record<string, string> | undefined =>
    r && Object.fromEntries(Object.entries(r).map(([k, v]) => [k, fix(v)]))
  const config: McpConfig = {
    ...c,
    ...(c.command ? { command: fix(c.command) } : {}),
    ...(c.args ? { args: c.args.map(fix) } : {}),
    ...(c.url ? { url: fix(c.url) } : {}),
    ...(c.env ? { env: map(c.env) } : {}),
    ...(c.headers ? { headers: map(c.headers) } : {}),
  }
  return { config, needsInput }
}

/** 环境变量和请求头里看着像密钥、而且写的是值（不是 ${…} 引用）的名字 */
function secretsOf(c: McpConfig): string[] {
  return [...Object.entries(c.env ?? {}), ...Object.entries(c.headers ?? {})]
    .filter(([k, v]) => (SECRET_KEY.test(k) || /^bearer\s/i.test(v)) && !/^\$\{[^}]+\}$/.test(v.trim()))
    .map(([k]) => k)
}

type Servers = Record<string, unknown>

/** Codex config.toml 的 [mcp_servers.x] → 通用写法（command/args/env，或 url + http_headers + bearer_token_env_var） */
function codexServers(text: string): Servers {
  const out: Servers = {}
  for (const [name, raw] of Object.entries(object(object(parseToml(text)).mcp_servers))) {
    const s = object(raw)
    if (typeof s.url === 'string') {
      const headers: Record<string, string> = { ...(object(s.http_headers) as Record<string, string>) }
      if (typeof s.bearer_token_env_var === 'string') headers.Authorization = `Bearer \${${s.bearer_token_env_var}}`
      // env_http_headers：请求头名 → 从哪个环境变量取值
      for (const [header, envName] of Object.entries(object(s.env_http_headers)))
        if (typeof envName === 'string') headers[header] = `\${${envName}}`
      out[name] = { type: 'http', url: s.url, headers, enabled: s.enabled }
    } else out[name] = { command: s.command, args: s.args, env: s.env, enabled: s.enabled }
  }
  return out
}

/**
 * Grok 的 config.toml（docs.x.ai/build/settings，2026-11 核对）：[mcp_servers.x] 是 command / args / env，
 * 或 url + headers（headers 里的 ${VAR} 我们也认）；enabled = false 是停用
 */
function grokServers(text: string): Servers {
  const out: Servers = {}
  for (const [name, raw] of Object.entries(object(object(parseToml(text)).mcp_servers))) {
    const s = object(raw)
    out[name] =
      typeof s.url === 'string'
        ? { type: 'http', url: s.url, headers: object(s.headers), enabled: s.enabled }
        : { command: s.command, args: s.args, env: s.env, enabled: s.enabled }
  }
  return out
}

interface Source {
  file: string
  project: boolean
  read: (text: string, file: string) => Servers
}
const mcpServersKey =
  (key: 'mcpServers' | 'servers') =>
  (text: string): Servers =>
    object(object(parseJsonc(text.replace(/^\uFEFF/, '')))[key])

function sourcesOf(app: ImportApp, w: Where): { mcp: Source[]; skillRoots: Array<{ dir: string; project: boolean }> } {
  const { home, env, project } = w
  const p = (rel: string): string | null => (project ? join(project, rel) : null)
  const list = (items: Array<[string | null, boolean, Source['read']]>): Source[] =>
    items
      .filter((i): i is [string, boolean, Source['read']] => !!i[0])
      .map(([file, isProject, read]) => ({ file, project: isProject, read }))
  switch (app) {
    case 'claude-code': {
      const dir = env.CLAUDE_CONFIG_DIR ?? join(home, '.claude')
      const json = env.CLAUDE_CONFIG_DIR ? join(dir, '.claude.json') : join(home, '.claude.json')
      return {
        mcp: list([
          [json, false, mcpServersKey('mcpServers')],
          // ~/.claude.json 里 projects 下这个项目的（local 范围）
          [
            project ? json : null,
            true,
            text => {
              const projects = object(object(parseJsonc(text.replace(/^\uFEFF/, ''))).projects)
              const keys = projectKeys(Object.keys(projects), project!)
              return keys.length ? object(object(projects[keys[0]]).mcpServers) : {}
            },
          ],
          [p('.mcp.json'), true, mcpServersKey('mcpServers')],
        ]),
        skillRoots: [
          { dir: join(dir, 'skills'), project: false },
          ...(project ? [{ dir: join(project, '.claude', 'skills'), project: true }] : []),
        ],
      }
    }
    case 'claude-desktop':
      return {
        mcp: list([[join(appData(w), 'Claude', 'claude_desktop_config.json'), false, mcpServersKey('mcpServers')]]),
        skillRoots: [],
      }
    case 'cursor':
      return {
        mcp: list([
          [join(home, '.cursor', 'mcp.json'), false, mcpServersKey('mcpServers')],
          [p('.cursor/mcp.json'), true, mcpServersKey('mcpServers')],
        ]),
        skillRoots: [],
      }
    case 'windsurf':
      return {
        mcp: list([[join(home, '.codeium', 'windsurf', 'mcp_config.json'), false, mcpServersKey('mcpServers')]]),
        skillRoots: [],
      }
    case 'vscode':
      return {
        mcp: list([
          [join(appData(w), 'Code', 'User', 'mcp.json'), false, mcpServersKey('servers')],
          [p('.vscode/mcp.json'), true, mcpServersKey('servers')],
        ]),
        skillRoots: [],
      }
    case 'antigravity': {
      // antigravity.google/docs/mcp、/docs/skills（2026-11 核对）：mcpServers 里远程的是 serverUrl（也认 url），disabled 停用
      const gemini = join(home, '.gemini')
      return {
        mcp: list([
          [join(gemini, 'config', 'mcp_config.json'), false, mcpServersKey('mcpServers')],
          [p('.agents/mcp_config.json'), true, mcpServersKey('mcpServers')],
        ]),
        skillRoots: [
          { dir: join(gemini, 'config', 'skills'), project: false },
          { dir: join(gemini, 'antigravity-cli', 'skills'), project: false },
          { dir: join(gemini, 'skills'), project: false },
          ...(project ? [{ dir: join(project, '.agents', 'skills'), project: true }] : []),
        ],
      }
    }
    case 'grok': {
      // docs.x.ai/build/settings、/build/features/skills-plugins-marketplaces（2026-11 核对）
      const dir = env.GROK_HOME ?? join(home, '.grok')
      return {
        mcp: list([
          [join(dir, 'config.toml'), false, grokServers],
          [p('.grok/config.toml'), true, grokServers],
        ]),
        skillRoots: [
          { dir: join(dir, 'skills'), project: false },
          ...(project ? [{ dir: join(project, '.grok', 'skills'), project: true }] : []),
        ],
      }
    }
    case 'codex': {
      const dir = env.CODEX_HOME ?? join(home, '.codex')
      return {
        mcp: list([[join(dir, 'config.toml'), false, codexServers]]),
        // 技能：旧位置 $CODEX_HOME/skills，新版 Codex 用 ~/.agents/skills
        skillRoots: [
          { dir: join(dir, 'skills'), project: false },
          { dir: join(home, '.agents', 'skills'), project: false },
        ],
      }
    }
  }
}

const MAX_FILE = 2 * 1024 * 1024
const TOO_BIG = '文件超过 2 MB'

/** 扫一个软件：读不了的文件进 errors，不影响别的文件 */
export function scanApp(app: ImportApp, w: Where): { places: string[]; items: ImportFull[]; errors: string[] } {
  const { mcp, skillRoots } = sourcesOf(app, w)
  const items: ImportFull[] = []
  const errors: string[] = []
  const places = [...new Set([...mcp.map(s => s.file), ...skillRoots.map(r => r.dir)])]
  for (const src of mcp) {
    if (!existsSync(src.file)) continue
    try {
      if (statSync(src.file).size > MAX_FILE) throw new Error(TOO_BIG)
      const servers = src.read(readFileSync(src.file, 'utf8'), src.file)
      for (const [name, raw] of Object.entries(servers)) {
        try {
          const r = object(raw)
          // Cursor 的远程写法只有 url（没有 type），Windsurf 用 serverUrl
          const remote = r.command === undefined && (r.url ?? r.serverUrl) !== undefined
          const { config, needsInput } = normalizeVars(
            mcpConfig(remote ? { ...r, type: r.type ?? 'http', url: r.url ?? r.serverUrl } : raw),
          )
          const seen = `mcp:${name}:${detailOf(config)}`
          // 项目就是主目录时，全局和项目读的是同一个文件：同一项只列一次
          if (items.some(i => `mcp:${i.name}:${i.detail}` === seen)) continue
          items.push({
            key: `mcp:${src.file}:${src.project ? 'p' : 'g'}:${name}`,
            kind: 'mcp',
            name,
            detail: detailOf(config),
            secrets: secretsOf(config),
            project: src.project,
            needsInput,
            config,
            enabled: object(raw).enabled !== false && object(raw).disabled !== true,
          })
        } catch (e) {
          errors.push(`${name}：${(e as Error).message}`)
        }
      }
    } catch (e) {
      // 解析器的报错会引用出错那几行的原文（可能有密钥），只说读不了
      errors.push(`${src.file}：${(e as Error).message === TOO_BIG ? TOO_BIG : '格式不对，读不了'}`)
    }
  }
  for (const root of skillRoots) {
    let names: string[]
    try {
      names = readdirSync(root.dir, { withFileTypes: true })
        .filter(d => d.isDirectory() || d.isSymbolicLink())
        .map(d => d.name)
    } catch {
      continue
    }
    for (const name of names) {
      const dir = join(root.dir, name)
      if (!existsSync(join(dir, 'SKILL.md')) || items.some(i => i.key === `skill:${resolve(dir)}`)) continue
      items.push({
        key: `skill:${resolve(dir)}`,
        kind: 'skill',
        name,
        detail: dir,
        secrets: [],
        project: root.project,
        needsInput: false,
        dir,
        enabled: true,
      })
    }
  }
  return { places, items, errors }
}

export function defaultWhere(env: NodeJS.ProcessEnv, project: string | null): Where {
  return { home: homedir(), env, platform: process.platform, project }
}

/** 给界面的：去掉原值 */
export function publicScan(
  app: ImportApp,
  scan: ReturnType<typeof scanApp>,
  exists: (i: ImportItem) => boolean,
): ImportAppScan {
  return {
    app,
    name: IMPORT_APP_NAMES[app],
    places: scan.places,
    errors: scan.errors,
    items: scan.items.map(({ config: _c, dir: _d, enabled: _e, ...item }) => ({ ...item, exists: exists(item) })),
  }
}
