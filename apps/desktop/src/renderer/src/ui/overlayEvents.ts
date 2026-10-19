// 浮层开关的通知（docs/ui/browser-overlay-settings-window.md §A.2）：右栏的内置浏览器是盖在界面上面的原生视图，
// 浮层出现 / 消失要马上重新判断它该不该藏。挂在 body 下的（Popover、对话框）不用调，body 的子节点变化已经会触发；
// 渲染在原地的（Toast、窗口布局弹层）开关时调一下
export const OVERLAY_EVENT = 'pixelsky:overlay'

export function notifyOverlayChange(): void {
  window.dispatchEvent(new Event(OVERLAY_EVENT))
}
