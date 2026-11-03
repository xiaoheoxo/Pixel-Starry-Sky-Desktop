// 行内改写（docs/ui/coding-tier2.md §6）：拼提示、剥围栏、截断和空结果
import { describe, expect, it } from 'vitest'
import type { AiInlineEditRequest } from '../../../shared/types/ai'
import type { ModelDeps } from './commit-message'
import { cleanCode, inlineEdit, inlineEditPrompt } from './inline-edit'

const req: AiInlineEditRequest = {
  requestId: 'r1',
  source: 'platform',
  groups: ['7'],
  providerId: null,
  model: 'claude-haiku',
  path: 'src/store.ts',
  language: 'typescript',
  before: 'export function markAllRead(list) {',
  code: '  const out = []\n  return out',
  after: '}',
  instruction: ' 改成 map ',
}
const never = new AbortController().signal
const reply = (text: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ content: [{ type: 'text', text }], ...extra }), { status: 200 })
const deps = (platform: ModelDeps['platform']): ModelDeps => ({
  platform,
  provider: () => null,
  fetch: () => Promise.reject(new Error('不该走自定义接口')),
  engine: () => Promise.reject(new Error('不该走引擎')),
})

describe('inlineEditPrompt', () => {
  it('带路径、语言、前后文、选区和要求', () => {
    expect(inlineEditPrompt(req)).toBe(
      [
        'File: src/store.ts (typescript)',
        '',
        '<before_selection>',
        'export function markAllRead(list) {',
        '</before_selection>',
        '<selection>',
        '  const out = []\n  return out',
        '</selection>',
        '<after_selection>',
        '}',
        '</after_selection>',
        '',
        'Instruction:',
        '改成 map',
      ].join('\n'),
    )
    expect(inlineEditPrompt({ ...req, language: '' })).toMatch(/^File: src\/store\.ts\n/)
  })
})

describe('cleanCode', () => {
  it('剥掉外层围栏，保留首行缩进', () => {
    expect(cleanCode('```ts\n  return list.map(f)\n```\n', 'x')).toBe('  return list.map(f)')
    expect(cleanCode('\n\n  a()\r\n  b()  \n\n', 'x')).toBe('  a()\n  b()')
  })
  it('夹了说明时取最长的围栏块', () => {
    expect(cleanCode('改好了：\n```\nx\n```\n另一种：\n```js\nyy\nzz\n```\n说明', 'x')).toBe('yy\nzz')
  })
  it('原文自己带围栏（Markdown）时原样保留', () => {
    const md = '```sh\npnpm i\n```'
    expect(cleanCode(md, '```sh\nnpm i\n```')).toBe(md)
  })
})

describe('inlineEdit', () => {
  it('问一次模型，回改写后的代码', async () => {
    let sent: { system?: string; messages?: Array<{ content: string }> } = {}
    const out = await inlineEdit(
      deps(async body => {
        sent = JSON.parse(body)
        return reply('```ts\n  return list.map(t => t)\n```')
      }),
      req,
      never,
    )
    expect(out).toMatchObject({ ok: true, message: '  return list.map(t => t)', groupId: '7', partial: 0 })
    expect(sent.system).toContain('Output only the code')
    expect(sent.messages?.[0].content).toContain('<selection>\n  const out = []')
  })
  it('截断报太长；空回复报没写出东西', async () => {
    expect(
      await inlineEdit(
        deps(async () => reply('a', { stop_reason: 'max_tokens' })),
        req,
        never,
      ),
    ).toEqual({
      ok: false,
      problem: 'tooLong',
      detail: '',
    })
    expect(
      await inlineEdit(
        deps(async () => reply('```\n```')),
        req,
        never,
      ),
    ).toMatchObject({ problem: 'empty' })
  })
})
