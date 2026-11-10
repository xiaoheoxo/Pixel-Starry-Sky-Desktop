// 回复里项目外路径的参数检查：只收本机完整路径，网络路径不碰（光查存在性就会去连那台机器）
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, clipboard: {}, dialog: {}, shell: {} }))
vi.mock('../app/data-dir', () => ({ dataRoot: () => '', localRoot: () => '' }))
vi.mock('../core/editors', () => ({ Editors: class {} }))
vi.mock('../ipc/guard', () => ({ handle: vi.fn() }))

const { outsidePath } = await import('./files-ipc')

describe('outsidePath', () => {
  it('本机完整路径照收', () => {
    expect(outsidePath(process.platform === 'win32' ? 'C:/x/a.ts' : '/x/a.ts')).toBeTruthy()
  })
  it('网络路径、相对路径、不是字符串的不收', () => {
    expect(() => outsidePath(String.fromCharCode(92, 92) + 'host' + String.fromCharCode(92) + 'share')).toThrow()
    expect(() => outsidePath('//host/share/a.ts')).toThrow()
    expect(() => outsidePath('a/b.ts')).toThrow()
    expect(() => outsidePath(42)).toThrow()
    expect(() => outsidePath('')).toThrow()
  })
})
