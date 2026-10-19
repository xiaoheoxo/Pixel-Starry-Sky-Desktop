// 代码页里打开的图片（docs/ui/image-viewer.md §8）：在标签页里直接缩放、拖动，放大后按像素显示，
// 小图打开时自动放大到看得清。右下角悬浮工具条，底栏显示尺寸、鼠标下像素的坐标和颜色、当前比例
import { useRef, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { cn } from '@/ui/cn'
import { Popover, PopoverItem } from '@/ui/Popover'
import { ImageStageView, useImageStage } from '@/ui/ImageStage'
import { PixelToggles, sizeText } from '@/ui/ImageViewer'
import { nextBackground, setImagePrefs, useImagePrefs, type ImageBackground } from '@/ui/imagePrefs'
import { ZOOM_STEPS } from '@/ui/imageZoom'

/** 预览区比这个窄时工具条只显示图标 */
const COMPACT_WIDTH = 520

/** data:image/png;base64,… → PNG；svg+xml → SVG */
export function imageFormat(dataUrl: string): string {
  const mime = /^data:image\/([a-z0-9.+-]+)/i.exec(dataUrl)?.[1] ?? ''
  return mime
    .replace(/\+xml$/i, '')
    .replace(/^x-icon$|^vnd\.microsoft\.icon$/i, 'ico')
    .toUpperCase()
}

const BACKGROUND_LABEL = {
  checker: 'imageViewer.bgChecker',
  plain: 'imageViewer.bgPlain',
  inverse: 'imageViewer.bgInverse',
} as const satisfies Record<ImageBackground, string>

export function ImagePreview({ id, src, name, bytes }: { id: string; src: string; name: string; bytes: number }) {
  useI18n()
  const prefs = useImagePrefs()
  const stage = useImageStage({ inline: true, memoryKey: id })
  const [menu, setMenu] = useState(false)
  const zoomButton = useRef<HTMLButtonElement>(null)
  const vector = src.startsWith('data:image/svg')
  const { natural, view, hover, fitted } = stage
  const percent = `${Math.round(view.scale * 100)}%`
  const compact = stage.viewport.width > 0 && stage.viewport.width < COMPACT_WIDTH
  const tool =
    'inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-1.5 text-meta text-fg-secondary hover:bg-hover hover:text-fg'
  const zoomState = fitted ? tr(view.scale > 1 ? 'imageViewer.fittedUp' : 'imageViewer.fitted', { percent }) : percent

  return (
    <div
      data-image-preview=""
      tabIndex={0}
      className="flex min-h-0 flex-1 flex-col outline-none"
      onKeyDown={e => {
        // 缩放菜单开着时数字键选菜单项
        if (menu || e.ctrlKey || e.metaKey || e.altKey) return
        if (stage.onKey(e)) e.preventDefault()
      }}
    >
      <ImageStageView stage={stage} src={src} alt={name} vector={vector} background={prefs.background}>
        <div
          data-image-toolbar=""
          className="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-lg border border-line-card bg-popover p-1 shadow-md"
        >
          <button
            type="button"
            className={tool}
            title={tr('imageViewer.zoomOut')}
            aria-label={tr('imageViewer.zoomOut')}
            onClick={() => stage.step(-1)}
          >
            <Minus size={14} />
          </button>
          <button
            ref={zoomButton}
            type="button"
            data-image-zoom=""
            className={cn(tool, 'w-14 font-medium text-fg tabular-nums')}
            title={tr('imageViewer.zoomMenu')}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu(o => !o)}
          >
            {percent}
          </button>
          <Popover
            open={menu}
            onClose={() => setMenu(false)}
            anchor={zoomButton}
            side="top"
            align="end"
            role="menu"
            className="w-40"
          >
            {[...ZOOM_STEPS].reverse().map(s => (
              <PopoverItem
                key={s}
                role="menuitemradio"
                checked={!fitted && Math.abs(view.scale - s) < 1e-6}
                selected={!fitted && Math.abs(view.scale - s) < 1e-6}
                onClick={() => {
                  setMenu(false)
                  stage.zoomTo(s)
                }}
              >
                {Math.round(s * 100)}%
              </PopoverItem>
            ))}
            <div className="my-1 border-t border-line-layout" />
            <PopoverItem
              hint="0"
              selected={fitted}
              onClick={() => {
                setMenu(false)
                stage.fit()
              }}
            >
              {tr('imageViewer.fit')}
            </PopoverItem>
            <PopoverItem
              hint="1"
              onClick={() => {
                setMenu(false)
                stage.zoomTo(1)
              }}
            >
              {tr('imageViewer.actual')}
            </PopoverItem>
          </Popover>
          <button
            type="button"
            className={tool}
            title={tr('imageViewer.zoomIn')}
            aria-label={tr('imageViewer.zoomIn')}
            onClick={() => stage.step(1)}
          >
            <Plus size={14} />
          </button>
          <span className="mx-1 h-4 border-l border-line" />
          <button
            type="button"
            aria-pressed={fitted}
            className={cn(tool, fitted && 'bg-hover text-fg')}
            title={tr('imageViewer.fitTitle')}
            onClick={stage.fit}
          >
            {tr('imageViewer.fitShort')}
          </button>
          <button
            type="button"
            aria-pressed={!fitted && view.scale === 1}
            className={cn(tool, !fitted && view.scale === 1 && 'bg-hover text-fg')}
            title={tr('imageViewer.actualTitle')}
            onClick={() => stage.zoomTo(1)}
          >
            1:1
          </button>
          <span className="mx-1 h-4 border-l border-line" />
          {!vector && <PixelToggles tool={tool} pixelated={prefs.pixelated} grid={prefs.grid} compact={compact} />}
          <button
            type="button"
            data-image-background={prefs.background}
            className={tool}
            title={tr('imageViewer.background', { name: tr(BACKGROUND_LABEL[prefs.background]) })}
            aria-label={tr('imageViewer.background', { name: tr(BACKGROUND_LABEL[prefs.background]) })}
            onClick={() => setImagePrefs({ background: nextBackground(prefs.background) })}
          >
            <BackgroundIcon />
          </button>
        </div>
      </ImageStageView>
      <footer className="flex min-h-7 shrink-0 items-center gap-3 overflow-hidden border-t border-line-layout px-3 py-1 text-label whitespace-nowrap text-fg-muted">
        {natural && (
          <span className="text-fg-secondary">
            {natural.width} × {natural.height}
          </span>
        )}
        <span>
          {imageFormat(src)} · {sizeText(bytes)}
        </span>
        <span className="flex-1" />
        {hover && (
          <span data-image-cursor="" className="flex items-center gap-1.5 font-mono">
            <span>
              {hover.x}, {hover.y}
            </span>
            {hover.color !== undefined && (
              <>
                <span
                  className="inline-block size-2.5 rounded-[3px] shadow-[0_0_0_1px_var(--border-card)]"
                  style={{ background: hover.swatch }}
                />
                <span>{hover.color ?? tr('imageViewer.transparent')}</span>
              </>
            )}
          </span>
        )}
        <span data-image-zoom-state="">{zoomState}</span>
      </footer>
    </div>
  )
}

/** 方框里斜着一半：背景 */
function BackgroundIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <path d="M3.5 3.5h8.5v8.5H3.5zM12 12h8.5v8.5H12z" fill="currentColor" stroke="none" opacity={0.35} />
    </svg>
  )
}
