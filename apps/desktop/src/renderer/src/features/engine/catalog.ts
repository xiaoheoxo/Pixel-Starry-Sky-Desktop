import { useEffect, useSyncExternalStore } from 'react'
import type { EngineCatalog, EngineId } from '@pixelsky/protocol'
import { bridge } from './store'
import { useEngineState } from './store'
import { getMachines, useMachines } from '@/features/machines/store'
import { isDemo } from '@/data'
import { demo } from '@/data/demo'
import { catalogSignature } from './catalogSignature'

const catalogs: Record<string, EngineCatalog> = {}
const pending = new Set<string>(),
  // 请求还没回来时签名又变了（例如刚打开菜单就点了重新检测）：回来后再取一次，别留着按旧参数取到的
  dirty = new Set<string>(),
  listeners = new Set<() => void>()
function load(engine: EngineId, key: string, machine: string): void {
  if (!bridge) return
  if (pending.has(key)) {
    dirty.add(key)
    return
  }
  pending.add(key)
  void bridge
    .catalog(engine)
    .then(value => {
      if (getMachines().currentId === machine) catalogs[key] = value
      listeners.forEach(fn => fn())
    })
    .catch(() => {})
    .finally(() => {
      pending.delete(key)
      if (dirty.delete(key)) load(engine, key, machine)
    })
}
export function useEngineCatalog(engine: EngineId): EngineCatalog | null {
  const { currentId } = useMachines(),
    key = currentId + ':' + engine
  const signature = useEngineState(state =>
    catalogSignature(
      state.engines.find(value => value.id === engine),
      state.config?.[engine],
      state.detectGen,
    ),
  )
  useEffect(() => load(engine, key, currentId), [engine, signature, key, currentId])
  return useSyncExternalStore(
    fn => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    // 演示模式没有引擎进程：Codex 用演示目录（③ ChatGPT 授权要列模型），其它照旧没有
    () => catalogs[key] ?? (isDemo && engine === 'codex' ? demo().engines.codexCatalog : null),
  )
}
