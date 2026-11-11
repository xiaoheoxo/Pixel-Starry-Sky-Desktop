// 终端分屏（docs/ui/files-search-terminal-pins.md §4.1、terminal-toolbar-status.md §5）：最多两格，左右或上下
export interface TerminalSplit {
  /** 第一格的终端：左右分屏时在左，上下分屏时在上 */
  left: string
  /** 第二格：在右 / 在下 */
  right: string
  /** 第一格所占比例 */
  ratio: number
  dir: 'right' | 'down'
}

export const clampRatio = (ratio: number): number => Math.min(0.8, Math.max(0.2, ratio))

/** 存下来的分屏记录；旧记录没有 dir，按向右读 */
export function readSplit(v: unknown): TerminalSplit | null {
  const s = v as Partial<TerminalSplit> | null
  return s && typeof s.left === 'string' && typeof s.right === 'string' && s.left !== s.right
    ? {
        left: s.left,
        right: s.right,
        ratio: typeof s.ratio === 'number' ? clampRatio(s.ratio) : 0.5,
        dir: s.dir === 'down' ? 'down' : 'right',
      }
    : null
}

/**
 * 现在显示着的分屏：两格都在当前项目（工作目录）的终端列表里。切项目不清分屏，别的项目留下的、
 * 分屏时选了别的项目的终端拼出来的都不算。面板显示、Provider 判断、命令面板用同一个口径
 */
export function liveSplit(split: TerminalSplit | null, ids: readonly string[]): TerminalSplit | null {
  return split && ids.includes(split.left) && ids.includes(split.right) ? split : null
}

/** Alt+方向键把焦点移到哪一格：只认分屏方向上的两个键，其余返回 null（按键照常交给 Shell） */
export function splitMoveTarget(split: TerminalSplit | null, key: string): string | null {
  if (!split) return null
  const i = (split.dir === 'down' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']).indexOf(key)
  return i < 0 ? null : i ? split.right : split.left
}
