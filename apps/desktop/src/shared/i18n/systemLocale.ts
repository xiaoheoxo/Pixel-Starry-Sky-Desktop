// 默认界面语言跟着系统走（D330）：中文系统（任何地区）用简体中文，其他都用英文
import type { Locale } from './messages'

/** 系统语言列表（第一个是首选）→ 界面语言 */
export function localeOfSystem(languages: readonly (string | null | undefined)[]): Locale {
  const first = languages.find((l): l is string => typeof l === 'string' && l.trim() !== '')
  return first && /^zh(?:[-_]|$)/i.test(first.trim()) ? 'zh-CN' : 'en-US'
}

/**
 * 启动时用哪种语言。stored 是设置里存的（选过就用它）；没选过时：
 * 这台电脑上用过像素星空（存着别的设置）→ 简体中文（以前默认中文，升级后别突然变），persist 为 true 表示记下来；
 * 新装 → 按系统语言，不记（以后改了系统语言跟着变）
 */
export function chooseLocale(
  stored: string | null,
  usedBefore: boolean,
  system: readonly (string | null | undefined)[],
): { locale: Locale; persist: boolean } {
  if (stored === 'en-US' || stored === 'zh-CN') return { locale: stored, persist: false }
  if (usedBefore) return { locale: 'zh-CN', persist: true }
  return { locale: localeOfSystem(system), persist: false }
}
