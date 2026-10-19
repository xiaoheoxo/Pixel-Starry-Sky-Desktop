import { describe, expect, it } from 'vitest'
import { hasWrapperExtra, shellDisplayName } from './commandWrapper'

describe('命令外壳显示', () => {
  it('外壳名：powershell 写成 PowerShell，其他照原样', () => {
    expect(shellDisplayName('powershell')).toBe('PowerShell')
    expect(shellDisplayName('pwsh')).toBe('pwsh')
    expect(shellDisplayName('bash')).toBe('bash')
    expect(shellDisplayName('cmd')).toBe('cmd')
  })

  it('只有额外参数不为空才提醒', () => {
    expect(hasWrapperExtra(undefined)).toBe(false)
    expect(hasWrapperExtra({ line: 'x', shell: 'bash', extra: [] })).toBe(false)
    expect(hasWrapperExtra({ line: 'x', shell: 'cmd', extra: ['/d'] })).toBe(true)
  })
})
