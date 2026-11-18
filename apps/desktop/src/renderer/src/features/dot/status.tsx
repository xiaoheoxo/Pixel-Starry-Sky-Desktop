import { Check, Circle, Clock, X } from 'lucide-react'
import { Spinner, cn } from '@/ui'
import { tr } from '@/i18n/core'

const STATUS_KEYS = {
  active: 'dot.status.active',
  connected: 'dot.status.connected',
  ready: 'dot.status.ready',
  paused: 'dot.status.paused',
  disconnected: 'dot.status.disconnected',
  unavailable: 'dot.status.unavailable',
  thinking: 'dot.status.thinking',
  inProgress: 'dot.status.inProgress',
  needsInput: 'dot.status.needsInput',
  completed: 'dot.status.completed',
  failed: 'dot.status.failed',
  interrupted: 'dot.status.interrupted',
} as const

export function dotStatus(status?: string): string {
  return status && status in STATUS_KEYS
    ? tr(STATUS_KEYS[status as keyof typeof STATUS_KEYS])
    : status || tr('dot.notLoaded')
}

/** 任务状态的颜色：进行中主色、等你处理警告色、失败 / 中断危险色、其余灰 */
export function statusTone(status?: string): 'accent' | 'warn' | 'danger' | 'muted' {
  if (status === 'inProgress' || status === 'thinking') return 'accent'
  if (status === 'needsInput') return 'warn'
  if (status === 'failed' || status === 'interrupted') return 'danger'
  return 'muted'
}

/** Dot 和它的电脑在不在：在线绿点、暂停橙点、其余（未连接、暂不可用、没读到）灰点 */
export function presenceTone(status?: string): 'on' | 'paused' | 'off' {
  if (status === 'active' || status === 'connected' || status === 'ready') return 'on'
  return status === 'paused' ? 'paused' : 'off'
}

/** 头像旁边那几个字：在线 / 已暂停 / 认得的状态原样翻译 / 其余「不在线」 */
export function dotPresence(status?: string): string {
  const tone = presenceTone(status)
  if (tone === 'on') return tr('dot.presence.on')
  return status && status in STATUS_KEYS ? dotStatus(status) : tr('dot.presence.off')
}

const TONE = {
  accent: 'bg-accent-soft text-accent-fg',
  warn: 'bg-warn/10 text-warn',
  danger: 'bg-danger/10 text-danger',
  muted: 'bg-subtle text-fg-muted',
} as const

export function DotStatusPill({ status }: { status?: string }) {
  return (
    <span className={cn('shrink-0 rounded px-1.5 text-meta leading-5', TONE[statusTone(status)])}>
      {dotStatus(status)}
    </span>
  )
}

/** 任务状态图标：进行中转圈、完成对勾、等你处理时钟、失败 / 中断叉，其余空心圆。旁边另有文字，图标不念 */
export function DotStatusIcon({ status, size = 22 }: { status?: string; size?: number }) {
  const tone = status === 'completed' ? 'done' : statusTone(status)
  const icon = Math.round(size * 0.6)
  return (
    <span className="dot-status-icon" data-tone={tone} style={{ width: size, height: size }} aria-hidden="true">
      {tone === 'accent' ? (
        <Spinner size={icon} />
      ) : tone === 'done' ? (
        <Check size={icon} />
      ) : tone === 'warn' ? (
        <Clock size={icon} />
      ) : tone === 'danger' ? (
        <X size={icon} />
      ) : (
        <Circle size={icon - 2} />
      )}
    </span>
  )
}
