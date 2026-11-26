// 挂在主窗口下面的子窗口（parent：置顶的设置窗口、付款窗口）的最小化。
// Windows 上子窗口在任务栏里没有自己的位置，单独最小化会缩成屏幕左下角一条 160×28 的白条，
// 主窗口最小化再还原才回来。改成：子窗口要最小化时，把父窗口（整个软件）一起最小化，恢复时一起回来。
// 只在 Windows 上这样做：macOS、Linux 上子窗口能正常最小化到程序坞 / 任务栏。

/** 用到的窗口方法（测试里换成假的） */
export interface OwnedWindow {
  getParentWindow(): OwnedWindow | null
  isDestroyed(): boolean
  isMinimized(): boolean
  minimize(): void
  restore(): void
  on(event: 'minimize', fn: () => void): unknown
}

/** Windows 上还在的父窗口；别的系统、没有父窗口返回 null */
function liveParent(win: OwnedWindow, platform: NodeJS.Platform): OwnedWindow | null {
  if (platform !== 'win32') return null
  const parent = win.getParentWindow()
  return parent && !parent.isDestroyed() ? parent : null
}

/** 窗口按钮的「最小化」最小化谁：Windows 上有父窗口就是父窗口，否则是自己 */
export function minimizeTarget<W extends OwnedWindow>(win: W, platform: NodeJS.Platform = process.platform): W {
  return (liveParent(win, platform) as W | null) ?? win
}

/** 键盘（Win+↓）、系统菜单这些绕过窗口按钮的最小化：子窗口还原，改成最小化父窗口 */
export function minimizeWithParent(win: OwnedWindow, platform: NodeJS.Platform = process.platform): void {
  win.on('minimize', () => {
    if (win.isDestroyed()) return
    const parent = liveParent(win, platform)
    // 父窗口已经最小化了（整个软件一起收起来的）：不去动子窗口，免得它自己弹出来
    if (!parent || parent.isMinimized()) return
    win.restore()
    parent.minimize()
  })
}
