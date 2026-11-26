import { describe, expect, it } from 'vitest'
import { minimizeTarget, minimizeWithParent, type OwnedWindow } from './owned-window'

// 子窗口（置顶的设置窗口、付款窗口）在 Windows 上单独最小化会缩成屏幕左下角的白条：改成最小化父窗口

class Win implements OwnedWindow {
  calls: string[] = []
  destroyed = false
  minimized = false
  private handlers: Array<() => void> = []
  constructor(public parent: Win | null = null) {}
  getParentWindow = () => this.parent
  isDestroyed = () => this.destroyed
  isMinimized = () => this.minimized
  minimize = () => {
    this.calls.push('minimize')
    this.minimized = true
    for (const fn of this.handlers) fn()
  }
  restore = () => {
    this.calls.push('restore')
    this.minimized = false
  }
  on(_event: 'minimize', fn: () => void): void {
    this.handlers.push(fn)
  }
}

describe('owned-window', () => {
  it('窗口按钮：Windows 上有父窗口最小化父窗口，没有就最小化自己；别的系统照常', () => {
    const main = new Win()
    const child = new Win(main)
    expect(minimizeTarget(child, 'win32')).toBe(main)
    expect(minimizeTarget(main, 'win32')).toBe(main)
    expect(minimizeTarget(child, 'darwin')).toBe(child)
    main.destroyed = true
    expect(minimizeTarget(child, 'win32')).toBe(child)
  })

  it('子窗口被最小化（Win+↓）：自己还原，父窗口最小化', () => {
    const main = new Win()
    const child = new Win(main)
    minimizeWithParent(child, 'win32')
    child.minimize()
    expect(child.calls).toEqual(['minimize', 'restore'])
    expect(main.calls).toEqual(['minimize'])
  })

  it('父窗口已经最小化：不去还原子窗口', () => {
    const main = new Win()
    main.minimized = true
    const child = new Win(main)
    minimizeWithParent(child, 'win32')
    child.minimize()
    expect(child.calls).toEqual(['minimize'])
    expect(main.calls).toEqual([])
  })

  it('不置顶（没有父窗口）或不是 Windows 时照常最小化', () => {
    const win = new Win()
    minimizeWithParent(win, 'win32')
    win.minimize()
    expect(win.calls).toEqual(['minimize'])
    const main = new Win()
    const child = new Win(main)
    minimizeWithParent(child, 'darwin')
    child.minimize()
    expect(child.calls).toEqual(['minimize'])
    expect(main.calls).toEqual([])
  })
})
