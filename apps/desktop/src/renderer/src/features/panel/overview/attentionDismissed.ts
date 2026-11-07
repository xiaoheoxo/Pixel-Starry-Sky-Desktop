// 「要处理」里点过主操作的条目：这次打开应用不再提，下面的分组里还看得到。键里有检查 id、PR 地址，不用按会话分
import { useSyncExternalStore } from 'react'

let dismissed: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

export function setDismissed(key: string, on: boolean): void {
  if (dismissed.has(key) === on) return
  const next = new Set(dismissed)
  if (on) next.add(key)
  else next.delete(key)
  dismissed = next
  listeners.forEach(fn => fn())
}

export function useDismissed(): ReadonlySet<string> {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    () => dismissed,
  )
}

/** 新的一次检查 id 不同，自然又会提 */
export const checkAttentionKey = (runId: string): string => `check:${runId}`
