// 挂在主窗口下面的子窗口（parent：置顶的设置窗口、付款窗口）的最小化。
// Windows 上子窗口在任务栏里没有自己的位置，单独最小化会缩成屏幕左下角一条 160×28 的白条，
// 主窗口最小化再还原才回来。改成：子窗口要最小化时，把父窗口（整个软件）一起最小化，恢复时一起回来。

/** 用到的窗口方法（测试里换成假的） */
export interface OwnedWindow {
  getParentWindow(): OwnedWindow | null
  isDestroyed(): boolean
  minimize(): void
  restore(): void
  on(event: 'minimize', fn: () => void): unknown
}

/** 有父窗口就返回父窗口，否则返回自己：窗口按钮的「最小化」最小化它 */
export function minimizeTarget<W extends OwnedWindow>(win: W): W {
  const parent = win.getParentWindow()
  return parent && !parent.isDestroyed() ? (parent as W) : win
}

/** 键盘（Win+↓）、系统菜单这些绕过窗口按钮的最小化：子窗口还原，改成最小化父窗口 */
export function minimizeWithParent(win: OwnedWindow): void {
  win.on('minimize', () => {
    if (win.isDestroyed()) return
    const parent = win.getParentWindow()
    if (!parent || parent.isDestroyed()) return
    win.restore()
    parent.minimize()
  })
}
