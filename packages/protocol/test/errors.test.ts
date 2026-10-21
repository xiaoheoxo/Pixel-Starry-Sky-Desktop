import { describe, expect, it } from 'vitest'
import { codedError, parseCodedError, replaceCodedErrors } from '../src/errors'

describe('coded host errors', () => {
  it('round-trips code and params through the error message', () => {
    const error = codedError('files.exists', { name: 'a.ts', count: 2 })
    expect(parseCodedError(error.message)).toEqual({ code: 'files.exists', params: { name: 'a.ts', count: 2 } })
    expect(parseCodedError(codedError('files.notFound').message)).toEqual({ code: 'files.notFound', params: {} })
  })
  it('ignores plain messages and broken payloads', () => {
    expect(parseCodedError('文件路径超出项目')).toBeNull()
    expect(parseCodedError('PIXELSKY_ERR:{oops')).toBeNull()
    expect(parseCodedError('PIXELSKY_ERR:{"params":{}}')).toBeNull()
  })
  it('replaces coded fragments inside a wrapped message', () => {
    const wrapped = '启动失败：' + codedError('terminal.scriptNotFound', { name: 'dev' }).message
    expect(replaceCodedErrors(wrapped, ({ code, params }) => `${code}/${params.name}`)).toBe(
      '启动失败：terminal.scriptNotFound/dev',
    )
    expect(replaceCodedErrors('没有代码', () => 'x')).toBe('没有代码')
  })
  it('params containing } followed by whitespace or punctuation still decode', () => {
    const render = ({ code, params }: { code: string; params: Record<string, string | number> }): string =>
      `${code}/${params.path}`
    for (const path of ['src/{id}.ts', 'D:/x/{a} b.txt', '{a}，{b}']) {
      const message = '打开失败：' + codedError('files.notFound', { path }).message + '。重试'
      expect(replaceCodedErrors(message, render)).toBe(`打开失败：files.notFound/${path}。重试`)
    }
    const two = `${codedError('a.b', { path: 'x/{1} y' }).message} 然后 ${codedError('c.d', { path: 'z' }).message}`
    expect(replaceCodedErrors(two, render)).toBe('a.b/x/{1} y 然后 c.d/z')
    expect(replaceCodedErrors('前缀 PIXELSKY_ERR:{oops} 后缀', render)).toBe('前缀 PIXELSKY_ERR:{oops} 后缀')
  })
})
