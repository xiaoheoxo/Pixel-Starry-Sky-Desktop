// 设置 › 本机引擎「闲置后释放引擎进程」（docs/engine-idle-release.md）：会话停下多久关掉它的引擎进程。
// 只管本机（SSH / WSL 机器上按默认 10 分钟），选着远程机器时不显示；照 SystemProxySettings 的写法
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { Segmented } from '@/ui'
import { bridge } from '@/features/engine'
import { useMachines } from '@/features/machines/store'
import { SettingRow } from '../SettingRow'

type Minutes = 5 | 10 | 30 | null
type Choice = '5' | '10' | '30' | 'off'

const toChoice = (m: Minutes): Choice => (m === null ? 'off' : (String(m) as Choice))
const toMinutes = (c: Choice): Minutes => (c === 'off' ? null : (Number(c) as 5 | 10 | 30))

export function IdleReleaseSettings() {
  useI18n()
  const machines = useMachines()
  const [minutes, setMinutes] = useState<Minutes | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  /** 连点几下只认最后一次的结果 */
  const request = useRef(0)
  useEffect(() => {
    let alive = true
    bridge?.idleRelease().then(
      s => alive && setMinutes(s.minutes),
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [])
  if (minutes === undefined || machines.currentId !== 'local') return null
  const change = (choice: Choice): void => {
    if (!bridge) return
    const prev = minutes
    const next = toMinutes(choice)
    const n = ++request.current
    setMinutes(next)
    setError(null)
    bridge.setIdleRelease(next).then(
      s => n === request.current && setMinutes(s.minutes),
      (e: Error) => {
        if (n !== request.current) return
        setMinutes(prev)
        setError(e.message)
      },
    )
  }
  return (
    <SettingRow
      title={tr('idleRelease.title')}
      description={tr('idleRelease.description')}
      hint={error ? translateMessage(error) : tr('idleRelease.hint')}
      hintTone={error ? 'danger' : undefined}
    >
      <Segmented
        label={tr('idleRelease.mode')}
        value={toChoice(minutes)}
        options={[
          { value: '5', label: tr('idleRelease.min5') },
          { value: '10', label: tr('idleRelease.min10') },
          { value: '30', label: tr('idleRelease.min30') },
          { value: 'off', label: tr('idleRelease.off') },
        ]}
        onChange={change}
      />
    </SettingRow>
  )
}
