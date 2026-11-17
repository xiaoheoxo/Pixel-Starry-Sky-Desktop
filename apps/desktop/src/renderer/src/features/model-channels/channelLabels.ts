// 通道和执行者的显示文字（输入框菜单、设置页共用）
import { tr } from '../../i18n/core'
import { ENGINES, type EngineId, type EngineInfo } from '@pixelsky/protocol'
import { AUTH_ENGINE, isAuthChannel, type AuthChannel, type ChannelId, type ChannelState } from './channelModel'
import { planInfo, type PlanProvider } from './plans'

export const CHANNEL_NUMBER: Record<ChannelId, string> = {
  dot: '④',
  platform: '①',
  claude: '②',
  chatgpt: '③',
  google: '⑤',
  custom: '⑥',
}
/** 小方块里的编号（菜单分组标题、设置卡片） */
export const CHANNEL_DIGIT: Record<ChannelId, string> = {
  dot: '4',
  platform: '1',
  claude: '2',
  chatgpt: '3',
  google: '5',
  custom: '6',
}

export const channelLabel = (c: ChannelId): string => tr(`modelChannels.channel.${c}`)
export const channelShort = (c: ChannelId): string => tr(`modelChannels.short.${c}`)

/** 输入框模型按钮要不要写「· 来源」：Claude / ChatGPT / Antigravity 自有授权有左侧引擎图标，不重复写后缀 */
export const showTriggerSource = (c: ChannelId): boolean => !isAuthChannel(c)

/** 执行者的名字：像素星空写成「像素星空 agent」，和通道「像素星空账号」分开 */
export const executorName = (e: EngineId): string =>
  e === 'pixel' ? tr('modelChannels.executor.pixel') : ENGINES[e].name

export const executorDesc = (e: EngineId): string => tr(`modelChannels.executor.desc.${e}`)

/** 套餐显示名：max_20x → Ultra，ChatGPT 的 prolite → Pro 10x（plans.ts）；没有为空串 */
export const planLabel = (provider: PlanProvider, plan: string | undefined): string =>
  planInfo(provider, plan)?.label ?? ''

/** 菜单里的邮箱只露第一个字（共享屏幕时不整个露出来），悬停看完整的 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@')
  return at > 1 ? `${email[0]}•••${email.slice(at)}` : email
}

/** 已授权的账号：邮箱 · 套餐（Ultra）；都没有时为空 */
export function accountText(
  account: { email?: string; plan?: string; org?: string } | undefined,
  provider: PlanProvider,
): string {
  if (!account) return ''
  return [account.email, planLabel(provider, account.plan)].filter(Boolean).join(' · ')
}

/** 授权通道显示的账号：Google 账号官方不返回邮箱，非 Key 登录且用户填了备注时把备注当账号显示（docs/antigravity-engine.md §14） */
export function channelAccount(
  channel: AuthChannel,
  info: Pick<EngineInfo, 'account' | 'auth'> | undefined,
  googleNote = '',
): { email?: string; plan?: string; org?: string } | undefined {
  if (channel !== 'google') return info?.account
  if (info?.auth?.kind === 'apiKey') return undefined
  const email = googleNote.trim() || undefined
  const plan = info?.account?.plan
  return email || plan ? { ...(email ? { email } : {}), ...(plan ? { plan } : {}) } : undefined
}

/** 模型菜单左栏 / 悬停提示里授权通道的第二行（方案 D：有邮箱/备注同 Claude，只有套餐显示「Ultra · N 个可用」，Key 显示「API Key · N 个可用」） */
export function authChannelSub(
  channel: AuthChannel,
  info: Pick<EngineInfo, 'account' | 'auth'> | undefined,
  usableText: string,
  googleNote = '',
): string {
  if (channel === 'google' && info?.auth?.kind === 'apiKey') return `${tr('modelChannels.menu.apiKey')} · ${usableText}`
  const a = channelAccount(channel, info, googleNote)
  const plan = planLabel(channel, a?.plan)
  if (a?.email) return [maskEmail(a.email), plan].filter(Boolean).join(' · ')
  if (plan) return channel === 'google' ? `${plan} · ${usableText}` : plan
  return usableText
}

/** 通道不能用时的一句话；能用时为 null */
export function channelStateText(channel: ChannelId, state: ChannelState): string | null {
  const engine = isAuthChannel(channel) ? ENGINES[AUTH_ENGINE[channel]].name : ''
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
