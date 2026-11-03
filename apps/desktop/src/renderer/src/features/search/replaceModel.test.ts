import { describe, expect, it } from 'vitest'
import { NO_OPTIONS, previewLine, regexError, replaceInText, searchRegExp } from './replaceModel'
import { demoFileHits } from './fileSearch'

const opts = (o: Partial<typeof NO_OPTIONS>) => ({ ...NO_OPTIONS, ...o })

describe('左栏搜索 › 替换', () => {
  it('固定字符串默认忽略大小写，特殊字符按字面；整词前后不能是字母数字下划线', () => {
    expect('a.b A.B axb'.match(searchRegExp('a.b', NO_OPTIONS))).toEqual(['a.b', 'A.B'])
    expect('Foo foo'.match(searchRegExp('foo', opts({ caseSensitive: true })))).toEqual(['foo'])
    expect('foo foobar _foo foo-x'.match(searchRegExp('foo', opts({ wholeWord: true })))?.length).toBe(2)
  })
  it('正则写错给出说明，不抛', () => {
    expect(regexError('(a', opts({ regex: true }))).toBeTruthy()
    expect(regexError('(a', NO_OPTIONS)).toBeNull()
  })
  it('前后对比：正则展开 $1，固定字符串里的 $ 原样换上', () => {
    const re = searchRegExp('get(\\w+)', opts({ regex: true }))
    expect(previewLine('  getUser(getId)', re, 'fetch$1', true)).toEqual([
      { text: '  ', kind: 'same' },
      { text: 'getUser', kind: 'del' },
      { text: 'fetchUser', kind: 'ins' },
      { text: '(', kind: 'same' },
      { text: 'getId', kind: 'del' },
      { text: 'fetchId', kind: 'ins' },
      { text: ')', kind: 'same' },
    ])
    expect(previewLine('x = 1', searchRegExp('x', NO_OPTIONS), '$1', false)).toEqual([
      { text: 'x', kind: 'del' },
      { text: '$1', kind: 'ins' },
      { text: ' = 1', kind: 'same' },
    ])
  })
  it('替换整个文件保留 CRLF / LF，计数每一处；只给某些行时别的行不动', () => {
    const text = 'foo foo\r\nbar\r\nfoo\nend'
    const re = searchRegExp('foo', NO_OPTIONS)
    expect(replaceInText(text, re, 'baz', false, null)).toEqual({ text: 'baz baz\r\nbar\r\nbaz\nend', count: 3 })
    expect(replaceInText(text, re, 'baz', false, new Set([3]))).toEqual({
      text: 'foo foo\r\nbar\r\nbaz\nend',
      count: 1,
    })
    // 正则按行匹配：$ 不吃掉 \r
    expect(replaceInText('a1\r\nb2\r\n', searchRegExp('(\\d)$', opts({ regex: true })), '<$1>', true, null)).toEqual({
      text: 'a<1>\r\nb<2>\r\n',
      count: 2,
    })
  })
  it('演示模式的内容搜索也按开关匹配', () => {
    const hits = demoFileHits({ projectId: 'p' }, { 'a.ts': 'Foo\nfoo' }, 'foo', 'full', opts({ caseSensitive: true }))
    expect(hits.hits.filter(h => h.line !== null).map(h => h.line)).toEqual([2])
  })
})
