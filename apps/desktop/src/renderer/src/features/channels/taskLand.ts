// 任务卡上的合并 / PR 按钮（docs/ui/channels-local-rest.md §3.1）。纯函数
import type { ChannelTask } from '@/data/types'

export interface LandView {
  /** 分支行：副本还在、或合并过（写合并到哪） */
  branch: string | null
  canMerge: boolean
  canPr: boolean
  canResolve: boolean
  /** 合并、开 PR 后不能再追加、重试 */
  locked: boolean
}

export function landView(task: ChannelTask, live: boolean): LandView {
  const copy = task.copy
  const land = task.land ?? null
  const merged = land?.kind === 'merged'
  const open = live && !!copy && !task.copyRemoved && !merged && task.status === 'done'
  return {
    branch: copy ? copy.branch : null,
    canMerge: open && land?.kind !== 'conflict',
    canPr: open && land?.kind !== 'pr',
    canResolve: live && !!copy && land?.kind === 'conflict' && !task.copyRemoved,
    locked: merged || !!task.copyRemoved,
  }
}
