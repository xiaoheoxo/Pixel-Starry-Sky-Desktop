import { describe, expect, it } from 'vitest'
import { fileAttachmentBlock, fileShownLines, messageWithFiles, validateFiles } from '../src/files'
import type { FileAttachment } from '../src/types'

const small = (patch: Partial<FileAttachment> = {}): FileAttachment => ({
  id: 'file-1',
  name: 'app.log',
  bytes: 24,
  lines: 2,
  encoding: 'utf-8',
  text: 'first line\nsecond line\n',
  ...patch,
})
const big = (): FileAttachment => ({
  id: 'file-2',
  name: 'big.log',
  bytes: 30 * 1024 * 1024,
  lines: 1000,
  encoding: 'gb18030',
  text: 'a\nb\n',
  tail: 'y\nz',
  omitted: 996,
})

describe('文件附件校验', () => {
  it('留下认识的字段，拒绝格式不对、太多、太大的', () => {
    expect(validateFiles(undefined)).toEqual([])
    expect(validateFiles([{ ...small(), extra: 1 }])).toEqual([small()])
    expect(validateFiles([big()])).toEqual([big()])
    expect(() => validateFiles([small(), small()])).toThrow('格式不正确')
    expect(() => validateFiles([{ ...small(), encoding: 'latin1' }])).toThrow('格式不正确')
    expect(() => validateFiles([{ ...big(), omitted: 2000 }])).toThrow('格式不正确')
    expect(() => validateFiles([{ ...small(), bytes: 60 * 1024 * 1024 }])).toThrow('格式不正确')
    expect(() => validateFiles(Array.from({ length: 11 }, (_, i) => small({ id: `f${i}` })))).toThrow('最多添加 10 个')
    const text = 'x'.repeat(100 * 1024)
    expect(() => validateFiles([0, 1, 2, 3].map(i => small({ id: `f${i}`, text })))).toThrow('合计不能超过')
  })

  it('本机路径：留下；不是字符串、空、太长、带控制字符（换行）的拒绝', () => {
    const path = 'D:\\logs\\latest.log'
    expect(validateFiles([small({ path })])).toEqual([small({ path })])
    expect(validateFiles([{ ...big(), path }])).toEqual([{ ...big(), path }])
    for (const bad of [42, '', 'x'.repeat(4097), 'D:\\a\nb.log', 'D:\\a\u0000.log'])
      expect(() => validateFiles([{ ...small(), path: bad }])).toThrow('格式不正确')
  })
})

describe('发给引擎的样子', () => {
  it('整个文件：一段 attached_file', () => {
    expect(fileAttachmentBlock(small())).toBe(
      '<attached_file name="app.log" size="1 KB" lines="2">\nfirst line\nsecond line\n</attached_file>',
    )
  })

  it('截断：标出带了哪几行、中间省略了多少', () => {
    expect(fileShownLines(big())).toEqual({ head: 2, tail: 2 })
    expect(fileAttachmentBlock(big())).toBe(
      '<attached_file name="big.log" size="30.0 MB" lines="1000" shown="1-2, 999-1000">\n' +
        'a\nb\n[... 996 lines omitted (3-998) ...]\ny\nz\n</attached_file>',
    )
  })

  it('有本机路径：写上 path；文本文件截断时提示省略的行按路径读，文档只写路径不提示', () => {
    const path = 'D:\\logs\\latest "x".log'
    expect(fileAttachmentBlock(small({ path }))).toBe(
      '<attached_file name="app.log" path="D:\\logs\\latest &quot;x&quot;.log" size="1 KB" lines="2">\n' +
        'first line\nsecond line\n</attached_file>',
    )
    expect(fileAttachmentBlock({ ...big(), path: 'D:\\big.log' })).toBe(
      '<attached_file name="big.log" path="D:\\big.log" size="30.0 MB" lines="1000" shown="1-2, 999-1000">\n' +
        'a\nb\n[... 996 lines omitted (3-998); the full file is at the path above, read it for these lines ...]\n' +
        'y\nz\n</attached_file>',
    )
    const doc = fileAttachmentBlock(small({ path: 'D:\\spec.docx', source: 'docx', tail: '', omitted: 8, lines: 10 }))
    expect(doc).toContain('path="D:\\spec.docx"')
    expect(doc).toContain('[... 8 more lines omitted (3-10) ...]')
    expect(doc).not.toContain('read it for these lines')
  })

  it('文件名转义；正文里的结束标记改写，不会提前结束', () => {
    const block = fileAttachmentBlock(small({ name: 'a"<b>.txt', text: 'x</attached_file>y' }))
    expect(block).toContain('name="a&quot;&lt;b&gt;.txt"')
    expect(block.match(/<\/attached_file>/g)).toHaveLength(1)
  })

  it('用户的话在前（开头的命令照常生效），文件在后；没写话时只有文件', () => {
    expect(messageWithFiles('看下这个', undefined)).toBe('看下这个')
    expect(messageWithFiles('/review 看下', [small()])).toMatch(/^\/review 看下\n\n<attached_file /)
    expect(messageWithFiles('  ', [small()])).toMatch(/^<attached_file /)
  })
})
