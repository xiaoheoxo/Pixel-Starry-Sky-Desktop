import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/features/files/store'
import { OUTLINE_MAX_CHARS, fileSymbols } from './outlineModel'

type FileDocument = NonNullable<OpenFile['document']>
const text = (content: string): FileDocument => ({
  kind: 'text',
  path: 'a',
  content,
  version: '1',
  bytes: content.length,
  bom: false,
  newline: 'lf',
})
const tab = (path: string, draft: string, document: FileDocument | null = text(draft), loading = false) => ({
  path,
  draft,
  document,
  loading,
})

describe('fileSymbols', () => {
  it('没有文件、读取中、不是文本、不支持的语言、太大各给一种状态', () => {
    expect(fileSymbols(null).kind).toBe('noFile')
    expect(fileSymbols(tab('a.ts', '', null, true)).kind).toBe('loading')
    expect(fileSymbols(tab('a.ts', '', null)).kind).toBe('noText')
    expect(fileSymbols(tab('a.png', '', { kind: 'image', path: 'a.png', dataUrl: '', bytes: 1 })).kind).toBe('noText')
    expect(fileSymbols(tab('a.go', 'func main() {}')).kind).toBe('unsupported')
    expect(fileSymbols(tab('a.ts', 'x'.repeat(OUTLINE_MAX_CHARS + 1))).kind).toBe('tooLarge')
  })
  it('列出声明并带上缩进层数', () => {
    const src = ['class A {', '  run() {', '  }', '}', 'function b() {}'].join('\n')
    const r = fileSymbols(tab('a.ts', src))
    expect(r.kind === 'ready' && r.items.map(d => [d.name, d.depth, d.line])).toEqual([
      ['A', 0, 1],
      ['run', 1, 2],
      ['b', 0, 5],
    ])
  })
})
