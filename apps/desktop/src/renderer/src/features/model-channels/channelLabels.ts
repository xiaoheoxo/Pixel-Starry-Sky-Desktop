// 通道和执行者的显示文字（输入框菜单、设置页共用）
import { tr } from '../../i18n/core'
import { ENGINES, type EngineId } from '@pixelsky/protocol'
import { AUTH_ENGINE, type ChannelId, type ChannelState } from './channelModel'
import { planInfo, type PlanProvider } from './plans'

export const CHANNEL_NUMBER: Record<ChannelId, string> = { platform: '①', claude: '②', chatgpt: '③', custom: '④' }
/** 小方块里的编号（菜单分组标题、设置卡片） */
export const CHANNEL_DIGIT: Record<ChannelId, string> = { platform: '1', claude: '2', chatgpt: '3', custom: '4' }

export const channelLabel = (c: ChannelId): string => tr(`modelChannels.channel.${c}`)
export const channelShort = (c: ChannelId): string => tr(`modelChannels.short.${c}`)

/** 执行者的名字：像素星空写成「像素星空 agent」，和通道「像素星空账号」分开 */
export const executorName = (e: EngineId): string =>
  e === 'pixel' ? tr('modelChannels.executor.pixel') : ENGINES[e].name

export const executorDesc = (e: EngineId): string => tr(`modelChannels.executor.desc.${e}`)

/** 套餐显示名：max_20x → Max 20x，ChatGPT 的 prolite → Pro 5x（plans.ts）；没有为空串 */
export const planLabel = (provider: PlanProvider, plan: string | undefined): string =>
  planInfo(provider, plan)?.label ?? ''

/** 菜单里的邮箱只露第一个字（共享屏幕时不整个露出来），悬停看完整的 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@')
  return at > 1 ? `${email[0]}•••${email.slice(at)}` : email
}

/** 已授权的账号：邮箱 · 套餐（Max 20x）；都没有时为空 */
export function accountText(
  account: { email?: string; plan?: string; org?: string } | undefined,
  provider: PlanProvider,
): string {
  if (!account) return ''
  const plan = planLabel(provider, account.plan)
  return [account.email, plan].filter(Boolean).join(' · ')
}

/** 通道不能用时的一句话；能用时为 null */
export function channelStateText(channel: ChannelId, state: ChannelState): string | null {
  const engine = channel === 'claude' || channel === 'chatgpt' ? ENGINES[AUTH_ENGINE[channel]].name : ''
  switch (state.kind) {
    case 'ready':
      return null
    case 'loading':
      return tr('modelChannels.state.loading')
    case 'signin':
      return tr('modelChannels.state.signin')
    case 'no-route':
      return tr('modelChannels.state.noRoute')
    case 'auth':
      return tr('modelChannels.state.auth')
    case 'missing':
      return tr('modelChannels.state.missing', { p0: engine })
    case 'outdated':
      return tr('modelChannels.state.outdated', { p0: engine })
    case 'error':
      return tr('modelChannels.state.error', { p0: engine })
    case 'empty':
      return tr('modelChannels.state.empty')
  }
}

/** 通道不能用时右边的按钮 */
export type ChannelFix = 'signin' | 'retry' | 'auth' | 'install' | 'update' | 'view' | 'add-endpoint'

export function channelFix(state: ChannelState): ChannelFix | null {
  switch (state.kind) {
    case 'signin':
      return 'signin'
    case 'no-route':
      return 'retry'
    case 'auth':
      return 'auth'
    case 'missing':
      return 'install'
    case 'outdated':
      return 'update'
    case 'error':
      return 'view'
    case 'empty':
      return 'add-endpoint'
    default:
      return null
  }
}

export function channelFixLabel(fix: ChannelFix): string {
  switch (fix) {
    case 'signin':
      return tr('modelChannels.action.signIn')
    case 'retry':
      return tr('modelChannels.action.retry')
    case 'auth':
      return tr('modelChannels.action.auth')
    case 'install':
      return tr('modelChannels.action.install')
    case 'update':
      return tr('modelChannels.action.update')
    case 'view':
      return tr('modelChannels.action.view')
    case 'add-endpoint':
      return tr('modelChannels.action.addEndpoint')
  }
}
