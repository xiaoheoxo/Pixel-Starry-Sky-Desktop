import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
// 设置 › 本机引擎的公用小件（列表页和详情页都用）
import type { EngineId } from '@pixelsky/protocol'

export const ENGINE_STATUS: Record<string, string> = {
  get unauthenticated() {
    return tr('sidebar.SidebarFooter.notSignedIn')
  },
  get missing() {
    return tr('settings.engines.parts.notInstalled')
  },
  get outdated() {
    return tr('settings.engines.parts.outdatedVersion')
  },
  get error() {
    return tr('settings.engines.parts.detectionFailed')
  },
  get unsupported() {
    return tr('session.ModelSourceMenu.comingSoon2')
  },
}

/** 有授权登录的引擎 → 授权弹窗的线路（Antigravity 是 Google 账号，D283）；列表的「去授权」和详情页头部共用 */
export const AUTH_CHANNEL_OF = { claude: 'claude', codex: 'chatgpt', antigravity: 'google' } as const

/** 详情页头部的一句介绍 */
export const ENGINE_INTRO: Record<EngineId, string> = {
  get claude() {
    return tr('settings.engines.parts.anthropicsOfficialCodingCli')
  },
  get codex() {
    return tr('settings.engines.parts.openaisCodingCliSupport')
  },
  get pixel() {
    return tr('engine.pixel.intro')
  },
  get antigravity() {
    return tr('settings.engines.parts.antigravityIntro')
  },
}

export const FIELD =
  'w-full max-w-lg rounded-md border border-line bg-subtle px-3 py-2 text-ui text-fg outline-none placeholder:text-fg-faint focus:border-line-strong focus:bg-surface'

export function DefaultBadge() {
  useI18n()
  return (
    <span className="inline-flex h-5 items-center rounded-full bg-accent-soft px-2 text-label font-medium text-accent-fg">
      {tr('engine.labels.default')}
    </span>
  )
}
