import type { Item } from '@pixelsky/protocol'
import { isTurnUser, latestTurnChanges, type TurnChanges } from '@/features/coding/ai/turnChangesModel'

/** This transient control shows the current turn only, never the previously completed one. */
export function activeConversationChanges(
  items: readonly Item[],
  cwd: string | null,
  running: boolean,
): TurnChanges | null {
  if (!running) return null
  const turnStart = items.findLastIndex(isTurnUser)
  // Imported sessions may contain edits before the first user item.
  const turnItems = turnStart > 0 ? items.slice(turnStart) : items
  // Use the session's path syntax, not the renderer's OS (the workspace may be remote).
  const caseInsensitive = !!cwd && /^(?:[a-z]:[\\/]|\\\\)/i.test(cwd)
  const turn = latestTurnChanges(turnItems, true, cwd ?? '', caseInsensitive)
  return turn?.files.length ? turn : null
}
