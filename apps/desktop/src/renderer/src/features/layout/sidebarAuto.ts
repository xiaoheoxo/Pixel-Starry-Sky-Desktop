/**
 * 窗口大小变化时侧栏该怎么办（docs/ui/desktop-parity.md）：
 * 右侧面板开着又放不下就收；之前是自动收起的、现在放得下就展开；用户自己收起的不动。
 */
export function sidebarOnResize(s: {
  open: boolean
  /** 现在收着，是因为放不下被自动收起的 */
  autoClosed: boolean
  panelOpen: boolean
  /** 侧栏展开后放得下 */
  fits: boolean
}): 'close' | 'open' | null {
  if (s.open) return s.panelOpen && !s.fits ? 'close' : null
  return s.autoClosed && s.fits ? 'open' : null
}
