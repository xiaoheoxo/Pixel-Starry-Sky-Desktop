import { describe, expect, it, vi } from 'vitest'
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { getWordComplete, onWordCompleteChange, setWordComplete, wordSection, wordSource } from './words'

const DOC = 'const handleSubmit = 1\nconst handleSuccess = 2\n'

async function complete(typed: string, explicit = false, grouped = false): Promise<CompletionResult | null> {
  const doc = DOC + typed
  const context = new CompletionContext(EditorState.create({ doc }), doc.length, explicit)
  return wordSource(grouped ? wordSection() : undefined)(context)
}

describe('单词补全', () => {
  it('只敲了 1 个字符不弹，第 2 个字符起按前缀列出本文件的单词（不含正在敲的这个）', async () => {
    expect(await complete('h')).toBeNull()
    const result = await complete('ha')
    expect(result?.from).toBe(DOC.length)
    const labels = result?.options.map(o => o.label)
    expect(labels).toEqual(['handleSubmit', 'handleSuccess'])
    expect(labels).not.toContain('ha')
  })

  // 直接喂文档，光标在末尾
  const at = (doc: string) => wordSource()(new CompletionContext(EditorState.create({ doc }), doc.length, false))

  it('只认前缀，不做模糊匹配', async () => {
    expect(await at('extended other together\nthe end')).toBeNull()
  })

  it('文件别处有一模一样的词时不列它，敲完整就不弹（回车照常换行）', async () => {
    expect((await at('return a\nreturn b\nretu'))?.options.map(o => o.label)).toEqual(['return'])
    expect(await at('return a\nreturn b\nreturn')).toBeNull()
    expect(await at('Return a\nreturn')).toBeNull()
  })

  it('中日韩文字不补，也不出现在列表里', async () => {
    expect(await at('## 验证与开发实例\n## 验证')).toBeNull()
    expect((await at('验证 node 与no\nno'))?.options.map(o => o.label)).toEqual(['node'])
  })

  it('Ctrl+Space 主动叫出来时 1 个字符也弹', async () => {
    expect(await complete('h', true)).not.toBeNull()
  })

  it('和片段放在一起时单词归到第二组（片段 rank 0 排前面）', async () => {
    const result = await complete('ha', false, true)
    expect(result?.options.every(o => typeof o.section === 'object' && o.section.rank === 1)).toBe(true)
    expect((await complete('ha'))?.options[0]?.section).toBeUndefined()
  })

  it('开关默认开，改了通知订阅方', () => {
    expect(getWordComplete()).toBe(true)
    const fn = vi.fn()
    const off = onWordCompleteChange(fn)
    setWordComplete(false)
    setWordComplete(false)
    expect(getWordComplete()).toBe(false)
    expect(fn).toHaveBeenCalledTimes(1)
    off()
    setWordComplete(true)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
