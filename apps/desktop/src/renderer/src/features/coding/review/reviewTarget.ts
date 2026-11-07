// 这个文件标签在「AI 这一轮改的」里对应哪一项、这一轮开始前的内容是什么
import { useMemo } from 'react'
import type { OpenFile } from '@/features/files/store'
import { useCodingSessionId } from '../workspace'
import { useTurnChanges } from '../ai/useTurnChanges'
import { relativePath, type TurnFile } from '../ai/turnChangesModel'
import { baselineFor } from './hunksModel'
import { OUTSIDE_PREFIX } from '@/features/files/extraFolderPaths'

const caseInsensitive = typeof window !== 'undefined' && window.pixelsky?.platform === 'win32'
const same = (a: string, b: string): boolean => (caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b)

export interface ReviewTarget {
  /** 这个文件这一轮有没有改过 */
  file: TurnFile | null
  scope: string | null
  /** 这一轮的版本（TurnChanges.revision）：整轮「全部保留」只对标记时的版本有效 */
  revision: string
  running: boolean
  baseline: string | null
}
const NONE: ReviewTarget = { file: null, scope: null, revision: '', running: false, baseline: null }

export function useReviewTarget(tab: OpenFile | null): ReviewTarget {
  const sessionId = useCodingSessionId()
  const turn = useTurnChanges(sessionId)
  const document = tab?.document ?? null
  // 项目外的文件标签是「::0/完整路径」，这一轮的改动记的是完整路径（docs/ui/outside-files.md）
  const tabPath = tab?.path.startsWith(OUTSIDE_PREFIX) ? tab.path.slice(OUTSIDE_PREFIX.length) : tab?.path
  const path = tab && tabPath !== undefined ? relativePath(tab.root, tabPath, caseInsensitive) : null
  const head = tab?.head ?? null
  const content = document?.kind === 'text' ? document.content : null
  const version = document?.kind === 'text' ? document.version : ''
  const readonly = document?.kind === 'text' && !!document.readonly
  return useMemo(() => {
    if (!sessionId || !turn || path === null) return NONE
    const file = turn.files.find(f => same(f.path, path)) ?? null
    if (!file) return NONE
    const scope = `${sessionId}:${turn.turnKey}:${file.path}`
    const base = { file, scope, revision: turn.revision, running: turn.running }
    if (content === null || readonly) return { ...base, baseline: null }
    // 新文件：HEAD 里没有（演示模式下 HEAD 是空串）
    const isNew = head === null || head === ''
    return { ...base, baseline: baselineFor(scope, content, version, file, isNew) }
  }, [sessionId, turn, path, content, version, readonly, head])
}
