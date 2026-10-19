import { useMemo } from 'react'
import { getEngineState, useEngineState } from '@/features/engine'
import { getPaneState, usePaneState } from '@/features/panes/store'
import { focusedTab, isNewTab, parseFileTab } from '@/features/panes/tree'
import { getFiles, useFiles } from '@/features/files/store'
import { isDemo, projects } from '@/data'
import type { WorkspaceRef } from '../../../../shared/types/workspace'
import { draftWorkspace } from '@/features/machines/drafts'

export interface ActiveWorkspace {
  ref: WorkspaceRef | null
  name: string
  path: string
  key: string
}

type EngineState = ReturnType<typeof getEngineState>
type FilesState = ReturnType<typeof getFiles>

export function useActiveWorkspace(): ActiveWorkspace {
  const tab = usePaneState(s => focusedTab(s.layout))
  const files = useFiles()
  // 结果没变就不重新渲染：流式输出时引擎状态每来一个字都变，这里只用到项目和会话记录（docs/ui/workbench-ux-3.md §2.1）
  const json = useEngineState(s => JSON.stringify(resolveWorkspace(tab, s, files)))
  return useMemo(() => JSON.parse(json) as ActiveWorkspace, [json])
}

/**
 * 不订阅、用的时候读一次。给每一行都有的按钮用（对话里的工具行）：useActiveWorkspace 订阅了整个引擎状态，
 * 流式输出时每来一个字，上千行都会跟着重新渲染（docs/ui/conversation-ux.md §2.7）
 */
export const getActiveWorkspace = (): ActiveWorkspace =>
  resolveWorkspace(focusedTab(getPaneState().layout), getEngineState(), getFiles())

/** 当前焦点标签对应的工作区 */
function resolveWorkspace(tab: string | null, state: EngineState, files: FilesState): ActiveWorkspace {
  const file = files.tabs.find(t => t.id === tab),
    parsed = tab ? parseFileTab(tab) : null
  if (parsed) {
    const ref = file?.ref ?? parsed.ref
    const project = state.projects.find(p => p.id === ref.projectId)
    const demo = isDemo
      ? projects.find(p => p.id === ref.projectId || p.sessions.some(s => s.id === ref.sessionId))
      : null
    return {
      ref,
      name: file?.project || project?.name || demo?.name || '',
      path: file?.root || project?.path || demo?.name || '',
      key: tab!,
    }
  }
  if (isDemo) {
    const project = projects.find(p => p.sessions.some(s => s.id === tab)) ?? projects[0]
    const ref = project ? { projectId: project.id } : null
    return { ref, name: project?.name ?? '', path: project?.name ?? '', key: project?.id ?? '' }
  }
  if (tab && !isNewTab(tab)) {
    const record = state.snapshots[tab]?.record ?? state.sessions.find(s => s.record.id === tab)?.record
    return {
      ref: record ? { sessionId: tab } : null,
      name: (() => {
        const p = state.projects.find(p => p.id === record?.projectId)
        return p && record && p.path.toLowerCase() !== record.cwd.toLowerCase()
          ? p.name + ' / ' + record.cwd.split(/[\\/]/).pop()
          : (p?.name ?? record?.title ?? '')
      })(),
      path: record?.cwd ?? '',
      key: tab,
    }
  }
  const project = state.projects.find(p => p.id === state.currentProjectId)
  const draft = tab ? draftWorkspace(tab) : null
  if (draft)
    return {
      ref: draft.sessionId ? { sessionId: draft.sessionId } : { projectId: draft.projectId },
      name: draft.name,
      path: draft.path,
      key: tab!,
    }
  return {
    ref: project ? { projectId: project.id } : null,
    name: project?.name ?? '',
    path: project?.path ?? '',
    key: project?.id ?? '',
  }
}
/** 某个标签属于哪个项目（会话、文件、新会话标签都算）；看不出来时为 null。不订阅，用的时候读一次 */
export function projectOfTab(tab: string): string | null {
  const state = getEngineState()
  const ref = resolveWorkspace(tab, state, getFiles()).ref
  if (!ref) return null
  if (ref.projectId) return ref.projectId
  if (isDemo) return projects.find(p => p.sessions.some(s => s.id === ref.sessionId))?.id ?? null
  const record =
    state.snapshots[ref.sessionId!]?.record ?? state.sessions.find(s => s.record.id === ref.sessionId)?.record
  return record?.projectId ?? null
}

export { keyRef, refKey } from './refKey'
