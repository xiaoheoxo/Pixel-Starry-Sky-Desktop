// 全局搜索的「项目文件」（docs/ui/files-search-terminal-pins.md §2）：文件名用 files.search，内容用 files.grep。
// 「全部」范围只取前几条，「项目文件」范围取全部。
import type { WorkspaceRef } from '../../../../shared/types/workspace'
import { NO_OPTIONS, searchRegExp, type SearchOptions } from './replaceModel'

export interface FileHit {
  key: string
  ref: WorkspaceRef
  path: string
  /** 内容命中的行列；文件名命中为 null */
  line: number | null
  column: number | null
  /** 内容命中这一行的文字 */
  text: string
}

export interface FileHits {
  hits: FileHit[]
  truncated: boolean
  /** 只看内容命中有没有截断（左栏内容范围的「只显示了前 N 处」） */
  linesTruncated?: boolean
}

const LIMITS = {
  brief: { names: 3, lines: 5 },
  full: { names: 30, lines: 200 },
} as const

export type FileSearchMode = keyof typeof LIMITS

export function mergeFileHits(
  ref: WorkspaceRef,
  names: string[],
  lines: Array<{ path: string; line: number; column: number; text: string }>,
  mode: FileSearchMode,
  truncated: boolean,
): FileHits {
  const limit = LIMITS[mode]
  return {
    hits: [
      ...names
        .slice(0, limit.names)
        .map(path => ({ key: 'name:' + path, ref, path, line: null, column: null, text: '' })),
      ...lines.slice(0, limit.lines).map(m => ({
        key: `line:${m.path}:${m.line}:${m.column}`,
        ref,
        path: m.path,
        line: m.line,
        column: m.column,
        text: m.text,
      })),
    ],
    truncated: truncated || names.length > limit.names || lines.length > limit.lines,
  }
}

/** options 只管内容搜索；全是默认时照旧发字符串，没升级的远端辅助进程也能搜 */
export async function searchFiles(
  ref: WorkspaceRef,
  text: string,
  mode: FileSearchMode,
  options: SearchOptions = NO_OPTIONS,
): Promise<FileHits> {
  const files = window.pixelsky!.files
  const plain = !options.caseSensitive && !options.wholeWord && !options.regex
  const [names, content] = await Promise.all([
    files.search(ref, text),
    files.grep(ref, plain ? text : { text, ...options }),
  ])
  return {
    ...mergeFileHits(
      ref,
      names.entries.filter(e => e.kind === 'file').map(e => e.path),
      content.matches,
      mode,
      names.truncated || content.truncated,
    ),
    linesTruncated: content.truncated || content.matches.length > LIMITS[mode].lines,
  }
}

/** 演示模式：在演示文件内容里找 */
export function demoFileHits(
  ref: WorkspaceRef,
  contents: Record<string, string>,
  text: string,
  mode: FileSearchMode,
  options: SearchOptions = NO_OPTIONS,
): FileHits {
  const needle = text.toLocaleLowerCase()
  const re = searchRegExp(text, options)
  const names = Object.keys(contents).filter(p => (p.split('/').pop() ?? p).toLocaleLowerCase().includes(needle))
  const lines = Object.entries(contents).flatMap(([path, body]) =>
    body.split(/\r?\n/).flatMap((line, i) => {
      re.lastIndex = 0
      const found = re.exec(line)
      return found ? [{ path, line: i + 1, column: found.index + 1, text: line }] : []
    }),
  )
  return mergeFileHits(ref, names, lines, mode, false)
}
