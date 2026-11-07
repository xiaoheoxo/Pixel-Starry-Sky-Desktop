// 连接器页和概况的 MCP 分组共用（docs/ui/connectors.md）：当前会话的连接器和对它们的操作
import { useEffect, useMemo, useState } from 'react'
import type { EngineId, ExtensionEntry, McpOp, McpReport } from '@pixelsky/protocol'
import { useToast } from '@/ui'
import { tr } from '@/i18n/core'
import { useEngineState } from '@/features/engine'
import { useSettings } from '@/features/settings/SettingsProvider'
import { isDemo, demo as demoData } from '@/data/demo'
import { buildConnectors, countCalls } from './connectorsModel'

export interface ConnectorSessionView {
  id: string
  engine: EngineId
  cwd: string
  report: McpReport | null
  calls: Record<string, Record<string, number>>
}

export interface ConnectorActions {
  busy: string | null
  ops: McpReport['ops']
  refresh(): void
  reconnect(name: string): void
  toggle(name: string, enabled: boolean): void
  login(name: string): void
  settings(): void
}

/** 看不见（active 为 false）或没有这个会话时是 null；演示模式总是演示数据 */
export function useConnectorView(id: string | null, active: boolean): ConnectorSessionView | null {
  // 只取用得到的：流式输出时快照每来一个字都变，结果没变就不重新渲染
  const json = useEngineState(s => {
    if (!active || !id || isDemo) return ''
    const snap = s.snapshots[id]
    const record = snap?.record ?? s.sessions.find(x => x.record.id === id)?.record
    if (!record) return ''
    const view: ConnectorSessionView = {
      id,
      engine: record.engine,
      cwd: record.cwd,
      report: snap?.mcp ?? null,
      calls: snap ? countCalls(record.engine, snap.items) : {},
    }
    return JSON.stringify(view)
  })
  const live = useMemo(() => (json ? (JSON.parse(json) as ConnectorSessionView) : null), [json])
  if (isDemo) {
    const d = demoData().connectors
    return { id: 'demo', engine: d.engine, cwd: d.cwd, report: d.report, calls: d.calls }
  }
  return live
}

/** 换会话时用 key 重新挂载（busy、error、读到的配置都是这个会话的）。view 为 null（看不见）时不发请求、列表是空的。onLoginOpened 代替默认的提示 */
export function useConnectors(view: ConnectorSessionView | null, active: boolean, onLoginOpened?: () => void) {
  const settings = useSettings()
  const toast = useToast()
  const [entries, setEntries] = useState<ExtensionEntry[]>(() => (isDemo ? demoData().connectors.entries : []))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const id = view?.id

  // 配置：设置 › 扩展的数据（SSH 机器上的会话读不到，只显示引擎报告的）
  useEffect(() => {
    if (isDemo || !id || !window.pixelsky) return
    let gone = false
    // 扩展连着变几次时只收最后一次读的结果，旧的晚到不覆盖新的
    let seq = 0
    const load = () => {
      const n = ++seq
      return window
        .pixelsky!.extensions.state({ sessionId: id })
        .then(s => !gone && n === seq && setEntries(s.entries))
        .catch(() => !gone && n === seq && setEntries([]))
    }
    void load()
    const off = window.pixelsky.extensions.onChange(() => void load())
    return () => {
      gone = true
      off()
    }
  }, [id])

  // 打开时取一次最新状态（结果经会话事件进快照）
  useEffect(() => {
    if (isDemo || !id || !active || !window.pixelsky) return
    void window.pixelsky.engine.mcp(id, { kind: 'refresh' }).catch(() => undefined)
  }, [id, active])

  const engine = view?.engine,
    report = view?.report,
    calls = view?.calls
  const list = useMemo(
    () => (engine && calls ? buildConnectors(engine, report, entries, calls) : []),
    [engine, report, entries, calls],
  )

  const run = async (key: string, op: McpOp) => {
    if (isDemo || !id || !window.pixelsky) return
    setBusy(key)
    setError('')
    try {
      const result = await window.pixelsky.engine.mcp(id, op)
      if (result.url) {
        await window.pixelsky.projectTools.openExternal(result.url)
        if (onLoginOpened) onLoginOpened()
        else toast(tr('connectors.loginOpened'))
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const actions: ConnectorActions = {
    busy,
    ops: report?.ops ?? [],
    refresh: () => run('refresh', { kind: 'refresh' }),
    reconnect: name => run('reconnect:' + name, { kind: 'reconnect', name }),
    toggle: (name, enabled) => run('toggle:' + name, { kind: 'toggle', name, enabled }),
    login: name => run('login:' + name, { kind: 'login', name }),
    settings: () => settings.openSettings('extensions'),
  }
  return { list, actions, error }
}
