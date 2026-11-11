import { describe, expect, it } from 'vitest'
import { EXPORT_MAX_CHARS, saveArgs } from './args'

describe('saveArgs', () => {
  it('accepts a name, a known format and text', () => {
    expect(saveArgs({ name: '修复登录页', ext: 'md', content: '# x' })).toEqual({
      name: '修复登录页',
      ext: 'md',
      content: '# x',
    })
  })

  it('accepts txt (terminal output)', () => {
    expect(saveArgs({ name: 'PowerShell 7', ext: 'txt', content: 'PS> ' }).ext).toBe('txt')
  })

  it('strips path separators and illegal characters from the name', () => {
    expect(saveArgs({ name: String.raw`..\..\evil/a:b*?`, ext: 'json', content: '{}' }).name).toBe('.. .. evil a b')
    expect(saveArgs({ name: '  ', ext: 'html', content: '' }).name).toBe('conversation')
  })

  it('rejects unknown formats, non-text content and bad shapes', () => {
    expect(() => saveArgs({ name: 'a', ext: 'exe', content: '' })).toThrow()
    expect(() => saveArgs({ name: 'a', ext: 'toString', content: '' })).toThrow()
    expect(() => saveArgs({ name: 'a', ext: 'md', content: 1 })).toThrow()
    expect(() => saveArgs({ name: 1, ext: 'md', content: '' })).toThrow()
    expect(() => saveArgs({ name: 'a', ext: 'md', content: 'x'.repeat(EXPORT_MAX_CHARS + 1) })).toThrow()
    expect(() => saveArgs(null)).toThrow()
  })
})
