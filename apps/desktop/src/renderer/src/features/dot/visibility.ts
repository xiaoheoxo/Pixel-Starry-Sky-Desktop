import type { SessionRecord } from '@pixelsky/protocol'

type WithRecord = { record: Pick<SessionRecord, 'engine' | 'dot'> }

/**
 * 侧栏、看板列哪些会话（docs/ui/dot-optimize.md §2）：从 Dot 组打开的对话（带 dot 引用）只在 Dot 组里出现；
 * 从模型菜单选 Dot 开的对话在项目下面，没登录 ChatGPT Pro 时藏起来（不删，重新登录后回来）
 */
export function listedSessions<T extends WithRecord>(sessions: readonly T[], dotVisible: boolean): T[] {
  return sessions.filter(s => !s.record.dot && (dotVisible || s.record.engine !== 'dot'))
}

/** 不满足显示条件时要关掉的 Dot 标签（会话 id） */
export function dotSessionIds(sessions: readonly (WithRecord & { record: { id: string } })[]): Set<string> {
  return new Set(sessions.filter(s => s.record.engine === 'dot' || !!s.record.dot).map(s => s.record.id))
}
