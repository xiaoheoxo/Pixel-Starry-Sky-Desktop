// 记住主窗口的位置和大小（纯函数部分）：存的坐标要对着「现在」的显示器校验，
// 拔掉了外接屏、换了分辨率之后，窗口不能跑到看不见的地方。
// 全部用整数运算，和 DPI 缩放无关（Electron 的 bounds 本来就是 DIP）。

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 写进 window.json 的 windowState 字段 */
export interface SavedWindowState extends Rect {
  /** 关闭时是不是最大化；位置和大小存的是还原后的（normal）那份 */
  maximized: boolean
}

/** 窗口露出来的部分小于这个尺寸，就当它已经不在任何屏幕上了 */
export const MIN_VISIBLE = { width: 160, height: 80 } as const

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** 从 window.json 里读出 windowState；缺失、字段不对、尺寸不是正数都返回 null */
export function parseSavedWindowState(value: unknown): SavedWindowState | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (!isInt(v.x) || !isInt(v.y) || !isInt(v.width) || !isInt(v.height)) return null
  const width = Math.round(v.width)
  const height = Math.round(v.height)
  if (width <= 0 || height <= 0) return null
  return { x: Math.round(v.x), y: Math.round(v.y), width, height, maximized: v.maximized === true }
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return { width: Math.max(0, width), height: Math.max(0, height) }
}

function clampInto(rect: Rect, area: Rect, min: { width: number; height: number }): Rect {
  // 最小尺寸不能超过这块屏幕本身
  const width = Math.min(area.width, Math.max(rect.width, Math.min(min.width, area.width)))
  const height = Math.min(area.height, Math.max(rect.height, Math.min(min.height, area.height)))
  const x = Math.min(Math.max(rect.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(rect.y, area.y), area.y + area.height - height)
  return { x, y, width, height }
}

/**
 * 校验存下来的窗口位置。
 * - saved 为空（没存过 / 文件坏了）：默认尺寸，居中在主屏
 * - 和某块屏幕工作区的交集最大的那块作为目标；露出的部分小于 160×80：回到默认
 * - 否则尺寸收进工作区，位置挪到完全在工作区内
 * displays 是各屏幕的 workArea（可以有负坐标，比如放在主屏左边的显示器）；primary 是主屏的 workArea。
 */
export function sanitizeWindowBounds(
  saved: Rect | null,
  displays: Rect[],
  primary: Rect,
  defaults: { width: number; height: number },
  min: { width: number; height: number } = { width: 0, height: 0 },
): Rect {
  const fallback = (): Rect => {
    const size = clampInto({ x: 0, y: 0, ...defaults }, primary, min)
    return {
      ...size,
      x: primary.x + Math.floor((primary.width - size.width) / 2),
      y: primary.y + Math.floor((primary.height - size.height) / 2),
    }
  }
  if (!saved || !displays.length) return fallback()
  let best: Rect | null = null
  let bestArea = 0
  for (const d of displays) {
    const o = overlap(saved, d)
    const area = o.width * o.height
    if (area > bestArea) {
      best = d
      bestArea = area
    }
  }
  if (!best) return fallback()
  const o = overlap(saved, best)
  // 窗口本身比阈值小时，以窗口自身尺寸为准（完全可见即可）
  if (o.width < Math.min(MIN_VISIBLE.width, saved.width) || o.height < Math.min(MIN_VISIBLE.height, saved.height))
    return fallback()
  return clampInto(saved, best, min)
}
