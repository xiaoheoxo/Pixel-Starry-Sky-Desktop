// 「始终允许」回传给 Claude Code 的权限规则：CLI 没给建议时命令不能退回成整个工具都放行
import { describe, expect, it } from 'vitest'
import { alwaysPermissions } from '../src/claude/tools'

describe('alwaysPermissions', () => {
  it('有「添加允许规则」的建议：照用，保存位置换成所选范围；别的建议（setMode）不带', () => {
    const suggestions = [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
        behavior: 'allow',
        destination: 'session',
      },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ]
    expect(alwaysPermissions('Bash', suggestions, 'project', { command: 'npm test' })).toEqual([
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ])
  })

  it('命令没有建议（复合命令、重定向）：只放行这一条完全相同的命令，不放行整个 Bash', () => {
    for (const toolName of ['Bash', 'PowerShell'])
      expect(alwaysPermissions(toolName, [], 'user', { command: '  rm -rf dist && npm run build > log.txt ' })).toEqual(
        [
          {
            type: 'addRules',
            rules: [{ toolName, ruleContent: 'rm -rf dist && npm run build > log.txt' }],
            behavior: 'allow',
            destination: 'userSettings',
          },
        ],
      )
    // 只有 setMode 建议也一样
    expect(
      alwaysPermissions('Bash', [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], 'session', {
        command: 'make',
      }),
    ).toEqual([
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'make' }],
        behavior: 'allow',
        destination: 'session',
      },
    ])
  })

  it('命令为空：只放行这一次，不存规则', () => {
    expect(alwaysPermissions('Bash', [], 'project', {})).toEqual([])
    expect(alwaysPermissions('Bash', [], 'project', { command: '   ' })).toEqual([])
  })

  it('其他工具没有建议：照旧允许整个工具', () => {
    expect(alwaysPermissions('Write', [], 'session', { file_path: 'a.txt' })).toEqual([
      { type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'session' },
    ])
    expect(alwaysPermissions('mcp__github__create_issue', [], 'project')).toEqual([
      {
        type: 'addRules',
        rules: [{ toolName: 'mcp__github__create_issue' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ])
  })
})
