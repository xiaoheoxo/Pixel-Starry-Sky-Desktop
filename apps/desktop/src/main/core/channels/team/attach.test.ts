import { describe, expect, it } from 'vitest'
import { validateFiles, type FileAttachment, type ImageAttachment } from '@pixelsky/protocol'
import { translateMessage } from '../../../../shared/i18n/translate'
import { attachedOf, clipName, fileUploadText, toFile, toImage, uploadsOf } from './attach'
import type { TeamAttachmentData } from './api'

const limits = { images: 5, files: 5, imageBytes: 2 << 20, fileBytes: 256 << 10 }
const image = (id: string, bytes = 70): ImageAttachment => ({
  id,
  name: `${id}.png`,
  mediaType: 'image/png',
  bytes,
  width: 4,
  height: 3,
  dataBase64: 'iVBORw0KGgo=',
})
const file = (id: string, patch: Partial<FileAttachment> = {}): FileAttachment => ({
  id,
  name: `${id}.log`,
  bytes: 5,
  lines: 1,
  encoding: 'utf-8',
  text: 'hello',
  ...patch,
})
/** 上传的那份存到云端再取回来的样子 */
const stored = (up: ReturnType<typeof uploadsOf>[number], id: string): TeamAttachmentData => ({
  id,
  kind: up.kind,
  name: up.name,
  mime: up.kind === 'image' ? 'image/png' : 'text/plain',
  bytes: up.bytes ?? 8,
  width: up.width ?? 0,
  height: up.height ?? 0,
  lines: up.lines ?? 0,
  encoding: up.encoding ?? '',
  dataBase64: up.dataBase64,
})

describe('团队频道的附件转换（docs/ui/channels-unify.md §9）', () => {
  it('图片在前、文件在后；文件传的是文字，带着原文件的大小、行数、编码', () => {
    const ups = uploadsOf(
      [image('a')],
      [file('f', { bytes: 9000, lines: 120, encoding: 'gb18030', text: '第一行\n' })],
      limits,
    )
    expect(ups.map(u => u.kind)).toEqual(['image', 'file'])
    expect(ups[0]).toMatchObject({ name: 'a.png', width: 4, height: 3 })
    expect(ups[1]).toMatchObject({ name: 'f.log', bytes: 9000, lines: 120, encoding: 'gb18030' })
    expect(Buffer.from(ups[1].dataBase64, 'base64').toString('utf8')).toBe('第一行\n')
  })

  it('取回来和发出去的一样；截断的文件拆回开头、结尾和省略的行数，还能通过发给引擎前的校验', () => {
    const cut = file('big', { bytes: 500_000, lines: 9000, text: 'a\nb\n', tail: 'y\nz\n', omitted: 8996 })
    expect(fileUploadText(cut)).toBe('a\nb\n[... 8996 lines omitted by pixelsky-attachment ...]\ny\nz\n')
    const [whole, part] = uploadsOf([], [file('f'), cut], limits)
    expect(toFile(stored(whole, 'tf_1'))).toEqual({ ...file('f'), id: 'tf_1' })
    const back = toFile(stored(part, 'tf_2'))
    expect(back).toEqual({ ...cut, id: 'tf_2' })
    expect(validateFiles([back])).toHaveLength(1)
    // 只留开头的（文档）：结尾是空串
    const doc = file('doc', { lines: 50, text: '标题\n', tail: '', omitted: 49 })
    expect(toFile(stored(uploadsOf([], [doc], limits)[0], 'tf_3'))).toEqual({ ...doc, id: 'tf_3' })
    // 完整的文件里恰好有一行省略说明：不拆
    const odd = file('odd', { lines: 30, text: 'x\n[... 5 lines omitted ...]\ny\n' })
    expect(toFile(stored(uploadsOf([], [odd], limits)[0], 'tf_4'))?.tail).toBeUndefined()
    const [img] = uploadsOf([image('a')], [], limits)
    expect(toImage(stored(img, 'tf_5'))).toEqual({ ...image('a', 8), id: 'tf_5' })
  })

  it('不合适的说明原因：只有路径的文件、超过张数 / 个数、单个太大、空文件', () => {
    expect(() => uploadsOf([], [file('p', { pathOnly: true, path: 'D:/a.zip', text: '', lines: 0 })], limits)).toThrow(
      '只带了路径',
    )
    expect(() =>
      uploadsOf(
        ['a', 'b', 'c'].map(id => image(id)),
        [],
        { ...limits, images: 2 },
      ),
    ).toThrow('图片数不能超过 2')
    expect(() => uploadsOf([], [file('a'), file('b')], { ...limits, files: 1 })).toThrow('文件数不能超过 1')
    expect(() => uploadsOf([image('big', (2 << 20) + 1)], [], limits)).toThrow('单张不能超过 2 MB')
    expect(() => uploadsOf([], [file('long', { text: '字'.repeat(90_000) })], limits)).toThrow('不能超过 256 KB')
    expect(() => uploadsOf([], [file('empty', { text: '' })], limits)).toThrow('是空的')
  })

  it('这些原因都有英文', () => {
    for (const make of [
      () => uploadsOf([image('big', (2 << 20) + 1)], [], limits),
      () => uploadsOf([], [file('empty', { text: '' })], limits),
      () => uploadsOf([], [file('a'), file('b')], { ...limits, files: 1 }),
    ]) {
      let text = ''
      try {
        make()
      } catch (e) {
        text = (e as Error).message
      }
      expect(text).not.toBe('')
      expect(translateMessage(text, 'en-US')).not.toMatch(/[\u4e00-\u9fff]/)
    }
  })

  it('消息上的说明转成界面用的样子；不认识的图片类型不显示；名字太长留着扩展名截短', () => {
    const base = { bytes: 10, width: 0, height: 0, lines: 0, encoding: '' }
    expect(attachedOf([])).toBeUndefined()
    expect(
      attachedOf([
        { ...base, id: 'tf_1', kind: 'image', name: 'a.png', mime: 'image/png', width: 4, height: 3 },
        { ...base, id: 'tf_2', kind: 'image', name: 'a.bmp', mime: 'image/bmp' },
        { ...base, id: 'tf_3', kind: 'file', name: 'a.log', mime: 'text/plain', lines: 7, encoding: 'gb18030' },
      ]),
    ).toEqual({
      images: [{ id: 'tf_1', name: 'a.png', mediaType: 'image/png', bytes: 10, width: 4, height: 3 }],
      files: [{ id: 'tf_3', name: 'a.log', bytes: 10, lines: 7, encoding: 'gb18030' }],
    })
    const long = clipName(`${'长'.repeat(300)}.png`)
    expect([...long]).toHaveLength(200)
    expect(long.endsWith('.png')).toBe(true)
    expect(clipName('短.txt')).toBe('短.txt')
  })
})
