// 看图的缩放 / 平移计算（ui/ImageStage.tsx 用：看图浮层和代码页的图片预览，docs/ui/image-viewer.md §3、§8）。纯函数。
// 坐标都以视口中心为原点：图片画在 translate(x, y) scale(scale)，x / y 是图片中心相对视口中心的偏移。

export const MIN_SCALE = 0.1
export const MAX_SCALE = 32
/** + / - 、工具栏按钮、单击按这些档位跳；滚轮按比例连续缩放 */
export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32]
/** 放大到这个倍数起画像素网格 */
export const GRID_MIN_SCALE = 8

export interface Size {
  width: number
  height: number
}
export interface View {
  scale: number
  x: number
  y: number
}

export const clampScale = (scale: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))

/**
 * 适应窗口：放不下就等比缩小；小图放大到占视口约一半的最大整数倍（16×16 的材质不再只是一小点，
 * 整数倍不会让像素图变形），本来就合适的按原始大小
 */
export function fitScale(image: Size, viewport: Size): number {
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 1
  const contain = Math.min(viewport.width / image.width, viewport.height / image.height)
  if (contain < 1) return clampScale(contain)
  const half = Math.floor(Math.min(viewport.width / 2 / image.width, viewport.height / 2 / image.height))
  return clampScale(Math.max(1, half))
}

/** 下一档（dir 为 1 放大、-1 缩小）；已经在两头就停在两头 */
export function stepScale(current: number, dir: 1 | -1): number {
  const next =
    dir > 0 ? ZOOM_STEPS.find(v => v > current + 1e-6) : [...ZOOM_STEPS].reverse().find(v => v < current - 1e-6)
  return next ?? (dir > 0 ? MAX_SCALE : MIN_SCALE)
}

/** 视口里的点（相对视口中心）落在图上的哪个像素；在图外是 null */
export function pixelAt(view: View, point: { x: number; y: number }, image: Size): { x: number; y: number } | null {
  const x = Math.floor((point.x - view.x) / view.scale + image.width / 2)
  const y = Math.floor((point.y - view.y) / view.scale + image.height / 2)
  return x < 0 || y < 0 || x >= image.width || y >= image.height ? null : { x, y }
}

/** 平移限制：图比视口小的方向居中；大的方向不让边拖进视口里 */
export function clampPan(view: View, image: Size, viewport: Size): View {
  const limit = (offset: number, imageLength: number, viewportLength: number): number => {
    const room = (imageLength * view.scale - viewportLength) / 2
    return room <= 0 ? 0 : Math.min(room, Math.max(-room, offset))
  }
  return {
    scale: view.scale,
    x: limit(view.x, image.width, viewport.width),
    y: limit(view.y, image.height, viewport.height),
  }
}

/** 缩放到 next，鼠标所在的点（相对视口中心）在图上的位置不动 */
export function zoomAt(view: View, next: number, point: { x: number; y: number }, image: Size, viewport: Size): View {
  const scale = clampScale(next)
  const ratio = scale / view.scale
  return clampPan(
    { scale, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio },
    image,
    viewport,
  )
}

/** 适应窗口的视图（居中） */
export const fitView = (image: Size, viewport: Size): View => ({ scale: fitScale(image, viewport), x: 0, y: 0 })

/** 滚轮一格的缩放倍数：deltaY 向上为放大；触控板的小步长按比例缩小 */
export const wheelFactor = (deltaY: number): number => Math.exp(-Math.max(-100, Math.min(100, deltaY)) * 0.0025)
