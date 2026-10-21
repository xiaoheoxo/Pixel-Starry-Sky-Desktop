import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse } from 'yaml'
import type { ExtensionComponent, ExtensionEntry, ExtensionInput, ExtensionScope, McpConfig } from '@pixelsky/protocol'

export const MASKED_SECRET = '••••••••'
export const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
export function text(v: unknown, label: string, max = 4096): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || v.includes('\0')) throw new Error(`${label}不正确`)
  return v
}
export function extensionName(v: unknown): string {
  const name = text(v, '名称', 100)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw new Error('名称使用字母、数字、点、下划线或短横线')
  return name
}
export function scope(v: unknown): ExtensionScope {
  const s = object(v)
  if (s.kind === 'global') return { kind: 'global' }
  if (s.kind === 'project') return { kind: 'project', path: realpathSync(text(s.path, '项目路径')) }
  throw new Error('作用范围不正确')
}
export function strings(v: unknown): string[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > 100 || v.some(x => typeof x !== 'string' || x.length > 16000 || x.includes('\0')))
    throw new Error('参数必须为字符串数组')
  return v as string[]
}
export function dictionary(v: unknown): Record<string, string> {
  if (v === undefined) return {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('环境变量或请求头必须为对象')
  const entries = Object.entries(v)
  if (
    entries.length > 100 ||
    entries.some(([k, x]) => !/^[\w.-]+$/.test(k) || typeof x !== 'string' || x.length > 32000 || x.includes('\0'))
  )
    throw new Error('环境变量或请求头不正确')
  return Object.fromEntries(entries) as Record<string, string>
}
export function mcpConfig(v: unknown): McpConfig {
  const c = object(v),
    type = c.type === 'streamable-http' ? 'http' : (c.type ?? 'stdio')
  if (type === 'stdio') return { type, command: text(c.command, '命令'), args: strings(c.args), env: dictionary(c.env) }
  if (type !== 'http' && type !== 'sse') throw new Error('支持 stdio、HTTP 或 SSE')
  const url = text(c.url, '地址'),
    parsed = new URL(url.replace(/\$\{[^}]+\}/g, 'value'))
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error('使用 HTTP(S) 地址，凭据放在请求头中')
  return { type, url, headers: dictionary(c.headers) }
}
export function expandedMcp(config: McpConfig, env: NodeJS.ProcessEnv): McpConfig {
  const expand = (value: string, vars: NodeJS.ProcessEnv): string =>
    value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      (_match, key: string, fallback: string | undefined) => {
        const result = vars[key] ?? fallback
        if (result === undefined) throw new Error(`缺少环境变量 ${key}`)
        return result
      },
    )
  const own = Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, expand(value, env)])),
    vars = { ...env, ...own }
  return {
    ...config,
    command: config.command ? expand(config.command, vars) : undefined,
    args: config.args?.map(arg => expand(arg, vars)),
    env: own,
    url: config.url ? expand(config.url, vars) : undefined,
    headers: Object.fromEntries(Object.entries(config.headers ?? {}).map(([key, value]) => [key, expand(value, vars)])),
  }
}
export function input(v: unknown): ExtensionInput {
  const o = object(v)
  if (!['mcp', 'cli', 'skill'].includes(String(o.kind))) throw new Error('不支持的配置类型')
  const base: ExtensionInput = {
    id: typeof o.id === 'string' ? o.id : undefined,
    kind: o.kind as ExtensionInput['kind'],
    name: extensionName(o.name),
    scope: scope(o.scope),
    description: typeof o.description === 'string' ? o.description.slice(0, 4000) : '',
    // 没传就留空：编辑已有项时沿用已存的开关（列表里的开关可能在表单开着时单独改过）
    ...(o.enabled === undefined ? {} : { enabled: o.enabled !== false }),
  }
  if (o.engines !== undefined) {
    if (
      !Array.isArray(o.engines) ||
      !o.engines.length ||
      o.engines.some(e => e !== 'claude' && e !== 'codex' && e !== 'pixel')
    )
      throw new Error('适用引擎不正确')
    base.engines = [...new Set(o.engines)] as Array<'claude' | 'codex' | 'pixel'>
  }
  if (base.kind === 'mcp') base.mcp = mcpConfig(o.mcp)
  if (base.kind === 'cli') {
    base.command = text(o.command, '程序')
    base.args = strings(o.args)
  }
  if (base.kind === 'skill') {
    base.text = text(o.text, '技能正文', 2 * 1024 * 1024)
    base.expectedVersion = typeof o.expectedVersion === 'string' ? o.expectedVersion : undefined
  }
  return base
}
export function inside(root: string, candidate: string): string {
  const path = resolve(candidate),
    rel = relative(resolve(root), path)
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('路径超出管理目录')
  return path
}
export function jsonFile(path: string): Record<string, unknown> {
  if (statSync(path).size > 2 * 1024 * 1024) throw new Error('配置文件过大')
  return object(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')))
}
export function skillFile(path: string): ExtensionComponent {
  if (statSync(path).size > 2 * 1024 * 1024) throw new Error('技能正文过大')
  const source = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)
  const meta = match ? object(parse(match[1])) : {}
  const name = extensionName(
    meta.name ?? (basename(path).toLowerCase() === 'skill.md' ? basename(resolve(path, '..')) : basename(path, '.md')),
  )
  return {
    kind: 'skill',
    name,
    description: typeof meta.description === 'string' ? meta.description : '',
    path,
    invocable: meta['user-invocable'] !== false,
  }
}
export function files(root: string): string[] {
  const out: string[] = []
  let bytes = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 16) throw new Error('目录层级过深')
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.git', 'node_modules'].includes(item.name)) continue
      const path = join(dir, item.name),
        stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error(`导入目录包含链接，请先使用实际文件：${item.name}`)
      if (stat.isDirectory()) walk(path, depth + 1)
      else if (stat.isFile()) {
        bytes += stat.size
        if (stat.size > 10 * 1024 * 1024 || bytes > 100 * 1024 * 1024 || out.length > 10000)
          throw new Error('导入目录过大')
        out.push(path)
      }
    }
  }
  walk(root, 0)
  return out
}
export function digest(root: string): string {
  const hash = createHash('sha256')
  for (const file of files(root)) {
    hash.update(relative(root, file))
    hash.update(readFileSync(file))
  }
  return hash.digest('hex')
}
export const contentVersion = (source: string): string => createHash('sha256').update(source).digest('hex')
export function pluginDirectory(root: string): {
  name: string
  description: string
  version: string
  components: ExtensionComponent[]
} {
  // 只遍历一次：先跑它是为了保留校验（链接 / 目录过深 / 过大先报错，早于读 plugin.json），结果后面直接复用
  const all = files(root)
  const manifest = jsonFile(join(root, '.claude-plugin/plugin.json'))
  const name = extensionName(manifest.name),
    components: ExtensionComponent[] = []
  const local = (p: string): string => inside(root, join(root, p))
  for (const field of ['skills', 'commands', 'agents', 'hooks', 'mcpServers', 'lspServers']) {
    const value = manifest[field]
    for (const path of typeof value === 'string' ? [value] : Array.isArray(value) ? value : [])
      if (typeof path === 'string') {
        if (isAbsolute(path)) throw new Error('插件组件必须位于包内')
        local(path)
      }
  }
  for (const file of all) {
    const rel = relative(root, file).replaceAll('\\', '/')
    if (/^skills\/.*\/SKILL\.md$/i.test(rel) || /^commands\/.*\.md$/i.test(rel) || file === local('SKILL.md'))
      components.push(skillFile(file))
  }
  // Manifest 指定的非默认 skill / command 目录也纳入组件目录。
  for (const field of ['skills', 'commands']) {
    const value = manifest[field]
    for (const p of typeof value === 'string' ? [value] : Array.isArray(value) ? value : []) {
      if (typeof p !== 'string' || !existsSync(local(p))) continue
      const list = statSync(local(p)).isDirectory() ? files(local(p)) : [local(p)]
      for (const file of list.filter(f =>
        field === 'commands' ? f.endsWith('.md') : basename(f).toLowerCase() === 'skill.md',
      ))
        if (!components.some(c => c.path === file)) components.push(skillFile(file))
    }
  }
  const configs: unknown[] = []
  if (existsSync(local('.mcp.json'))) configs.push(jsonFile(local('.mcp.json')))
  const mcp = manifest.mcpServers
  if (typeof mcp === 'string' && existsSync(local(mcp))) configs.push(jsonFile(local(mcp)))
  else if (Array.isArray(mcp)) {
    for (const file of mcp) if (typeof file === 'string' && existsSync(local(file))) configs.push(jsonFile(local(file)))
  } else if (mcp && typeof mcp === 'object') configs.push(mcp)
  for (const raw of configs) {
    const c = object(raw),
      servers = object(c.mcpServers ?? c)
    for (const [server, value] of Object.entries(servers))
      if (!components.some(x => x.kind === 'mcp' && x.name === server)) {
        components.push({ kind: 'mcp', name: extensionName(server), description: '随插件启用', mcp: mcpConfig(value) })
      }
  }
  if (existsSync(local('bin')))
    components.push({ kind: 'cli', name, description: '插件可执行程序', path: local('bin') })
  return {
    name,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    version: typeof manifest.version === 'string' ? manifest.version : '',
    components,
  }
}
export function effective(entries: ExtensionEntry[], project: string | null): ExtensionEntry[] {
  const result = new Map<string, ExtensionEntry>()
  for (const entry of entries
    .filter(e => e.origin === 'managed')
    .sort((a, b) => Number(a.scope.kind === 'project') - Number(b.scope.kind === 'project'))) {
    if (
      entry.scope.kind === 'project' &&
      (!project || resolve(entry.scope.path).toLowerCase() !== resolve(project).toLowerCase())
    )
      continue
    result.set(entry.kind + ':' + entry.name, entry)
  }
  return [...result.values()].filter(e => e.enabled && !e.error)
}
