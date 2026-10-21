import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { jsonFile, object, pluginDirectory, skillFile, mcpConfig, MASKED_SECRET } from '@pixelsky/engine'
import type { ExtensionEntry, ExtensionScope, McpConfig } from '@pixelsky/protocol'

/**
 * `~/.claude.json` 里 projects 下指向这个项目的键。Windows 上旧版 Claude Code 用 `D:\PixelSky`，
 * 新版用 `D:/PixelSky`，盘符大小写也可能不同：都算同一个项目，正斜杠的（新版写的）排前面，同名 MCP 以它为准
 */
export function projectKeys(keys: string[], project: string): string[] {
  if (!/^[a-zA-Z]:[\\/]/.test(project)) return keys.includes(project) ? [project] : []
  const norm = (path: string): string => path.replace(/\\/g, '/').toLowerCase(),
    target = norm(project)
  return keys.filter(key => norm(key) === target).sort((a, b) => Number(a.includes('\\')) - Number(b.includes('\\')))
}
export function nativeEntries(
  project: string | null,
  env: NodeJS.ProcessEnv,
): { entries: ExtensionEntry[]; warnings: string[] } {
  const home = env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    entries: ExtensionEntry[] = [],
    warnings: string[] = [],
    seen = new Set<string>()
  const scope: ExtensionScope = { kind: 'global' },
    bases: Array<{ root: string; scope: ExtensionScope }> = [{ root: home, scope }]
  if (project) {
    let dir = resolve(project)
    for (let n = 0; n < 20; n++) {
      bases.push({ root: join(dir, '.claude'), scope: { kind: 'project', path: project } })
      if (existsSync(join(dir, '.git'))) break
      const parent = resolve(dir, '..')
      if (parent === dir) break
      dir = parent
    }
  }
  let enabledPlugins: Record<string, unknown> = {}
  for (const base of [bases[0], ...bases.slice(1).reverse()])
    for (const name of ['settings.json', ...(base.scope.kind === 'project' ? ['settings.local.json'] : [])])
      try {
        const file = join(base.root, name)
        if (existsSync(file)) enabledPlugins = { ...enabledPlugins, ...object(jsonFile(file).enabledPlugins) }
      } catch (error) {
        warnings.push('插件设置：' + (error as Error).message)
      }
  const add = (entry: ExtensionEntry): void => {
    if (seen.has(entry.id)) return
    seen.add(entry.id)
    entries.push(entry)
  }
  const scan = (dir: string, kind: 'skills' | 'commands', s: ExtensionScope, depth = 0): void => {
    if (!existsSync(dir) || depth > 8) return
    for (const f of readdirSync(dir, { withFileTypes: true }).slice(0, 2000)) {
      const path = join(dir, f.name)
      if (f.isDirectory() || f.isSymbolicLink()) {
        try {
          if (kind === 'skills' && existsSync(join(path, '.claude-plugin/plugin.json'))) {
            const p = pluginDirectory(path)
            add({
              id: 'native-plugin:' + path,
              kind: 'plugin',
              name: p.name,
              description: p.description,
              origin: 'native',
              enabled: enabledPlugins[p.name + '@skills-dir'] !== false,
              scope: s,
              source: { kind: 'native', location: path },
              path,
              version: p.version,
              components: p.components,
            })
          } else if (kind === 'skills' && existsSync(join(path, 'SKILL.md'))) {
            const c = skillFile(join(path, 'SKILL.md'))
            add({
              id: 'native-skill:' + path,
              kind: 'skill',
              name: c.name,
              description: c.description,
              origin: 'native',
              enabled: true,
              scope: s,
              source: { kind: 'native', location: path },
              path,
              components: [c],
            })
          } else scan(path, kind, s, depth + 1)
        } catch (e) {
          warnings.push(f.name + '：' + (e as Error).message)
        }
      } else if (kind === 'commands' && f.name.endsWith('.md')) {
        try {
          const c = skillFile(path)
          add({
            id: 'native-command:' + path,
            kind: 'skill',
            name: c.name,
            description: c.description,
            origin: 'native',
            enabled: true,
            scope: s,
            source: { kind: 'native', location: path },
            path,
            components: [c],
          })
        } catch (e) {
          warnings.push(f.name + '：' + (e as Error).message)
        }
      }
    }
  }
  for (const b of bases) {
    scan(join(b.root, 'skills'), 'skills', b.scope)
    scan(join(b.root, 'commands'), 'commands', b.scope)
  }
  try {
    const installed = join(home, 'plugins/installed_plugins.json')
    if (existsSync(installed))
      for (const [name, raw] of Object.entries(object(jsonFile(installed).plugins)))
        for (const value of Array.isArray(raw) ? raw : [raw]) {
          const p = object(value),
            path = String(p.installPath ?? '')
          if (!path) continue
          if (p.projectPath && project && resolve(String(p.projectPath)) !== resolve(project)) continue
          if (p.scope !== 'user' && !project) continue
          try {
            const manifest = pluginDirectory(path)
            add({
              id: 'native-installed:' + name + ':' + path,
              kind: 'plugin',
              name,
              description: manifest.description,
              origin: 'native',
              enabled: enabledPlugins[name] !== false,
              scope: p.scope === 'user' ? scope : { kind: 'project', path: project! },
              source: { kind: 'native', location: path },
              path,
              version: String(p.version ?? manifest.version),
              components: manifest.components,
            })
          } catch (e) {
            warnings.push(name + '：' + (e as Error).message)
          }
        }
  } catch (e) {
    warnings.push('原生插件目录：' + (e as Error).message)
  }
  const hide = (config: McpConfig): McpConfig => ({
    ...config,
    env: Object.fromEntries(Object.keys(config.env ?? {}).map(k => [k, MASKED_SECRET])),
    headers: Object.fromEntries(Object.keys(config.headers ?? {}).map(k => [k, MASKED_SECRET])),
  })
  const mcp = (raw: unknown, source: string, s: ExtensionScope): void => {
    for (const [name, v] of Object.entries(object(raw))) {
      try {
        add({
          id: 'native-mcp:' + source + ':' + name,
          kind: 'mcp',
          name,
          description: 'Claude Code 原生配置',
          scope: s,
          origin: 'native',
          enabled: true,
          source: { kind: 'native', location: source },
          path: source,
          components: [],
          mcp: hide(mcpConfig(v)),
        })
      } catch (e) {
        warnings.push(name + '：' + (e as Error).message)
      }
    }
  }
  try {
    const file = env.CLAUDE_CONFIG_DIR ? join(home, '.claude.json') : join(homedir(), '.claude.json')
    if (existsSync(file)) {
      const data = jsonFile(file)
      mcp(data.mcpServers, file, scope)
      if (project) {
        const projects = object(data.projects)
        for (const key of projectKeys(Object.keys(projects), project))
          mcp(object(projects[key]).mcpServers, file, { kind: 'project', path: project })
      }
    }
  } catch (e) {
    warnings.push('原生 MCP：' + (e as Error).message)
  }
  if (project) {
    const file = join(project, '.mcp.json')
    try {
      if (existsSync(file)) mcp(jsonFile(file).mcpServers, file, { kind: 'project', path: project })
    } catch (e) {
      warnings.push('项目 MCP：' + (e as Error).message)
    }
  }
  // 文件版本只用于详情编辑检测，不返回正文或密钥。
  return { entries, warnings }
}
