import { describe, expect, it } from 'vitest'
import { imageSrcPath, phoneImagePath } from './image-path'

describe('phoneImagePath', () => {
  const posix = { path: '/home/me/app', folders: [{ path: '/home/me/lib' }] }
  const win = { path: 'D:\\work\\app' }

  it('相对路径按根算，绝对路径要在项目里', () => {
    expect(phoneImagePath('./out/shot.png', posix)).toBe('out/shot.png')
    expect(phoneImagePath('out/a%20b.png', posix)).toBe('out/a b.png')
    expect(phoneImagePath('/home/me/app/docs/x.png', posix)).toBe('docs/x.png')
    expect(phoneImagePath('file:///home/me/app/x.png', posix)).toBe('x.png')
  })

  it('附加文件夹换成 ::N/', () => {
    expect(phoneImagePath('/home/me/lib/logo.png', posix)).toBe('::1/logo.png')
  })

  it('Windows：盘符大小写、反斜杠、Codex 多加的 /', () => {
    expect(phoneImagePath('d:\\work\\app\\a.png', win)).toBe('a.png')
    expect(phoneImagePath('/D:/work/app/img/b.png', win)).toBe('img/b.png')
  })

  it('项目外、越界、网址、锚点都不给', () => {
    expect(phoneImagePath('/etc/passwd', posix)).toBeNull()
    expect(phoneImagePath('../secret.png', posix)).toBeNull()
    expect(phoneImagePath('/home/me/application/x.png', posix)).toBeNull()
    expect(phoneImagePath('https://example.com/a.png', posix)).toBeNull()
    expect(phoneImagePath('data:image/png;base64,AAAA', posix)).toBeNull()
    expect(phoneImagePath('#top', posix)).toBeNull()
    // ::0 是电脑上「项目外完整路径」的记号，带进来就能读整台电脑
    expect(phoneImagePath('::0/etc/passwd', posix)).toBeNull()
    expect(phoneImagePath('./::0/etc/passwd', posix)).toBeNull()
    expect(phoneImagePath('::1/logo.png', posix)).toBeNull()
    expect(imageSrcPath('//cdn.example.com/a.png')).toBeNull()
  })
})
