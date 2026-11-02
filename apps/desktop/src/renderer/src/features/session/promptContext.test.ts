import { describe, expect, it } from 'vitest'
import type { Item, SessionRecord } from '@pixelsky/protocol'
import { promptContext } from './promptContext'

describe('promptContext', () => {
  it('项目文件夹、标题、最近几条对话（截短）；新对话为空', () => {
    const record = { cwd: 'D:\\work\\web\\', title: '登录页' } as SessionRecord
    const items = [
      { kind: 'user', id: 'u0', text: '最早的一条', createdAt: 0 },
      ...Array.from({ length: 6 }, (_, n) => ({
        kind: 'assistant',
        id: `a${n}`,
        text: `回复 ${n}`,
        status: 'completed',
      })),
      { kind: 'reasoning', id: 'r', text: '不带思考', status: 'completed' },
      { kind: 'user', id: 'u1', text: 'x'.repeat(1200), createdAt: 1 },
    ] as Item[]
    const out = promptContext({ record, items })
    expect(out.split('\n').slice(0, 3)).toEqual([
      'Project folder: web',
      'Conversation title: 登录页',
      'Recent conversation:',
    ])
    expect(out).not.toContain('最早的一条')
    expect(out).not.toContain('不带思考')
    expect(out).toContain('Agent: 回复 1')
    expect(out.endsWith('x'.repeat(1000) + '…')).toBe(true)
    expect(promptContext(null)).toBe('')
  })
})
