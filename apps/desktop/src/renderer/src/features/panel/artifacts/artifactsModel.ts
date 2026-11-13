// 产物面板的纯函数（docs/ui/artifacts-panel.md）
import type { ArtifactFile, ArtifactTurn, FileChange } from '@pixelsky/protocol'

export interface SessionGroup {
  sessionId: string
  title: string
  engine: ArtifactTurn['engine']
  archived: boolean
  at: number
  turns: ArtifactTurn[]
}

/** 变更按会话分组：会话按最近一轮的时间倒序，组内各轮也倒序 */
export function groupBySession(turns: readonly ArtifactTurn[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>()
  for (const turn of turns) {
    const g = groups.get(turn.sessionId) ?? {
      sessionId: turn.sessionId,
      title: turn.title,
      engine: turn.engine,
      archived: turn.archived,
      at: turn.at,
      turns: [],
    }
    g.turns.push(turn)
    g.at = Math.max(g.at, turn.at)
    groups.set(turn.sessionId, g)
  }
  for (const g of groups.values()) g.turns.sort((a, b) => b.at - a.at)
  return [...groups.values()].sort((a, b) => b.at - a.at)
}

/** 文件大小：1.2 KB / 3.4 MB */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`
}

/**
 * 一个文件这一轮的所有 diff：changes 是 file.itemIds 各条改动记录里的改动（按先后，取不到的为 null）。
 * 同一条记录里同一个文件也可能出现几次，全都要；路径可能是相对的也可能是绝对的，两种都认
 */
export function artifactDiffs(
  file: Pick<ArtifactFile, 'path' | 'absolute'>,
  changes: ReadonlyArray<readonly FileChange[] | null>,
  caseInsensitive: boolean,
): string[] {
  const norm = (p: string): string => {
    const s = p.replace(/\\/g, '/')
    return caseInsensitive ? s.toLowerCase() : s
  }
  const want = new Set([norm(file.path), norm(file.absolute)])
  return changes.flatMap(list => (list ?? []).filter(c => c.diff && want.has(norm(c.path))).map(c => c.diff))
}

/** 路径拆成文件名和目录（兼容 Windows 分隔符） */
export function splitArtifactPath(path: string): { name: string; dir: string } {
  const normal = path.replace(/\\/g, '/')
  const i = normal.lastIndexOf('/')
  return i < 0 ? { name: normal, dir: '' } : { name: normal.slice(i + 1), dir: normal.slice(0, i) }
}

let lastRequest = 0
/** 产物扫描的请求编号：主进程每个窗口只留一个扫描、编号小的算旧的，产物页和概况的「产出」要共用一个计数 */
export const nextArtifactsRequest = (): number => ++lastRequest
