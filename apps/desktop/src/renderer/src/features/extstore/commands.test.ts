import { describe, expect, it, vi } from 'vitest'
import { extStoreCommands } from './commands'
import { consumeExtSearchFocus, getExtTab, openExtTab } from './nav'

describe('扩展命令', () => {
  it('两条：id 和文案键', () => {
    const cmds = extStoreCommands({ openSettings: vi.fn(), checkUpdates: vi.fn() })
    expect(cmds.map(c => [c.id, c.key])).toEqual([
      ['extstore.checkUpdates', 'extstore.command.checkUpdates'],
      ['extstore.search', 'extstore.command.search'],
    ])
  })
  it('搜索：切到发现页签、请求聚焦搜索框、打开设置 › 扩展', () => {
    const openSettings = vi.fn()
    openExtTab('installed')
    extStoreCommands({ openSettings, checkUpdates: vi.fn() })[1].run()
    expect(getExtTab()).toBe('discover')
    expect(openSettings).toHaveBeenCalledWith('extensions')
    expect(consumeExtSearchFocus()).toBe(true)
    expect(consumeExtSearchFocus()).toBe(false)
  })
  it('检查更新：切到已安装页签、查更新', () => {
    const openSettings = vi.fn()
    const checkUpdates = vi.fn()
    openExtTab('discover')
    extStoreCommands({ openSettings, checkUpdates })[0].run()
    expect(getExtTab()).toBe('installed')
    expect(openSettings).toHaveBeenCalledWith('extensions')
    expect(checkUpdates).toHaveBeenCalledTimes(1)
  })
})
