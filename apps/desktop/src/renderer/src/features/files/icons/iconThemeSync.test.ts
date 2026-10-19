import { afterEach, describe, expect, it, vi } from 'vitest'
import { ICON_THEME_KEY, onIconThemeStorage, subscribeIconThemeChoice } from './store'

// 文件图标主题：另一个窗口（设置独立窗口）改了选项，这个窗口收到 storage 事件后重新解析、通知订阅者。

const area = {}
afterEach(() => vi.unstubAllGlobals())

describe('onIconThemeStorage', () => {
  it('选项键变了才通知订阅者；别的键、别的存储区不理；清空存储也算', () => {
    vi.stubGlobal('localStorage', area)
    const changed = vi.fn()
    const off = subscribeIconThemeChoice(changed)
    onIconThemeStorage({ key: ICON_THEME_KEY, storageArea: area as Storage })
    expect(changed).toHaveBeenCalledTimes(1)
    onIconThemeStorage({ key: 'pixelsky.other', storageArea: area as Storage })
    onIconThemeStorage({ key: ICON_THEME_KEY, storageArea: {} as Storage })
    expect(changed).toHaveBeenCalledTimes(1)
    onIconThemeStorage({ key: null, storageArea: area as Storage })
    expect(changed).toHaveBeenCalledTimes(2)
    off()
    onIconThemeStorage({ key: ICON_THEME_KEY, storageArea: area as Storage })
    expect(changed).toHaveBeenCalledTimes(2)
  })
})
