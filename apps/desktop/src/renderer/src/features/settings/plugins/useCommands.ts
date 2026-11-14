import { useEffect, useMemo, useState } from 'react'
import { ENGINES, type EngineId, type SkillCommand } from '@pixelsky/protocol'
import { useEngineState } from '@/features/engine'
import { useActiveWorkspace } from '@/features/editor/target'
import { useEngineCatalog } from '@/features/engine/catalog'
import { rememberCommands, rememberedCommands } from './rememberedCommands'

export function useCommands(sessionId: string | null | undefined, engine: EngineId | undefined): SkillCommand[] {
  const workspace = useActiveWorkspace(),
    snapshot = useEngineState(state => (sessionId ? state.snapshots[sessionId] : undefined)),
    [configured, setConfigured] = useState<SkillCommand[]>([])
  // 插件命令是应用自己给的引擎（Claude Code）不用记；别的引擎只有进程报上来的
  const rememberKey =
    engine && !ENGINES[engine]?.caps.pluginCommands
      ? `${engine}:${snapshot?.record.projectId ?? workspace.ref?.projectId ?? ''}`
      : null
  useEffect(() => {
    let active = true
    const load = (): void => {
      // 应用管理的插件命令只给能力表 pluginCommands 为真的引擎
      if (engine && !ENGINES[engine]?.caps.pluginCommands) {
        setConfigured([])
        return
      }
      void window.pixelsky?.extensions
        .commands(sessionId ? { sessionId } : workspace.ref)
        .then(commands => {
          if (active) setConfigured(commands)
        })
        .catch(() => {
          if (active) setConfigured([])
        })
    }
    load()
    const stop = window.pixelsky?.extensions.onChange(load)
    return () => {
      active = false
      stop?.()
    }
    // 有会话时按会话取，不跟着当前工作区变：切标签页会换工作区，每个挂着的会话都重扫一遍插件（主进程同步扫描，用户机器上每次约 3.5 秒）
  }, [sessionId, sessionId ? null : workspace.key, engine])
  // 空列表＝进程还没报（换引擎时会清成 []）：Codex 起来后至少有 /compact
  const loaded = snapshot?.commands?.length ? snapshot.commands : undefined
  // 只记这个会话自己引擎报的（换了引擎、记录还没跟上时不记）
  const own = snapshot?.record.engine === engine
  // Antigravity 发第一条消息才起进程：之前用这个项目上次记下的，没有时用模型目录那次临时会话报的（docs/antigravity-engine.md §12）
  const agy = engine === 'antigravity'
  const agyCatalog = useEngineCatalog('antigravity', agy && !loaded)
  useEffect(() => {
    if (loaded && own && rememberKey) rememberCommands(rememberKey, loaded, agy)
  }, [loaded, own, rememberKey, agy])
  return useMemo(() => {
    const remembered = rememberKey ? rememberedCommands(rememberKey) : configured
    const before = agy && !remembered.length ? (agyCatalog?.commands ?? []) : remembered
    return (loaded ?? before).filter(
      command => !/^(?:mcp|plugin|plugins|login|logout|config|background|reload-plugins)$/.test(command.name),
    )
  }, [loaded, configured, rememberKey, agy, agyCatalog])
}
