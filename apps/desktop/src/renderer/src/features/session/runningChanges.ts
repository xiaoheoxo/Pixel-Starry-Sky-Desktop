// 运行中的改动条（docs/ui/changes-bar.md）：正在跑的这一轮已经改完的文件（纯函数）
import type { Item } from '@pixelsky/protocol'
import type { ChangedFiles } from '@/data'
import { isTurnUser } from '@/features/coding/ai/turnChangesModel'
import { roundChangedFiles, sameItems } from './live/changeBlocks'

export interface RunningChanges {
  /** 开启这一轮的用户消息 id，第一条用户消息之前的为 null */
  userItemId: string | null
  data: ChangedFiles
  /** 算进来的改动条目：没变时沿用上次的结果 */
  edits: Extract<Item, { kind: 'file_change' }>[]
}

/** 刚改完的文件在列表里的键（分组 key + 路径，分组规则同 roundChangedFiles） */
export function latestFile({ edits, data }: RunningChanges): string | null {
  const edit = edits.at(-1)
  const change = edit?.changes.at(-1)
  if (!edit || !change) return null
  const group = data.groups && edit.subagent ? (edit.subagentCall ?? `name:${edit.subagent}`) : 'main'
  return `${group}:${change.path}`
}

/**
 * 分轮、合并都和收尾的改动卡片一样（roundChangedFiles），数字对得上；只算已完成的改动。
 * prev 是上次的结果：流式输出时改动条目没变就原样返回，不重新合并、不引起重绘
 */
export function runningChanges(items: readonly Item[], prev: RunningChanges | null): RunningChanges | null {
  const start = items.findLastIndex(isTurnUser)
  const edits: RunningChanges['edits'] = []
  for (let i = start + 1; i < items.length; i++) {
    const item = items[i]
    if (item.kind === 'file_change' && item.status === 'completed') edits.push(item)
  }
  const userItemId = start < 0 ? null : items[start].id
  if (prev && prev.userItemId === userItemId && sameItems(prev.edits, edits)) return prev
  const data = roundChangedFiles(edits)
  return data?.files.length ? { userItemId, data, edits } : null
}
