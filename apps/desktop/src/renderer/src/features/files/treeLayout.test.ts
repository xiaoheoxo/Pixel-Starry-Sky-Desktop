import { afterEach, describe, expect, it } from 'vitest'
import { forgetExpanded, nameIndent, noteIndent, rememberExpanded, rememberedExpanded, rowIndent } from './treeLayout'

afterEach(forgetExpanded)

describe('file tree layout', () => {
  it('indents notes with the children and row errors with the file name', () => {
    expect(rowIndent(0)).toBe(10)
    expect(rowIndent(2)).toBe(34)
    // 文件夹里的提示和子项的图标同一列，行的报错和文件名同一列
    expect(noteIndent(2)).toBe(rowIndent(2) + 18)
    expect(nameIndent(1)).toBe(rowIndent(1) + 38)
    expect(rowIndent(40)).toBe(rowIndent(20))
  })

  it('remembers expanded folders per project so remounted rows stay open', () => {
    const a = { projectId: 'a' },
      b = { projectId: 'b' }
    expect(rememberedExpanded(a, 'saves')).toBeUndefined()
    rememberExpanded(a, 'saves', true)
    rememberExpanded(a, 'saves/1.21', true)
    rememberExpanded(a, 'logs', false)
    expect(rememberedExpanded(a, 'saves/1.21')).toBe(true)
    expect(rememberedExpanded(a, 'logs')).toBe(false)
    expect(rememberedExpanded(b, 'saves')).toBeUndefined()
  })

  it('drops the oldest entries past the limit', () => {
    const ref = { projectId: 'p' }
    for (let i = 0; i <= 2000; i++) rememberExpanded(ref, 'd' + i, true)
    expect(rememberedExpanded(ref, 'd0')).toBeUndefined()
    expect(rememberedExpanded(ref, 'd2000')).toBe(true)
  })
})
