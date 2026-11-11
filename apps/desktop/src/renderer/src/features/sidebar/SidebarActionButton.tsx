import { useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { CountBadge, IconButton, SEGMENT_ICON } from '@/ui'
import { useFeedbackUnread } from '@/features/feedback/store'
import { useSidebarPrefs } from '@/features/appearance/sidebar'
import { getSidebarIcon, type FooterAction } from '@/features/appearance/sidebarIcons'
import { useSettings } from '@/features/settings/SettingsProvider'
import { OPEN_SETTINGS, withShortcut } from '@/features/layout/shortcuts'
import { readTodayUsage } from '@/features/usage/source'
import { formatShortCost } from '@/features/usage/format'

/** 设置 / 插件 / 用量入口（侧栏底部，或被用户挪到顶栏）；移动位置不改变行为与设置分类高亮。
 *  新建任务、添加项目固定在侧栏里（SidebarNav、项目段标题），不再走这里（docs/ui/layout-v2.md §3）。
 *  compact：顶栏轨道里用的 28×24（§4）。 */
export function SidebarActionButton({ action, compact = false }: { action: FooterAction; compact?: boolean }) {
  useI18n()
  const { icons } = useSidebarPrefs()
  const settings = useSettings()
  // 团队回复了反馈、还没看：设置按钮上一个数字角标（docs/ui/feedback-v2.md §4，超过 9 显示 9+）
  const unread = useFeedbackUnread()
  const dot = action === 'settings' && unread > 0
  // 用量图标悬停看今天花了多少（docs/ui/usage-learn.md §1）：底部只留图标，不常驻文字
  const [today, setToday] = useState<string | null>(null)
  const loadToday = (): void => {
    void readTodayUsage().then(t => {
      setToday(t && tr('usageColumns.today', { p0: formatShortCost(t), p1: t.turns }))
    })
  }

  const label =
    action === 'settings'
      ? withShortcut(tr('sidebar.SidebarFooter.settings'), OPEN_SETTINGS)
      : action === 'plugins'
        ? tr('plugins.title')
        : today
          ? `${tr('nav.TopNav.usage')}\n${today}`
          : tr('nav.TopNav.usage')
  const section = action === 'plugins' || action === 'usage' ? action : undefined
  const active =
    settings.open &&
    (action === 'settings'
      ? !['plugins', 'usage', 'mobile', 'extensions'].includes(settings.section)
      : settings.section === section)

  const button = (
    <IconButton
      data-sidebar-action={action}
      icon={getSidebarIcon(action, icons)}
      label={label}
      size={32}
      style={compact ? SEGMENT_ICON : undefined}
      active={active}
      aria-haspopup="dialog"
      onPointerEnter={action === 'usage' ? loadToday : undefined}
      onFocus={action === 'usage' ? loadToday : undefined}
      onClick={() => settings.openSettings(section)}
    />
  )
  if (action !== 'settings') return button
  return (
    <span className="relative inline-flex shrink-0">
      {button}
      {dot && (
        <CountBadge tone="notify" count={unread} max={9} className="pointer-events-none absolute -top-0.5 -right-0.5" />
      )}
    </span>
  )
}
