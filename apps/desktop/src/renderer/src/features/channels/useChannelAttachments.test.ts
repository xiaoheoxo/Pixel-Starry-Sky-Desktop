import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { MAX_FILE_BYTES, fileAttachmentBlock, validateFiles } from '@pixelsky/protocol'
import { readChannelFile } from './useChannelAttachments'

const jar = (): File => new File([zipSync({ 'com/a/Main.class': strToU8('x'), 'plugin.yml': strToU8('y') })], 'mod.jar')
const PATH = 'E:\\mods\\mod.jar'

describe('频道附件：读不了内容就按路径引用', () => {
  it('jar 有本机路径：变成路径引用，发给成员的内容带路径', async () => {
    const file = await readChannelFile(jar(), PATH)
    expect(file).toMatchObject({ name: 'mod.jar', pathOnly: true, path: PATH, text: '', lines: 0 })
    expect(validateFiles([file])).toEqual([file])
    expect(fileAttachmentBlock(file)).toContain('reference="path"')
  })

  it('jar 没有本机路径（复制来的内容）：报原因，第一行之后是文件列表', async () => {
    const message = await readChannelFile(jar(), '').then(
      () => '',
      e => (e as Error).message,
    )
    expect(message.split('\n')).toHaveLength(2)
    expect(message).toContain('plugin.yml')
  })

  it('二进制和超过 50 MB 的同样按路径引用；没路径的超大文件报太大', async () => {
    const binary = new File([new Uint8Array([0, 1, 2])], 'a.bin')
    expect(await readChannelFile(binary, 'D:\\a.bin')).toMatchObject({ pathOnly: true })
    const huge = new File([new Uint8Array(1)], 'huge.log')
    Object.defineProperty(huge, 'size', { value: MAX_FILE_BYTES + 1 })
    expect(await readChannelFile(huge, 'D:\\huge.log')).toMatchObject({ pathOnly: true, bytes: MAX_FILE_BYTES + 1 })
    await expect(readChannelFile(huge, '')).rejects.toThrow('huge.log')
  })

  it('文本文件内容照常带上，有路径时一起带', async () => {
    const text = new File(['hello\n'], 'a.log')
    expect(await readChannelFile(text, 'D:\\a.log')).toMatchObject({ text: 'hello\n', path: 'D:\\a.log' })
    const pasted = await readChannelFile(text, '')
    expect(pasted.text).toBe('hello\n')
    expect(pasted.path).toBeUndefined()
  })
})
