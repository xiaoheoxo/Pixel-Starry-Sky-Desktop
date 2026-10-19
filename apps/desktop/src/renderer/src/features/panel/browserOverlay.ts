/** 盖在原生网页视图上的弹出层：只有会挡到网页视图的才需要把视图藏起来 */
export interface OverlayBox {
  x: number
  y: number
  width: number
  height: number
}

export interface OverlayCandidate {
  rect: OverlayBox
  /** 设置对话框、aria-modal 对话框、全屏遮罩：不管位置，一律藏 */
  modal: boolean
}

/** 弹出层和占位框重叠时留的余量（像素） */
export const OVERLAY_MARGIN = 4

function overlaps(a: OverlayBox, b: OverlayBox, margin: number) {
  return (
    a.x < b.x + b.width + margin &&
    a.x + a.width > b.x - margin &&
    a.y < b.y + b.height + margin &&
    a.y + a.height > b.y - margin
  )
}

/** 任意一个模态弹出层，或和占位框重叠的非模态弹出层，就要藏起网页视图；宽或高为 0 的不算 */
export function overlayHidesBrowser(
  placeholder: OverlayBox,
  candidates: readonly OverlayCandidate[],
  margin = OVERLAY_MARGIN,
): boolean {
  return candidates.some(c => {
    if (c.rect.width <= 0 || c.rect.height <= 0) return false
    return c.modal || overlaps(placeholder, c.rect, margin)
  })
}

/**
 * 浮层：对话框、菜单、下拉、提示，所有 Popover（自带 data-popover）、没用 Popover 的自定义浮层（data-floating），
 * Toast（role=status，只算 fixed / absolute 的，正文里的状态文字不算）
 */
const SELECTOR =
  '[role="dialog"],[role="menu"],[role="listbox"],[role="tooltip"],[role="status"],[data-settings-dialog],[data-popover],[data-floating]'

/** 浮层的一层祖先：铺满窗口、底色不透明的才算真遮罩（命令中心那种透明的点击层不算） */
export interface BackdropInfo {
  fixed: boolean
  fullScreen: boolean
  /** 背景色的不透明度 0–1 */
  alpha: number
}

/**
 * 模态：设置对话框、接近全屏的浮层，或者外面套着一层有颜色的全屏遮罩（确认框、设置浮层）。
 * aria-modal 不算数：命令中心这种小框也标了，但遮罩是透明的，不挡网页就不用藏
 */
export function isModalOverlay(info: { settings: boolean; fullScreen: boolean; backdrops: readonly BackdropInfo[] }) {
  return info.settings || info.fullScreen || info.backdrops.some(b => b.fixed && b.fullScreen && b.alpha > 0.02)
}

/** CSS 颜色的不透明度；认不出按不透明 */
export function colorAlpha(color: string): number {
  if (!color || color === 'transparent') return 0
  // color(srgb r g b / a)、oklab(… / a)、rgb(r g b / a)：斜杠后面是不透明度
  const slash = /\/\s*([\d.]+%?)\s*\)\s*$/.exec(color)
  // rgba(r, g, b, a)
  const comma = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+%?)\s*\)$/.exec(color)
  const a = (slash ?? comma)?.[1]
  if (a === undefined) return 1
  return a.endsWith('%') ? Number.parseFloat(a) / 100 : Number.parseFloat(a)
}

const coversWindow = (r: DOMRect) => r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9

/**
 * 占位框这一点上最上面的「看得见的」元素是不是占位框自己（或里面的）。跳过透明的全屏点击层：
 * 命令中心这类小框外面套着 fixed inset-0、没有底色的一层，只用来点外面关掉，不挡网页
 */
export function pointShowsPlaceholder(placeholder: Element, x: number, y: number): boolean {
  for (const el of document.elementsFromPoint(x, y)) {
    if (placeholder.contains(el)) return true
    const s = getComputedStyle(el)
    const clickLayer =
      s.position === 'fixed' &&
      coversWindow(el.getBoundingClientRect()) &&
      colorAlpha(s.backgroundColor) <= 0.02 &&
      s.backgroundImage === 'none' &&
      s.backdropFilter === 'none'
    if (!clickLayer) return false
  }
  return false
}

/** 当前页面上看得见的弹出层（含是否模态）。不可见的（display:none、visibility:hidden、hidden、inert 收起的）不返回 */
export function collectOverlays(): { element: Element; candidate: OverlayCandidate }[] {
  const out: { element: Element; candidate: OverlayCandidate }[] = []
  for (const element of document.querySelectorAll(SELECTOR)) {
    if (element.closest('[hidden],[inert]')) continue
    // 浮层里面的菜单、状态文字：外层已经算过
    if (element.parentElement?.closest(SELECTOR)) continue
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    if (element.getAttribute('role') === 'status' && style.position !== 'fixed' && style.position !== 'absolute')
      continue
    const r = element.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const backdrops: BackdropInfo[] = []
    for (let up = element.parentElement, i = 0; up && up !== document.body && i < 3; up = up.parentElement, i++) {
      const s = getComputedStyle(up)
      backdrops.push({
        fixed: s.position === 'fixed',
        fullScreen: coversWindow(up.getBoundingClientRect()),
        alpha: colorAlpha(s.backgroundColor),
      })
    }
    const modal = isModalOverlay({
      settings: element.hasAttribute('data-settings-dialog'),
      fullScreen: coversWindow(r),
      backdrops,
    })
    out.push({ element, candidate: { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, modal } })
  }
  return out
}

export { OVERLAY_EVENT } from '@/ui/overlayEvents'
