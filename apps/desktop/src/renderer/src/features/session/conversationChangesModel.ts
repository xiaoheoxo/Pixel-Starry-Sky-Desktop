import type { Item } from '@pixelsky/protocol'
import type { ChangedFiles } from '@/data'
import { relativePath } from '@/features/coding/ai/turnChangesModel'
import { toChangedFiles } from '@/features/engine/labels'

/** Recorded edits for this conversation, not the net diff of the working tree. */
export function conversationChanges(items: readonly Item[], cwd: string | null): ChangedFiles | null {
  // The engine's cwd may be remote. Use its path syntax, not the local OS.
  const caseInsensitive = !!cwd && /^(?:[a-z]:[\\/]|\\\\)/i.test(cwd)
  const paths = new Map<string, string>()
  const changes = items.flatMap(item => {
    if (item.kind !== 'file_change' || item.status !== 'completed') return []
    return item.changes.map(change => {
      const path = relativePath(cwd ?? '', change.path, caseInsensitive)
      const key = caseInsensitive ? path.toLowerCase() : path
      const displayPath = paths.get(key) ?? path
      paths.set(key, displayPath)
      return { ...change, path: displayPath }
    })
  })
  return toChangedFiles(changes)
}
