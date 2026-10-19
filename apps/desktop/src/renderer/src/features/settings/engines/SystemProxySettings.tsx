// 设置 › 本机引擎「使用系统代理」：系统开着代理、用户没设 HTTPS_PROXY 时，把系统代理补给本机的 Claude Code、Codex、
// 像素星空引擎（main/engine/systemProxy.ts）。远程机器上的引擎不受影响，选着远程机器时不显示
import { useEffect, useState } from 'react'
import type { EngineId } from '@pixelsky/protocol'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { bridge, useEngineState } from '@/features/engine'
import { useMachines } from '@/features/machines/store'
import type { SystemProxyStatus } from '../../../../../shared/types/system-proxy'
import { SettingRow, Toggle } from '../SettingRow'

const PROXY_KEY = /^(https?_proxy|all_proxy)$/i
const ENGINES: EngineId[] = ['claude', 'codex', 'pixel']

/** 状态说明：开关关了、用户自己设了、查到 HTTP 代理、只有 SOCKS、没开代理 */
export function systemProxyHint(status: SystemProxyStatus, ownEngines: string[]): string {
  if (!status.enabled) return tr('systemProxy.off')
  if (status.envSet) return tr('systemProxy.envSet')
  const own = ownEngines.length ? ' ' + tr('systemProxy.ownEnv', { engines: ownEngines.join(' / ') }) : ''
  if (status.proxy) return tr('systemProxy.using', { proxy: status.proxy.replace(/^https?:\/\//, '') }) + own
  if (status.socks) return tr('systemProxy.socks', { proxy: status.socks })
  return tr('systemProxy.none')
}

export function SystemProxySettings() {
  useI18n()
  const machines = useMachines()
  const config = useEngineState(s => s.config)
  const engines = useEngineState(s => s.engines)
  const [status, setStatus] = useState<SystemProxyStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    bridge?.systemProxy().then(
      s => alive && setStatus(s),
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [])
  if (!status || machines.currentId !== 'local') return null
  // 在引擎自己的环境变量里设了代理的：那个引擎按用户的
  const own = ENGINES.filter(id => Object.keys(config?.[id]?.env ?? {}).some(k => PROXY_KEY.test(k))).map(
    id => engines.find(e => e.id === id)?.name ?? id,
  )
  const toggle = (enabled: boolean): void => {
    if (!bridge || busy) return
    setBusy(true)
    setError(null)
    bridge
      .setSystemProxy(enabled)
      .then(setStatus, (e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }
  return (
    <div className="mt-8">
      <SettingRow
        title={tr('systemProxy.title')}
        description={tr('systemProxy.description')}
        hint={error ? translateMessage(error) : undefined}
        hintTone="danger"
        control={<Toggle label={tr('systemProxy.title')} checked={status.enabled} onChange={toggle} />}
      >
        <p data-system-proxy-status className="text-meta text-fg-secondary">
          {systemProxyHint(status, own)}
        </p>
      </SettingRow>
    </div>
  )
}
