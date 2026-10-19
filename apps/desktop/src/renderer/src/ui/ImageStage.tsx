// 看图的画布（docs/ui/image-viewer.md §8）：缩放、平移、放大时按像素显示、像素网格、鼠标下像素的坐标和颜色。
// 看图浮层（ImageViewer）和代码页的图片预览（features/editor/ImagePreview）共用；工具栏、底栏各自画。
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from './cn'
import { useImagePrefs, type ImageBackground } from './imagePrefs'
import {
  clampPan,
  fitScale,
  fitView,
  GRID_MIN_SCALE,
  pixelAt,
  stepScale,
  wheelFactor,
  zoomAt,
  type Size,
  type View,
} from './imageZoom'

/** 适应窗口时四周留的边 */
const MARGIN = 24
const room = (viewport: Size): Size => ({
  width: Math.max(1, viewport.width - MARGIN * 2),
  height: Math.max(1, viewport.height - MARGIN * 2),
})
/** 比这个像素数大的图不取颜色（要整张画进画布） */
const SAMPLE_LIMIT = 4096 * 4096
/** 放大到这个倍数起给鼠标下的像素画框 */
const HOVER_BOX_SCALE = 4
/** 单击放大要等这么久，看是不是双击 */
const CLICK_DELAY = 220

/** 切换标签再切回来时接着看：缩放、位置、是否适应窗口 */
export interface StageMemory {
  view: View
  fitted: boolean
  last: View | null
}
const memories = new Map<string, StageMemory>()
const MEMORY_LIMIT = 100
function remember(key: string, memory: StageMemory): void {
  memories.delete(key)
  memories.set(key, memory)
  if (memories.size > MEMORY_LIMIT) memories.delete(memories.keys().next().value!)
}

export interface HoverPixel {
  x: number
  y: number
  /** #RRGGBB；半透明是 rgba(…)；全透明是 null；取不到颜色（大图）是 undefined */
  color: string | null | undefined
  /** 画色块用的 CSS 颜色 */
  swatch: string
}

export function pixelColor(r: number, g: number, b: number, a: number): string | null {
  if (a === 0) return null
  if (a === 255)
    return (
      '#' +
      [r, g, b]
        .map(v => v.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()
    )
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`
}

export type ImageStage = ReturnType<typeof useImageStage>

/**
 * inline：代码页的预览（Ctrl + 滚轮缩放、滚轮平移，单击放大、Alt + 单击缩小）；
 * 否则是看图浮层（滚轮直接缩放，单击空白处由浮层自己处理）。两边都是拖动平移、双击在适应窗口和上次的缩放之间切换
 */
export function useImageStage({ inline, memoryKey }: { inline: boolean; memoryKey?: string }) {
  const saved = memoryKey ? memories.get(memoryKey) : undefined
  const ref = useRef<HTMLDivElement>(null)
  const [natural, setNatural] = useState<Size | null>(null)
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 })
  const [view, setView] = useState<View>(saved?.view ?? { scale: 1, x: 0, y: 0 })
  const [fitted, setFitted] = useState(saved?.fitted ?? true)
  const [dragging, setDragging] = useState(false)
  const [hover, setHover] = useState<HoverPixel | null>(null)
  const last = useRef<View | null>(saved?.last ?? null)
  /** 刚拖动过：松开时的 click 不算单击 */
  const moved = useRef(false)
  const latest = useRef({ view, natural, viewport, fitted })
  latest.current = { view, natural, viewport, fitted }

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setViewport({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // 图读进来、窗口变了：适应窗口时跟着重算，否则只限制平移
  useLayoutEffect(() => {
    if (!natural || !viewport.width) return
    if (fitted) setView(fitView(natural, room(viewport)))
    else setView(v => clampPan(v, natural, viewport))
  }, [natural, viewport.width, viewport.height])

  useEffect(() => {
    if (memoryKey) remember(memoryKey, { view, fitted, last: last.current })
  }, [memoryKey, view, fitted])

  /** 相对视口中心的坐标 */
  const pointOf = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const rect = ref.current!.getBoundingClientRect()
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 }
  }, [])

  /** scale 是新的倍数，或者按当前倍数算新倍数（连着滚几格时每格都在上一格的结果上算） */
  const zoomTo = useCallback((scale: number | ((current: number) => number), point = { x: 0, y: 0 }): void => {
    const { natural: n, viewport: vp } = latest.current
    if (!n) return
    setFitted(false)
    setView(v => zoomAt(v, typeof scale === 'function' ? scale(v.scale) : scale, point, n, vp))
  }, [])
  const step = useCallback(
    (dir: 1 | -1, point?: { x: number; y: number }) => zoomTo(current => stepScale(current, dir), point),
    [zoomTo],
  )
  const fit = useCallback((): void => {
    const { natural: n, viewport: vp, fitted: f, view: v } = latest.current
    if (!n) return
    if (!f) last.current = v
    setFitted(true)
    setView(fitView(n, room(vp)))
  }, [])
  /** 双击：适应窗口 ↔ 上一次的缩放（没有上一次就放大一档，放不下的图到 100%） */
  const toggle = useCallback(
    (point?: { x: number; y: number }): void => {
      const { natural: n, viewport: vp, fitted: f } = latest.current
      if (!n) return
      if (!f) return fit()
      if (last.current) {
        const back = last.current
        setFitted(false)
        setView(clampPan(back, n, vp))
        return
      }
      const fs = fitScale(n, room(vp))
      zoomTo(fs < 1 ? 1 : stepScale(fs, 1), point)
    },
    [fit, zoomTo],
  )

  /** 最后的鼠标位置（窗口坐标），离开画布时清空 */
  const pointer = useRef<{ x: number; y: number } | null>(null)
  /** 单击放大要等一下看是不是双击；这期间按了键、双击了就不再放大 */
  const clickTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(clickTimer.current), [])

  /** + - 0 1；处理了返回 true */
  const onKey = (e: { key: string }): boolean => {
    window.clearTimeout(clickTimer.current)
    if (e.key === '+' || e.key === '=') step(1)
    else if (e.key === '-' || e.key === '_') step(-1)
    else if (e.key === '0') fit()
    else if (e.key === '1') zoomTo(1)
    else return false
    return true
  }

  // 滚轮要 preventDefault，React 的 onWheel 是 passive 的
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const wheel = (e: WheelEvent): void => {
      e.preventDefault()
      pointer.current = { x: e.clientX, y: e.clientY }
      if (!inline || e.ctrlKey || e.metaKey) {
        zoomTo(current => current * wheelFactor(e.deltaY), pointOf(e.clientX, e.clientY))
        return
      }
      const { natural: n, viewport: vp } = latest.current
      if (!n) return
      const dx = e.shiftKey ? e.deltaY : e.deltaX,
        dy = e.shiftKey ? 0 : e.deltaY
      setView(v => clampPan({ ...v, x: v.x - dx, y: v.y - dy }, n, vp))
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [inline, zoomTo, pointOf])

  // 鼠标下的像素：整张图画进画布取颜色（第一次悬停时画）
  const sample = useRef<{ src: string; ctx: CanvasRenderingContext2D | null } | null>(null)
  const img = useRef<HTMLImageElement>(null)
  const readHover = useCallback(
    (clientX: number, clientY: number): void => {
      const { natural: n, view: v } = latest.current
      const el = img.current
      if (!n || !el) return
      pointer.current = { x: clientX, y: clientY }
      const px = pixelAt(v, pointOf(clientX, clientY), n)
      if (!px) return setHover(null)
      if (sample.current?.src !== el.currentSrc) {
        let ctx: CanvasRenderingContext2D | null = null
        if (n.width * n.height <= SAMPLE_LIMIT) {
          const canvas = document.createElement('canvas')
          canvas.width = n.width
          canvas.height = n.height
          ctx = canvas.getContext('2d', { willReadFrequently: true })
          ctx?.drawImage(el, 0, 0)
        }
        sample.current = { src: el.currentSrc, ctx }
      }
      let color: string | null | undefined,
        swatch = 'transparent'
      try {
        const d = sample.current.ctx?.getImageData(px.x, px.y, 1, 1).data
        if (d) {
          color = pixelColor(d[0], d[1], d[2], d[3])
          swatch = `rgba(${d[0]}, ${d[1]}, ${d[2]}, ${d[3] / 255})`
        }
      } catch {
        // 画布被跨域图片污染：只显示坐标
      }
      setHover(h => (h && h.x === px.x && h.y === px.y && h.color === color ? h : { ...px, color, swatch }))
    },
    [pointOf],
  )
  // 缩放、平移后鼠标没动，下面的像素也变了
  useLayoutEffect(() => {
    if (pointer.current) readHover(pointer.current.x, pointer.current.y)
  }, [view, readHover])

  /** 这个点（窗口坐标）在图片上 */
  const onImage = (clientX: number, clientY: number): boolean => {
    const { natural: n, view: v } = latest.current
    return !!n && !!pixelAt(v, pointOf(clientX, clientY), n)
  }

  const drag = useRef<{ id: number; x: number; y: number; start: View } | null>(null)
  const handlers = {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      moved.current = false
      drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, start: latest.current.view }
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      readHover(e.clientX, e.clientY)
      const d = drag.current
      const n = latest.current.natural
      if (!d || d.id !== e.pointerId || !n) return
      const dx = e.clientX - d.x,
        dy = e.clientY - d.y
      if (!moved.current && Math.hypot(dx, dy) < 3) return
      moved.current = true
      setDragging(true)
      setView(clampPan({ ...d.start, x: d.start.x + dx, y: d.start.y + dy }, n, latest.current.viewport))
    },
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
      if (drag.current?.id === e.pointerId) drag.current = null
      setDragging(false)
    },
    onPointerLeave: () => {
      pointer.current = null
      setHover(null)
    },
    onClick: (e: React.MouseEvent<HTMLDivElement>) => {
      if (!inline || moved.current || e.detail > 1) return
      const point = pointOf(e.clientX, e.clientY),
        dir = e.altKey ? -1 : 1
      window.clearTimeout(clickTimer.current)
      clickTimer.current = window.setTimeout(() => step(dir, point), CLICK_DELAY)
    },
    onDoubleClick: (e: React.MouseEvent<HTMLDivElement>) => {
      window.clearTimeout(clickTimer.current)
      if (!inline && !onImage(e.clientX, e.clientY)) return
      toggle(pointOf(e.clientX, e.clientY))
    },
  }

  return {
    ref,
    img,
    natural,
    setNatural,
    viewport,
    view,
    fitted,
    dragging,
    hover,
    moved,
    inline,
    handlers,
    zoomTo,
    step,
    fit,
    toggle,
    onKey,
    onImage,
  }
}

const BACKGROUNDS: Record<ImageBackground, React.CSSProperties> = {
  checker: {
    backgroundColor: 'var(--bg-surface)',
    backgroundImage:
      'conic-gradient(color-mix(in srgb, var(--ink) 7%, var(--bg-surface)) 25%, transparent 0 50%, color-mix(in srgb, var(--ink) 7%, var(--bg-surface)) 0 75%, transparent 0)',
    backgroundSize: '16px 16px',
  },
  plain: { backgroundColor: 'var(--bg-surface)' },
  inverse: { backgroundColor: 'color-mix(in srgb, var(--ink) 88%, var(--bg-surface))' },
}

/** 画布：图片、像素网格、鼠标下的像素框；children 叠在画布上面（工具条），不参与拖动和单击缩放 */
export function ImageStageView({
  stage,
  src,
  alt,
  vector = false,
  background,
  className,
  onClick,
  children,
}: {
  stage: ImageStage
  src: string
  alt: string
  /** SVG：放大时按矢量重画，不按像素显示、不画网格 */
  vector?: boolean
  /** 不传时透明（看图浮层） */
  background?: ImageBackground
  className?: string
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void
  children?: ReactNode
}) {
  const prefs = useImagePrefs()
  const { natural, viewport, view, hover, dragging, inline } = stage
  const width = natural ? natural.width * view.scale : 0,
    height = natural ? natural.height * view.scale : 0
  const left = Math.round(viewport.width / 2 + view.x - width / 2),
    top = Math.round(viewport.height / 2 + view.y - height / 2)
  const pixels = !vector && prefs.pixelated && view.scale > 1
  const grid = !vector && prefs.grid && view.scale >= GRID_MIN_SCALE
  const pannable = width > viewport.width + 0.5 || height > viewport.height + 0.5
  return (
    <div className={cn('relative flex min-h-0 flex-1 flex-col', className)}>
      <div
        ref={stage.ref}
        data-image-stage=""
        {...stage.handlers}
        onClick={e => {
          stage.handlers.onClick(e)
          onClick?.(e)
        }}
        style={background ? BACKGROUNDS[background] : undefined}
        className={cn(
          'relative min-h-0 flex-1 touch-none overflow-hidden select-none',
          dragging ? 'cursor-grabbing' : pannable || !inline ? 'cursor-grab' : 'cursor-zoom-in',
        )}
      >
        <img
          ref={stage.img}
          src={src}
          alt={alt}
          draggable={false}
          onLoad={e => stage.setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          className={cn('pointer-events-none absolute max-w-none', !natural && 'invisible')}
          style={natural ? { left, top, width, height, imageRendering: pixels ? 'pixelated' : undefined } : undefined}
        />
        {natural && (
          <div
            data-image-frame=""
            className="pointer-events-none absolute shadow-[0_0_0_1px_var(--border-card)]"
            style={{
              left,
              top,
              width,
              height,
              backgroundImage: grid
                ? 'linear-gradient(to right, color-mix(in srgb, var(--ink) 22%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in srgb, var(--ink) 22%, transparent) 1px, transparent 1px)'
                : undefined,
              backgroundSize: grid ? `${view.scale}px ${view.scale}px` : undefined,
            }}
          />
        )}
        {natural && hover && view.scale >= HOVER_BOX_SCALE && (
          <div
            data-image-hover=""
            className="pointer-events-none absolute shadow-[0_0_0_1.5px_var(--bg-surface),0_0_0_2.5px_var(--ink)]"
            style={{
              left: left + hover.x * view.scale,
              top: top + hover.y * view.scale,
              width: view.scale,
              height: view.scale,
            }}
          />
        )}
      </div>
      {children}
    </div>
  )
}
