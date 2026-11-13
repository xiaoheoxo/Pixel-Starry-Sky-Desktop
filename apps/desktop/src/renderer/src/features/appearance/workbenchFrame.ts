/** 工作区边框（docs/ui/minimal-mode.md §16）：两块独立 / 一条线，写 <html data-workbench-frame>，样式在 styles/globals.css */
export type WorkbenchFrame = 'block' | 'line'
export const WORKBENCH_FRAME_KEY = 'pixelsky.workbenchFrame'

export function readWorkbenchFrame(): WorkbenchFrame {
  try {
    return localStorage.getItem(WORKBENCH_FRAME_KEY) === 'line' ? 'line' : 'block'
  } catch {
    return 'block'
  }
}
