// 原生扩展扫描：~/.claude.json 里项目级 MCP 的键在 Windows 上有反斜杠 / 正斜杠两种写法
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nativeEntries, projectKeys } from './native'

let root: string | undefined
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

describe('projectKeys', () => {
  it('Windows 路径：反斜杠、正斜杠、盘符大小写不同都算同一个项目，正斜杠的排前面', () => {
    const keys = ['d:\\PixelSky', 'D:/PixelSky', 'D:/PixelSky/apps', 'E:/PixelSky']
    expect(projectKeys(keys, 'D:\\PixelSky')).toEqual(['D:/PixelSky', 'd:\\PixelSky'])
    expect(projectKeys(keys, 'd:/pixelsky')).toEqual(['D:/PixelSky', 'd:\\PixelSky'])
  })
  it('非 Windows 路径只认原样的键', () => {
    expect(projectKeys(['/home/a/p', '/home/a/P'], '/home/a/p')).toEqual(['/home/a/p'])
    expect(projectKeys(['/home/a/P'], '/home/a/p')).toEqual([])
  })
})

describe('nativeEntries 项目级 MCP', () => {
  it('两种写法的键都读出来合并，同名以正斜杠（新版）的为准', () => {
    const scratch = resolve('../../scratch')
    mkdirSync(scratch, { recursive: true })
    root = mkdtempSync(join(scratch, 'native-extensions-'))
    const config = join(root, 'claude')
    mkdirSync(config)
    writeFileSync(
      join(config, '.claude.json'),
      JSON.stringify({
        projects: {
          'D:\\Work\\app': { mcpServers: { old: { command: 'old-cmd' }, both: { command: 'from-backslash' } } },
          'd:/Work/app': { mcpServers: { fresh: { command: 'fresh-cmd' }, both: { command: 'from-slash' } } },
          'D:/Work/other': { mcpServers: { other: { command: 'other-cmd' } } },
        },
      }),
    )
    const { entries } = nativeEntries('D:\\Work\\app', { CLAUDE_CONFIG_DIR: config })
    const mcp = entries.filter(e => e.kind === 'mcp')
    expect(mcp.map(e => e.name).sort()).toEqual(['both', 'fresh', 'old'])
    expect(mcp.find(e => e.name === 'both')?.mcp).toMatchObject({ command: 'from-slash' })
    expect(mcp.every(e => e.scope.kind === 'project')).toBe(true)
  })
})
