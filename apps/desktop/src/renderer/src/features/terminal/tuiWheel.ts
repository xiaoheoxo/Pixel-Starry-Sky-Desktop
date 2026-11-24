// 全屏 TUI 滚轮距离补偿（docs/ui/terminal-batch1-tui-hardening.md）：
// 当 TUI 开启鼠标上报（mouseTrackingMode !== 'none'）时，xterm 原生处理会把单次像素滚轮压成 1 行报告；
// 这里通过官方 attachCustomWheelEventHandler 按行高把像素增量折算成等量 DOM_DELTA_LINE 事件补发。
import type { Terminal } from '@xterm/xterm'

const REPLAYED = Symbol('pixelsky.tuiWheelReplayed')
const MAX_STEPS_PER_EVENT = 12
const FALLBACK_CELL_HEIGHT = 18

export interface WheelCarryState {
  carryPx: number
  dir: -1 | 0 | 1
}

export function createWheelCarry(): WheelCarryState {
  return { carryPx: 0, dir: 0 }
}

/** 把一次 WheelEvent 增量折算成本次应派发给 TUI 的整数行数（并保留不足一行的像素余数供触控板平滑累积） */
export function consumeWheelSteps(
  state: WheelCarryState,
  deltaY: number,
  deltaMode: number,
  cellHeight: number,
  rows: number,
): { steps: number; dir: -1 | 0 | 1 } {
  if (!Number.isFinite(deltaY) || deltaY === 0) return { steps: 0, dir: 0 }
  const dir: -1 | 1 = deltaY > 0 ? 1 : -1
  if (state.dir !== 0 && state.dir !== dir) state.carryPx = 0
  state.dir = dir

  const linePx = cellHeight > 2 && Number.isFinite(cellHeight) ? cellHeight : FALLBACK_CELL_HEIGHT
  const px =
    deltaMode === 1
      ? Math.abs(deltaY) * linePx
      : deltaMode === 2
        ? Math.abs(deltaY) * Math.max(1, rows) * linePx
        : Math.abs(deltaY)

  const total = state.carryPx + px
  const rawSteps = Math.floor(total / linePx)
  if (rawSteps <= 0) {
    state.carryPx = total
    return { steps: 0, dir }
  }
  const steps = Math.min(MAX_STEPS_PER_EVENT, rawSteps)
  state.carryPx = Math.min(linePx * 0.99, total - rawSteps * linePx)
  return { steps, dir }
}

type MarkedWheelEvent = WheelEvent & { [REPLAYED]?: boolean }

function cloneSingleLineWheel(source: WheelEvent, dir: -1 | 1): WheelEvent {
  const copy = (
    typeof WheelEvent === 'function'
      ? new WheelEvent('wheel', {
          bubbles: false,
          cancelable: source.cancelable,
          composed: source.composed,
          view: source.view,
          clientX: source.clientX,
          clientY: source.clientY,
          screenX: source.screenX,
          screenY: source.screenY,
          button: source.button,
          buttons: source.buttons,
          deltaMode: 1,
          deltaX: 0,
          deltaY: dir,
          deltaZ: 0,
        })
      : Object.assign(new Event('wheel', { bubbles: false, cancelable: source.cancelable }), {
          clientX: source.clientX,
          clientY: source.clientY,
          deltaMode: 1,
          deltaX: 0,
          deltaY: dir,
          deltaZ: 0,
        })
  ) as MarkedWheelEvent
  copy[REPLAYED] = true
  return copy
}

export function attachTuiWheel(
  term: Pick<Terminal, 'attachCustomWheelEventHandler' | 'element' | 'rows' | 'modes'>,
  getCellHeight: () => number,
): void {
  const carry = createWheelCarry()
  term.attachCustomWheelEventHandler(event => {
    if ((event as MarkedWheelEvent)[REPLAYED]) return true
    // Shift 绕过鼠标上报、Ctrl/Meta 缩放等组合键全部放行给原生或上层处理
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return true
    if (!term.modes || term.modes.mouseTrackingMode === 'none') {
      carry.carryPx = 0
      carry.dir = 0
      return true
    }
    if (event.deltaY === 0 && event.deltaX !== 0) return true

    const { steps, dir } = consumeWheelSteps(carry, event.deltaY, event.deltaMode, getCellHeight(), term.rows)
    event.preventDefault()
    if (steps > 0 && dir !== 0) {
      // xterm 在 term.element 上直接监听 wheel：不冒泡直投 term.element，避免合成事件向外层滚动容器泄露
      const target = term.element ?? (event.target as EventTarget | null)
      if (target) {
        for (let i = 0; i < steps; i++) target.dispatchEvent(cloneSingleLineWheel(event, dir))
      }
    }
    return false
  })
}
