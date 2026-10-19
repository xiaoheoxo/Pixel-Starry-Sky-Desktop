import type { Item } from '@pixelsky/protocol'

/** 条目超过上限时从前面整轮整轮去掉（至少留最后一轮）；返回留下的和去掉了几轮 */
export function fit(items: Item[], maxItems: number): { items: Item[]; dropped: number } {
  if (items.length <= maxItems) return { items, dropped: 0 }
  const users = items.flatMap((item, i) => (item.kind === 'user' ? [i] : []))
  if (users.length === 0) return { items: items.slice(-maxItems), dropped: 0 }
  let k = users.findIndex(i => i >= items.length - maxItems)
  if (k < 0) k = users.length - 1
  return { items: items.slice(users[k]), dropped: k }
}

export const countUsers = (items: readonly Item[]): number => items.filter(i => i.kind === 'user').length
