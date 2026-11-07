// 概况各分组共用的数据入口：只取用得到的字段（流式输出时 snapshot 每来一个字都变）
import { useEffect, useState } from 'react'
import type { ContextWindow, SessionRecord } from '@pixelsky/protocol'
import { useToast } from '@/ui'
import { isDemo } from '@/data'
import { demo } from '@/data/demo'
import { tr } from '@/i18n/core'
import { useEngineState } from '@/features/engine'
import { channelOf } from '@/features/model-channels/channelModel'
import { useQuotaSource } from '@/features/session/quota/quotaStore'
import { useQuotaTarget } from '@/features/session/quota/useQuotaTarget'
import { useConnectors, useConnectorView } from '../connectors/useConnectors'

export function useSessionRecord(sessionId: string, active: boolean): SessionRecord | null {
  return useEngineState(s =>
    active ? (s.snapshots[sessionId]?.record ?? s.sessions.find(x => x.record.id === sessionId)?.record ?? null) : null,
  )
}

export function useSessionContext(sessionId: string, active: boolean): ContextWindow | null {
  const live = useEngineState(s => (active ? (s.snapshots[sessionId]?.context ?? null) : null))
  return isDemo && active ? demo().context : live
}

/** 这个会话账号的额度，和输入框的额度按钮同一份。provider 是 null：这个通道没有额度（自定义接口、远程机器、设置里关了） */
export function useSessionQuota(sessionId: string) {
  const channel = useEngineState(s => {
    const record = s.snapshots[sessionId]?.record
    return record ? channelOf(record.engine, record.platform ? 'platform' : record.provider ? 'custom' : 'self') : null
  })
  const { provider, accountKey } = useQuotaTarget(channel, sessionId)
  return { provider, ...useQuotaSource(provider, accountKey) }
}

/**
 * MCP 分组和「要处理」共用一份：各用各的话，打开概况就要两次配置和状态。所以放在概况这一层，
 * MCP 分组被隐藏了「要处理」照样有数据。看不见（active 为 false）时不发请求；换会话靠外面的 key 重新挂载
 */
export function useOverviewMcp(sessionId: string, active: boolean) {
  const toast = useToast()
  const view = useConnectorView(sessionId, active)
  const [awaitingLogin, setAwaitingLogin] = useState(false)
  const { list, actions, error } = useConnectors(view, active, () => {
    setAwaitingLogin(true)
    toast(tr('overview.mcpLoginOpened'))
  })
  const id = view?.id
  const needsLogin = list.some(c => c.status === 'auth')
  // 登录在外部浏览器里做完，这边没有事件：回到窗口时重新要一次状态，直到不用再登录
  useEffect(() => {
    if (!awaitingLogin || !needsLogin || !id) return
    return window.pixelsky?.window.onState(state => {
      if (state.focused) void window.pixelsky?.engine.mcp(id, { kind: 'refresh' }).catch(() => undefined)
    })
  }, [awaitingLogin, needsLogin, id])
  // 演示模式没有引擎，操作只给个提示
  const demoOp = (): void => toast(tr('session.ContextWindowButton.engineActionsAreUnavailable'))
  return {
    report: view?.report ?? null,
    list,
    error,
    actions: isDemo ? { ...actions, refresh: demoOp, reconnect: demoOp, toggle: demoOp, login: demoOp } : actions,
  }
}

export type OverviewMcp = ReturnType<typeof useOverviewMcp>

/** 终端模式没有输入框，也就没有上下文弹窗可开 */
export function useHasComposer(sessionId: string): boolean {
  return useEngineState(s => !s.snapshots[sessionId]?.record.tui)
}
