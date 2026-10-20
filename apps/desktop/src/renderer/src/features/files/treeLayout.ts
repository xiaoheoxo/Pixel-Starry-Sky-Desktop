// 文件树的缩进和展开记忆（docs/ui/file-tree-fixes-mockup.html）
import { refKey } from './treeDrag'
import type { WorkspaceRef } from '../../../../shared/types/workspace'

/** 一行的左边距：每层 12px，最多缩 20 层 */
export const rowIndent = (depth: number): number => 10 + Math.min(depth, 20) * 12

/** 文件夹里的提示（空文件夹、加载中、读不到、只显示前若干项）：和这一层子项的图标同一列（箭头 12 + 间距 6） */
export const noteIndent = (depth: number): number => rowIndent(depth) + 18

/** 一行自己的报错：和这一行的文件名同一列（箭头 12 + 6 + 图标 14 + 6） */
export const nameIndent = (depth: number): number => rowIndent(depth) + 38

/**
 * 文件夹展开没展开（「项目 key + 换行 + 路径」）：刷新、切走再回来让行重新挂载时照样展开。
 * 只记用户动过的；没记过的按「全部展开」和定位请求决定
 */
const expandedDirs = new Map<string, boolean>()
const MAX_REMEMBERED = 2000

const dirKey = (ref: WorkspaceRef, path: string): string => refKey(ref) + '\n' + path

export function rememberedExpanded(ref: WorkspaceRef, path: string): boolean | undefined {
  return expandedDirs.get(dirKey(ref, path))
}

export function rememberExpanded(ref: WorkspaceRef, path: string, expanded: boolean): void {
  const key = dirKey(ref, path)
  expandedDirs.delete(key)
  expandedDirs.set(key, expanded)
  // 最早记的先丢
  if (expandedDirs.size > MAX_REMEMBERED) expandedDirs.delete(expandedDirs.keys().next().value!)
}

/** 测试用 */
export function forgetExpanded(): void {
  expandedDirs.clear()
}
