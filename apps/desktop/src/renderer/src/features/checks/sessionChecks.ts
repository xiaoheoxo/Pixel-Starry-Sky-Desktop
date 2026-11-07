// 会话的「做完自动检查」（docs/ui/channels-collab-v2.md §8）：开关存在会话所在机器上，结果由主进程推过来
import { useEffect, useState, useSyncExternalStore } from 'react'
import { demo, isDemo } from '@/data/demo'
import type { CheckRun } from '../../../../shared/types/checks'

const bridge = typeof window !== 'undefined' ? window.pixelsky?.projectTools : undefined

const runs = new Map<string, CheckRun | null>()
const listeners = new Set<() => void>()
let subscribed = false

function ensure(): void {
  if (subscribed) return
  subscribed = true
  if (isDemo) for (const [id, run] of Object.entries(demo().sessionChecks)) runs.set(id, run)
  bridge?.onSessionCheck(({ sessionId, run }) => {
    runs.set(sessionId, run)
    for (const l of listeners) l()
  })
}

/** 会话最近一次自动检查（没有为 null）；第一次用时向主进程要一次 */
export function useSessionCheck(sessionId: string | null): CheckRun | null {
  ensure()
  useEffect(() => {
    if (!sessionId || !bridge || runs.has(sessionId)) return
    void bridge
      .lastSessionCheck(sessionId)
      .then(run => {
        if (runs.has(sessionId)) return
        runs.set(sessionId, run)
        for (const l of listeners) l()
      })
      .catch(() => {})
  }, [sessionId])
  return useSyncExternalStore(
    l => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => (sessionId ? (runs.get(sessionId) ?? null) : null),
  )
}

/** 新任务的会话建好、发第一条消息之前打开自动检查 */
export async function enableSessionChecks(sessionId: string): Promise<void> {
  await bridge?.setSessionChecks({ sessionId }, true)
}

/**
 * 「做完自动检查」开关：读到之前是 false；改的时候先改界面，失败再改回去。
 * 新任务还没有会话：改 draft，建好会话时由 enableSessionChecks 写入
 */
export function useSessionCheckSwitch(
  sessionId: string | null,
  draft: { on: boolean; set: (on: boolean) => void },
): [boolean, (on: boolean) => void, boolean] {
  const [on, setOn] = useState(false)
  useEffect(() => {
    setOn(false)
    if (!sessionId || !bridge) return
    let alive = true
    void bridge
      .sessionChecks({ sessionId })
      .then(v => alive && setOn(v))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [sessionId])
  const set = (next: boolean) => {
    if (!sessionId || !bridge) return
    setOn(next)
    void bridge.setSessionChecks({ sessionId }, next).catch(() => setOn(!next))
  }
  return sessionId ? [on, set, !!bridge] : [draft.on, draft.set, !!bridge]
}
