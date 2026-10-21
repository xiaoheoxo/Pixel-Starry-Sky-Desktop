// 设置 › 项目 › 导入的列表逻辑：分组计数、筛选、勾选，纯函数，测试直接覆盖
import type { ProjectImportCandidate, ProjectImportTool } from '../../../../../shared/types/project-import'

export type ImportBucket = 'addable' | 'added' | 'invalid'

/** 读取本机清单的工具，顺序就是来源卡片的顺序；name 和主进程写进 sources 的名字一致 */
export const IMPORT_TOOLS: ReadonlyArray<{ id: ProjectImportTool; name: string }> = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'zcode', name: 'Z Code' },
  { id: 'kimi', name: 'Kimi Code' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'dsh', name: 'DeepSeek Harness' },
]

const TOOL_NAMES = new Set(IMPORT_TOOLS.map(t => t.name))
export const isToolSource = (source: string): boolean => TOOL_NAMES.has(source)

/** 能加进侧栏的：没加过、路径没问题（上次加失败的也算，可以重试） */
export const isSelectable = (c: ProjectImportCandidate): boolean => !c.added && !c.issue

export const bucketOf = (c: ProjectImportCandidate): ImportBucket =>
  c.added ? 'added' : c.issue ? 'invalid' : 'addable'

/**
 * 来源卡片取消勾选后，只来自这些工具的候选不显示；手动选的文件夹、路径清单不受影响。
 * hidden 是取消勾选的工具名
 */
export const isVisible = (c: ProjectImportCandidate, hidden: ReadonlySet<string>): boolean =>
  c.sources.some(s => !isToolSource(s) || !hidden.has(s))

export function countBuckets(
  candidates: readonly ProjectImportCandidate[],
  hidden: ReadonlySet<string>,
): Record<ImportBucket, number> {
  const counts = { addable: 0, added: 0, invalid: 0 }
  for (const c of candidates) if (isVisible(c, hidden)) counts[bucketOf(c)]++
  return counts
}

/** 每个工具的卡片数字：一共读到几个、其中几个还能加 */
export function toolCounts(
  candidates: readonly ProjectImportCandidate[],
  tool: string,
): { total: number; addable: number } {
  const mine = candidates.filter(c => c.sources.includes(tool))
  return { total: mine.length, addable: mine.filter(isSelectable).length }
}

/** 当前筛选下要显示的行；搜索匹配名称、路径和来源 */
export function filterCandidates(
  candidates: readonly ProjectImportCandidate[],
  bucket: ImportBucket,
  query: string,
  hidden: ReadonlySet<string>,
): ProjectImportCandidate[] {
  const q = query.trim().toLowerCase()
  return candidates.filter(
    c =>
      isVisible(c, hidden) &&
      bucketOf(c) === bucket &&
      (!q || `${c.name}\n${c.path}\n${c.sources.join(' ')}`.toLowerCase().includes(q)),
  )
}

/** 表头勾选框的状态：只看当前显示的、能加的行 */
export function selectAllState(
  rows: readonly ProjectImportCandidate[],
  picked: ReadonlySet<string>,
): 'none' | 'some' | 'all' {
  const choices = rows.filter(isSelectable)
  const n = choices.filter(c => picked.has(c.path)).length
  return n === 0 ? 'none' : n === choices.length ? 'all' : 'some'
}

/** 新读到一批候选后的勾选：自动勾上新出现的、像项目的；用户取消过的不再勾回来，不能加的去掉 */
export function mergePicked(
  picked: ReadonlySet<string>,
  knownBefore: ReadonlySet<string>,
  incoming: readonly ProjectImportCandidate[],
): Set<string> {
  const next = new Set(picked)
  for (const c of incoming) {
    if (!isSelectable(c)) next.delete(c.path)
    else if (!knownBefore.has(c.path) && c.project) next.add(c.path)
  }
  return next
}
