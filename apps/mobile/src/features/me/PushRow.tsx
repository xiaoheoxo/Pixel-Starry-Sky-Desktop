// 「我的」里的锁屏提醒开关（docs/mobile-remote.md §22.2）：电脑上有任务等你处理 / 完成 / 出错时，手机锁屏也能收到。
import { useState } from 'react'
import { Bell, BellOff } from 'lucide-react'
import { disablePush, enablePush, pushState, type PushState } from '@/connection'
import { useConnections } from '@/data/hooks'
import { Row, Section } from '@/ui'

const SUBTITLE: Record<Exclude<PushState, 'unsupported'>, string> = {
  install: 'iPhone / iPad 要先添加到主屏幕，从桌面图标打开后再开',
  denied: '通知被系统关掉了：到系统设置里允许这个网页（或主屏幕上的图标）发通知',
  off: '电脑上有任务等你处理、完成或出错时提醒你（不带任务内容）',
  on: '已打开。网页开着时直接在页面上看，不另外提醒',
}

export function PushRow({ onInstall }: { onInstall: () => void }) {
  const { list } = useConnections()
  const [state, setState] = useState(pushState)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (state === 'unsupported') return null

  const toggle = async () => {
    if (state === 'install') return onInstall()
    if (state === 'denied' || busy) return
    if (state === 'on' && !confirm('关掉锁屏提醒？')) return
    setBusy(true)
    setError(null)
    try {
      if (state === 'on') setState(await disablePush(list))
      else {
        const r = await enablePush(list)
        setState(r.state)
        if (r.failed.length) setError(`${r.failed.join('、')} 没登记上，稍后关掉再打开一次`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '没开成，稍后再试')
      setState(pushState())
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="提醒">
      <Row
        icon={state === 'on' ? <Bell size={22} strokeWidth={1.5} /> : <BellOff size={22} strokeWidth={1.5} />}
        title="锁屏提醒"
        subtitle={error ?? (busy ? '正在设置…' : SUBTITLE[state])}
        trailing={
          state === 'on' || state === 'off' ? (
            <span className="text-meta text-fg-muted">{state === 'on' ? '已打开' : '打开'}</span>
          ) : undefined
        }
        onClick={state === 'denied' ? undefined : () => void toggle()}
        chevron={state === 'install'}
      />
    </Section>
  )
}
