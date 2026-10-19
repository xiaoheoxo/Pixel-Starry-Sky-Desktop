// 键盘弹出时的页面高度（docs/mobile-remote.md §17.2 第 9 项）。
// iPhone Safari 不认 meta 里的 interactive-widget=resizes-content：键盘弹出时页面高度（100dvh）不变，
// 键盘盖住下半截，输入框被挡。这里监听 visualViewport（键盘之外真正看得见的那一块），
// 把它的高度写到 <html> 的 --app-height，页面外层用它当高度（app.css 的 h-app，没写时退回 100dvh）。
// 安卓 Chrome 照旧：键盘弹出时页面本来就缩到可见区域，这时 visualViewport.height 就等于页面高度，写进去的是同一个值，不会缩两次。

/** visualViewport 里要用到的几项 */
export interface ViewportLike {
  height: number
  scale: number
  offsetTop: number
  addEventListener(type: 'resize' | 'scroll', listener: () => void): void
  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void
}

export interface ViewportHost {
  visualViewport?: ViewportLike | null
  scrollY: number
  scrollTo(x: number, y: number): void
  document: { documentElement: { style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'> } }
}

/** 页面该用的高度（像素）；null = 这时不该改（没有 visualViewport、用户双指放大了，放大时它的高度会变小，不是键盘） */
export function appHeight(vv: Pick<ViewportLike, 'height' | 'scale'> | null | undefined): number | null {
  if (!vv || !(vv.height > 0)) return null
  if (vv.scale > 1.01) return null
  return Math.round(vv.height)
}

/** 在 main.tsx 里、渲染 React 之前调用一次；返回取消监听的函数 */
export function startViewport(win: ViewportHost = window): () => void {
  const vv = win.visualViewport
  if (!vv) return () => {}
  const style = win.document.documentElement.style
  let last: number | null = null
  const sync = () => {
    const h = appHeight(vv)
    if (h === null) return
    if (h !== last) {
      last = h
      style.setProperty('--app-height', `${h}px`)
    }
    // iOS 聚焦输入框时会把整页往上推一截（visualViewport 的 offsetTop 变大、页面滚动了）：页面高度已经等于可见区域，推回原位
    if (win.scrollY !== 0 || vv.offsetTop > 0) win.scrollTo(0, 0)
  }
  vv.addEventListener('resize', sync)
  vv.addEventListener('scroll', sync)
  sync()
  return () => {
    vv.removeEventListener('resize', sync)
    vv.removeEventListener('scroll', sync)
    style.removeProperty('--app-height')
  }
}
