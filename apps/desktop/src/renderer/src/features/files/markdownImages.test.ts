import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileDocument, WorkspaceRef } from '../../../../shared/types/workspace'

vi.mock('@/features/machines/store', () => ({
  machineOf: (id?: string) => (id?.startsWith('wsl-') ? 'wsl-a' : 'local'),
  isWindowsMachine: (id: string) => id === 'local' && window.pixelsky?.platform === 'win32',
}))

const image = { kind: 'image' as const, path: 'screen.png', dataUrl: 'data:image/png;base64,iVBORw==', bytes: 4 }
const read = vi.fn(async (_ref: WorkspaceRef, _path: string): Promise<FileDocument> => image)
const listExisting = vi.fn()
const target = vi.fn(async (ref: { sessionId: string }) =>
  ref.sessionId.startsWith('wsl-')
    ? { path: '/home/me/repo', folders: [{ path: '/home/me/assets', name: 'assets' }] }
    : { path: 'D:\\repo' },
)
vi.stubGlobal('window', { pixelsky: { platform: 'win32', files: { target, read, listExisting } } })

const { readMarkdownImage } = await import('./markdownImages')
let next = 0
const session = (machine = 'wsl-a') => ({ sessionId: `${machine}~${++next}` })
beforeEach(() => {
  read.mockReset().mockResolvedValue(image)
  listExisting.mockClear()
})

describe('会话正文图片读取', () => {
  it('Windows 窗口里的 WSL 绝对路径按 WSL 会话读取，不依赖可能过期的目录列表', async () => {
    const ref = session()
    expect(await readMarkdownImage(ref, '/home/me/repo/screenshots/最新截图.png')).toEqual({
      src: image.dataUrl,
      bytes: 4,
    })
    expect(read).toHaveBeenCalledWith(ref, 'screenshots/最新截图.png')
    expect(listExisting).not.toHaveBeenCalled()
  })

  it('相对路径和带空格的路径也通过同一个会话读取', async () => {
    const ref = session()
    await readMarkdownImage(ref, './my images/screen.png')
    expect(read).toHaveBeenCalledWith(ref, 'my images/screen.png')
  })

  it('切回本机会话后使用 Windows 项目路径，同名图片不会复用 WSL 的数据', async () => {
    const remote = session()
    const local = session('local')
    await readMarkdownImage(remote, 'screen.png')
    await readMarkdownImage(local, 'D:\\repo\\screen.png')
    expect(read.mock.calls).toEqual([
      [remote, 'screen.png'],
      [local, 'screen.png'],
    ])
  })

  it('WSL 附加文件夹中的图片使用对应文件夹读取', async () => {
    const ref = session()
    await readMarkdownImage(ref, '/home/me/assets/screen.png')
    expect(read).toHaveBeenCalledWith(ref, '::1/screen.png')
  })

  it('项目外路径、另一台机器的路径和路径越界不触发读取', async () => {
    const ref = session()
    for (const path of ['/etc/screen.png', 'D:/repo/screen.png', '../../outside.png'])
      expect(await readMarkdownImage(ref, path)).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('非图片文件不能当成图片数据返回', async () => {
    read.mockResolvedValueOnce({ kind: 'unsupported', path: 'README.md', reason: 'not an image', bytes: 4 })
    expect(await readMarkdownImage(session(), 'README.md')).toBeNull()
  })
})
