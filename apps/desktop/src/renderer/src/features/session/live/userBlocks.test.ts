// 用户消息拆分与折叠阈值（docs/ui/conversation-ux-2.md §2.4）
import { describe, expect, it } from 'vitest'
import { shouldFoldGuidance, shouldFoldUser, userBlocks } from './userBlocks'

describe('用户消息拆成文字段和代码段', () => {
  it('成对的代码块按代码显示，前后的空行去掉', () => {
    expect(userBlocks('帮我改：\n\n```ts\nconst a = 1\nconst b = 2\n```\n\n改完跑测试')).toEqual([
      { kind: 'text', text: '帮我改：' },
      { kind: 'code', lang: 'ts', code: 'const a = 1\nconst b = 2' },
      { kind: 'text', text: '改完跑测试' },
    ])
  })

  it('没有语言、波浪线、多个代码块、更长的围栏', () => {
    expect(userBlocks('```\nx\n```\n~~~py\ny\n~~~')).toEqual([
      { kind: 'code', lang: null, code: 'x' },
      { kind: 'code', lang: 'py', code: 'y' },
    ])
    expect(userBlocks('````md\n```js\nz\n```\n````')).toEqual([{ kind: 'code', lang: 'md', code: '```js\nz\n```' }])
  })

  it('没闭合的照原文；没有代码块时整条是一段文字', () => {
    expect(userBlocks('看这个\n```ts\nconst a = 1')).toEqual([{ kind: 'text', text: '看这个\n```ts\nconst a = 1' }])
    expect(userBlocks('/review 看看 `a.ts`')).toEqual([{ kind: 'text', text: '/review 看看 `a.ts`' }])
  })

  it('行内的三个反引号不算代码块', () => {
    expect(userBlocks('用 ```ts``` 包起来')).toEqual([{ kind: 'text', text: '用 ```ts``` 包起来' }])
  })
})

describe('长消息折叠', () => {
  it('超过 16 行或 1200 个字才折叠', () => {
    expect(shouldFoldUser(Array(16).fill('a').join('\n'))).toBe(false)
    expect(shouldFoldUser(Array(17).fill('a').join('\n'))).toBe(true)
    expect(shouldFoldUser('字'.repeat(1200))).toBe(false)
    expect(shouldFoldUser('字'.repeat(1201))).toBe(true)
  })
})

describe('引导消息折叠', () => {
  it('超过 6 行或 300 个字就折叠，比普通消息紧', () => {
    expect(shouldFoldGuidance(Array(6).fill('a').join('\n'))).toBe(false)
    expect(shouldFoldGuidance(Array(7).fill('a').join('\n'))).toBe(true)
    expect(shouldFoldGuidance('字'.repeat(300))).toBe(false)
    expect(shouldFoldGuidance('字'.repeat(301))).toBe(true)
  })
})
