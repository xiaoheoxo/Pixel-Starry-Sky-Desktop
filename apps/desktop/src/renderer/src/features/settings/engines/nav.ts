// 设置 › 本机引擎：现在看的是列表还是某个引擎的详情（docs/ui/engine-settings-redesign.md §3.1）。
// 放在组件外面，设置搜索和「模型与额度」页的链接也能直接打开详情。
import { useSyncExternalStore } from 'react'
import type { EngineId } from '@pixelsky/protocol'

let detail: EngineId | null = null
const listeners = new Set<() => void>()

export const getEngineDetail = (): EngineId | null => detail

export function openEngineDetail(id: EngineId | null): void {
  if (detail === id) return
  detail = id
  listeners.forEach(l => l())
}

export function useEngineDetail(): EngineId | null {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => detail,
  )
}
