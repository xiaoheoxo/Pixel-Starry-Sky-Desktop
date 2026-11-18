import { describe, expect, it } from 'vitest'
import { minimizeTarget, minimizeWithParent, type OwnedWindow } from './owned-window'

// 子窗口（置顶的设置窗口、付款窗口）单独最小化会缩成屏幕左下角的白条：改成最小化父窗口

class Win implements OwnedWindow {
  calls: string[] = []
  destroyed = false
  private handlers: Array<() => void> = []
  constructor(public parent: Win | null = null) {}
  getParentWindow = () => this.parent
  isDestroyed = () => this.destroyed
  minimize = () => {
    this.calls.push('minimize')
    for (const fn of this.handlers) fn()
  }
  restore = () => void this.calls.push('restore')
  on(_event: 'minimize', fn: () => void): void {
    this.handlers.push(fn)
  }
}

describe('owned-window', () => {
  it('窗口按钮：有父窗口最小化父窗口，没有就最小化自己', () => {
    const main = new Win()
    const child = new Win(main)
    expect(minimizeTarget(child)).toBe(main)
    expect(minimizeTarget(main)).toBe(main)
    main.destroyed = true
    expect(minimizeTarget(child)).toBe(child)
  })

  it('子窗口被最小化（Win+↓）：自己还原，父窗口最小化', () => {
    const main = new Win()
    const child = new Win(main)
    minimizeWithParent(child)
    child.minimize()
    expect(child.calls).toEqual(['minimize', 'restore'])
    expect(main.calls).toEqual(['minimize'])
  })

  it('不置顶（没有父窗口）时照常最小化', () => {
    const win = new Win()
    minimizeWithParent(win)
    win.minimize()
    expect(win.calls).toEqual(['minimize'])
  })
})
