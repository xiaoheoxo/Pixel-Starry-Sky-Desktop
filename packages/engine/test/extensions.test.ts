import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { effective, expandedMcp, inside, mcpConfig, pluginDirectory, skillFile } from '../src/extensions/parse'
import type { ExtensionEntry } from '@pixelsky/protocol'
import { makeTmp, removeTmp } from './helpers/tmp'
let root: string
beforeEach(() => {
  root = makeTmp('extension-parser')
})
afterEach(() => removeTmp(root))
describe('扩展解析与范围', () => {
  it('MCP 环境引用按会话环境解析，缺失值显式报错', () => {
    expect(
      expandedMcp(
        { type: 'http', url: '${BASE}/mcp', headers: { Authorization: 'Bearer ${TOKEN:-local}' } },
        { BASE: 'https://example.com' },
      ),
    ).toMatchObject({ url: 'https://example.com/mcp', headers: { Authorization: 'Bearer local' } })
    expect(() => expandedMcp({ type: 'stdio', command: '${MISSING}' }, {})).toThrow('MISSING')
  })
  it('项目停用覆盖全局启用，不影响其他项目', () => {
    const base: ExtensionEntry = {
      id: 'a',
      kind: 'mcp',
      name: 'tools',
      description: '',
      scope: { kind: 'global' },
      enabled: true,
      origin: 'managed',
      source: { kind: 'created', location: '' },
      components: [],
    }
    const local = { ...base, id: 'b', scope: { kind: 'project' as const, path: root }, enabled: false }
    expect(effective([local, base], root)).toEqual([])
    expect(effective([base, local], root + '-other')).toEqual([base])
  })
  it('拒绝越界、错误传输和无类型 URL；兼容 streamable-http', () => {
    expect(() => inside(root, join(root, '../outside'))).toThrow('超出')
    expect(() => mcpConfig({ url: 'https://example.com' })).toThrow('命令')
    expect(() => mcpConfig({ type: 'sdk' })).toThrow('支持')
    expect(mcpConfig({ type: 'streamable-http', url: 'https://example.com/mcp' })).toMatchObject({ type: 'http' })
    expect(() => mcpConfig({ type: 'http', url: 'https://user:pass@example.com' })).toThrow('凭据')
  })
  it('读取 YAML 与支持文件，避免把插件停用条件当成可调用技能', () => {
    const dir = join(root, 'skills/run')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: run\ndescription: |\n  执行项目测试\nuser-invocable: false\n---\n# 步骤\n',
    )
    mkdirSync(join(root, '.claude-plugin'))
    writeFileSync(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'tools', version: '1.0' }))
    const p = pluginDirectory(root)
    expect(p.components).toHaveLength(1)
    expect(p.components[0]).toMatchObject({ name: 'run', invocable: false })
    expect(skillFile(join(dir, 'SKILL.md')).description).toContain('执行')
  })
  it('拒绝插件 manifest 的包外组件路径', () => {
    mkdirSync(join(root, '.claude-plugin'))
    writeFileSync(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'tools', skills: '../outside' }))
    expect(() => pluginDirectory(root)).toThrow('超出')
  })
  it('插件目录先整体校验再读 manifest：层级过深先报错，组件只遍历一次也不丢', () => {
    const deep = join(root, 'deep'),
      nested = join(deep, ...Array.from({ length: 18 }, (_, i) => 'd' + i))
    mkdirSync(nested, { recursive: true })
    // 没有 plugin.json：若先读 manifest 会报找不到文件，这里要先报目录问题
    expect(() => pluginDirectory(deep)).toThrow('层级过深')
    const ok = join(root, 'ok')
    mkdirSync(join(ok, '.claude-plugin'), { recursive: true })
    mkdirSync(join(ok, 'skills/a'), { recursive: true })
    mkdirSync(join(ok, 'commands'), { recursive: true })
    writeFileSync(join(ok, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'pack', skills: 'extra' }))
    writeFileSync(join(ok, 'skills/a/SKILL.md'), '---\nname: a\n---\nx')
    writeFileSync(join(ok, 'commands/c.md'), '---\nname: c\n---\nx')
    mkdirSync(join(ok, 'extra/b'), { recursive: true })
    writeFileSync(join(ok, 'extra/b/SKILL.md'), '---\nname: b\n---\nx')
    expect(
      pluginDirectory(ok)
        .components.map(c => c.name)
        .sort(),
    ).toEqual(['a', 'b', 'c'])
  })
  it('plugin.json 里内联写的 mcpServers 对象也读出 MCP；数组形式照旧读文件', () => {
    mkdirSync(join(root, '.claude-plugin'))
    writeFileSync(
      join(root, '.claude-plugin/plugin.json'),
      JSON.stringify({ name: 'tools', mcpServers: { inline: { command: 'node', args: ['s.js'] } } }),
    )
    expect(pluginDirectory(root).components).toMatchObject([{ kind: 'mcp', name: 'inline' }])
    writeFileSync(join(root, 'a.json'), JSON.stringify({ mcpServers: { fromFile: { command: 'node' } } }))
    writeFileSync(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'tools', mcpServers: ['a.json'] }))
    expect(pluginDirectory(root).components).toMatchObject([{ kind: 'mcp', name: 'fromFile' }])
  })
})
