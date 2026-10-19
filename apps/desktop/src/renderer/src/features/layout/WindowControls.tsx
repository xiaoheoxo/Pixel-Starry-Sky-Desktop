import { tr } from '../../i18n/core'
import { useEffect, useRef, useState } from 'react'
import type { WindowSnapLayout, WindowState } from '../../../../shared/types/window'
import { useI18n } from '@/i18n/I18nProvider'
import { notifyOverlayChange } from '@/ui/overlayEvents'

interface SnapSpec {
  id: WindowSnapLayout
  label: string
  zones: Array<{ x: number; y: number; width: number; height: number }>
}

const SNAP_LAYOUTS: SnapSpec[] = [
  {
    id: 'columns-2',
    get label() {
      return tr('nav.WindowControls.twoColumns')
    },
    zones: [
      { x: 0, y: 0, width: 6, height: 4 },
      { x: 6, y: 0, width: 6, height: 4 },
    ],
  },
  {
    id: 'columns-3',
    get label() {
      return tr('nav.WindowControls.threeColumns')
    },
    zones: [
      { x: 0, y: 0, width: 4, height: 4 },
      { x: 4, y: 0, width: 4, height: 4 },
      { x: 8, y: 0, width: 4, height: 4 },
    ],
  },
  {
    id: 'large-left',
    get label() {
      return tr('nav.WindowControls.largeLeftTwoRight')
    },
    zones: [
      { x: 0, y: 0, width: 8, height: 4 },
      { x: 8, y: 0, width: 4, height: 2 },
      { x: 8, y: 2, width: 4, height: 2 },
    ],
  },
  {
    id: 'large-right',
    get label() {
      return tr('nav.WindowControls.twoLeftLargeRight')
    },
    zones: [
      { x: 0, y: 0, width: 4, height: 2 },
      { x: 0, y: 2, width: 4, height: 2 },
      { x: 4, y: 0, width: 8, height: 4 },
    ],
  },
  {
    id: 'grid-4',
    get label() {
      return tr('nav.WindowControls.fourQuadrants')
    },
    zones: [
      { x: 0, y: 0, width: 6, height: 2 },
      { x: 6, y: 0, width: 6, height: 2 },
      { x: 0, y: 2, width: 6, height: 2 },
      { x: 6, y: 2, width: 6, height: 2 },
    ],
  },
  {
    id: 'wide-center',
    get label() {
      return tr('nav.WindowControls.wideCenter')
    },
    zones: [
      { x: 0, y: 0, width: 3, height: 4 },
      { x: 3, y: 0, width: 6, height: 4 },
      { x: 9, y: 0, width: 3, height: 4 },
    ],
  },
]

/** Windows 自绘窗口按钮，与顶栏和壁纸共用背景。 */
export function WindowControls() {
  const { text } = useI18n()
  const [state, setState] = useState<WindowState>({ maximized: false, focused: true, snapped: false })
  const [snapOpen, setSnapOpen] = useState(false)
  // 布局弹层渲染在原地（不在 body 下）：开关时让内置浏览器马上重新判断
  useEffect(notifyOverlayChange, [snapOpen])
  const [options, setOptions] = useState<Partial<Record<WindowSnapLayout, boolean[]>>>({})
  const [error, setError] = useState('')
  const timer = useRef<number | null>(null)
  const opening = useRef(0)
  const keyboardOpen = useRef(false)
  const container = useRef<HTMLDivElement>(null)
  const controls = window.pixelsky?.window
  const visible = window.pixelsky?.platform === 'win32' && !!controls

  useEffect(() => {
    if (!visible || !controls) return
    let active = true
    let changed = false
    const unsubscribe = controls.onState(next => {
      changed = true
      if (active) setState(next)
    })
    void controls
      .getState()
      .then(next => {
        if (active && !changed) setState(next)
      })
      .catch(console.error)
    return () => {
      active = false
      unsubscribe()
    }
  }, [controls, visible])

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
      opening.current++
    },
    [],
  )
  useEffect(() => {
    if (!snapOpen) return
    if (keyboardOpen.current) {
      keyboardOpen.current = false
      container.current?.querySelector<HTMLButtonElement>('.window-snap-cell:not(:disabled)')?.focus()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setSnapOpen(false)
        container.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus()
      }
    }
    const outside = (e: PointerEvent): void => {
      if (!container.current?.contains(e.target as Node)) setSnapOpen(false)
    }
    const close = (): void => setSnapOpen(false)
    document.addEventListener('keydown', key, true)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('keydown', key, true)
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [snapOpen])

  if (!visible) return null
  const run = (action: () => Promise<void>): void => {
    void action().catch(console.error)
  }
  const clearTimer = (): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }
  const scheduleClose = (): void => {
    opening.current++
    clearTimer()
    timer.current = window.setTimeout(() => setSnapOpen(false), 160)
  }
  const scheduleOpen = (): void => {
    clearTimer()
    const request = ++opening.current
    timer.current = window.setTimeout(() => {
      void controls
        .snapOptions()
        .then(next => {
          if (opening.current === request) {
            setOptions(next)
            setError('')
            setSnapOpen(true)
          }
        })
        .catch(console.error)
    }, 240)
  }
  const chooseSnap = (layout: SnapSpec, zone: number): void => {
    clearTimer()
    setSnapOpen(false)
    void controls.snap(layout.id, zone).catch(e => {
      setError((e as Error).message)
      setSnapOpen(true)
    })
  }
  const maximizeLabel = state.maximized ? text('还原') : text('最大化')
  return (
    <div
      ref={container}
      data-window-controls
      data-focused={state.focused}
      data-maximized={state.maximized}
      role="group"
      aria-label={text('窗口操作')}
      className="window-controls no-drag fixed right-0 top-0 z-[100] flex h-12"
    >
      <button
        type="button"
        className="window-control"
        aria-label={text('最小化')}
        title={text('最小化')}
        onClick={() => run(controls.minimize)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M3 8h10" />
        </svg>
      </button>
      <button
        type="button"
        className="window-control"
        aria-label={maximizeLabel}
        title={maximizeLabel}
        aria-haspopup="menu"
        aria-expanded={snapOpen}
        onPointerEnter={scheduleOpen}
        onPointerLeave={scheduleClose}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            keyboardOpen.current = true
            scheduleOpen()
          }
        }}
        onClick={() => {
          clearTimer()
          opening.current++
          setSnapOpen(false)
          run(controls.toggleMaximize)
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {state.maximized ? (
            <>
              <path d="M5 3h8v8" />
              <rect x="2.5" y="5" width="8" height="8" rx=".5" />
            </>
          ) : (
            <rect x="3" y="3" width="10" height="10" rx=".5" />
          )}
        </svg>
      </button>
      <button
        type="button"
        className="window-control window-control-close"
        aria-label={text('关闭窗口')}
        title={text('关闭窗口')}
        onClick={() => run(controls.close)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="m3 3 10 10m0-10L3 13" />
        </svg>
      </button>
      {snapOpen && (
        <div
          className="window-snap-popover no-drag"
          role="menu"
          aria-label={text('Windows 11 窗口布局')}
          onPointerEnter={() => {
            clearTimer()
            opening.current++
          }}
          onPointerLeave={scheduleClose}
          onBlur={e => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) scheduleClose()
          }}
        >
          <div className="window-snap-grid">
            {SNAP_LAYOUTS.map(layout => (
              <div key={layout.id} className="window-snap-option" role="group" aria-label={text(layout.label)}>
                <div className="window-snap-preview">
                  {layout.zones.map((zone, index) => (
                    <button
                      key={index}
                      type="button"
                      className="window-snap-cell"
                      aria-label={`${text(layout.label)} ${text('区域')} ${index + 1}`}
                      role="menuitem"
                      disabled={options[layout.id]?.[index] !== true}
                      title={
                        options[layout.id]?.[index]
                          ? `${text(layout.label)} ${text('区域')} ${index + 1}`
                          : text('当前显示器空间不足')
                      }
                      style={{
                        gridColumn: `${zone.x + 1} / span ${zone.width}`,
                        gridRow: `${zone.y + 1} / span ${zone.height}`,
                      }}
                      onClick={e => {
                        e.stopPropagation()
                        chooseSnap(layout, index)
                      }}
                    />
                  ))}
                </div>
                <span className="window-snap-label">{text(layout.label)}</span>
              </div>
            ))}
          </div>
          {state.snapped && (
            <button
              type="button"
              role="menuitem"
              className="mt-2 w-full rounded-md px-2 py-1 text-meta text-fg-secondary hover:bg-hover"
              onClick={() => {
                setSnapOpen(false)
                run(controls.restoreSnap)
              }}
            >
              {text('恢复原窗口大小和位置')}
            </button>
          )}
          {error && (
            <p role="status" className="mt-2 text-meta text-danger">
              {text(error)}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
