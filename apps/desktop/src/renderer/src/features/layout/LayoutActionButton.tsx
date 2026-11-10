import { useI18n } from '@/i18n/I18nProvider'
import { IconButton, SEGMENT_ICON } from '@/ui'
import { useSettings } from '@/features/settings/SettingsProvider'
import { useSidebarPrefs } from '@/features/appearance/sidebar'
import { SidebarActionButton } from '@/features/sidebar/SidebarActionButton'
import {
  getLayoutIcon,
  isFooterAction,
  isPageAction,
  isToolAction,
  type LayoutAction,
  type PageAction,
  type ToolAction,
} from '@/features/appearance/sidebarIcons'
import type { SidebarPlacement } from '@/features/appearance/sidebar'
import { openRightTab, useActivePanelTab } from '@/features/panel/workspaceStore'
import { usePage } from '@/features/layout/page'
import { useAppMode } from '@/features/coding/mode'
import { routeWorkspaceTool } from '@/features/coding/routingModel'
import { tr } from '@/i18n/core'
import { useToolbarState } from './ToolbarContext'
import { OpenInButton } from '@/features/editor/OpenInButton'
import { useMinimal } from '@/features/appearance/ThemeProvider'
import { GitCount, TerminalDot } from './HeaderBadges'

const PAGE_SECTIONS = { 'page:mobile': 'mobile', 'page:machines': 'machines', 'page:extensions': 'extensions' } as const

/** 图标位置设置里的任一入口；顶栏、侧栏底部共用（「不显示」不渲染），挪位置不改变行为。
 *  顶栏里放在细边框轨道内，按钮缩成 28×24（docs/ui/layout-v2.md §4）。 */
export function LayoutActionButton({ action, placement }: { action: LayoutAction; placement: SidebarPlacement }) {
  const compact = placement === 'header'
  // display: contents 的外壳只做标记，不影响排版
  return (
    <span data-layout-slot={action} className="contents">
      {isFooterAction(action) ? (
        <SidebarActionButton action={action} compact={compact} />
      ) : action === 'git' || isToolAction(action) ? (
        <ToolButton action={action} compact={compact} />
      ) : isPageAction(action) ? (
        <PageButton action={action} compact={compact} />
      ) : (
        <OpenInButton placement={placement} />
      )}
    </span>
  )
}

/** 打开右侧面板的那一页；已经在显示时再点收起面板（docs/ui/git-panel.md §1.1） */
function ToolButton({ action, compact }: { action: 'git' | ToolAction; compact: boolean }) {
  useI18n()
  const { icons } = useSidebarPrefs()
  const { panelOpen } = useToolbarState()
  const id = action === 'git' ? action : action.slice(5)
  const name = tr(`sidebar.action.${action}`)
  const page = usePage()
  const tab = useActivePanelTab()
  const mode = useAppMode()
  const minimal = useMinimal()
  const shown = panelOpen && page === 'workbench' && tab === id
  // 代码模式没有评论、连接器这两栏，点了不会有反应，不如不显示
  if (mode === 'code' && !routeWorkspaceTool(id)) return null
  // 极简模式的顶栏：图标上带状态（docs/ui/minimal-mode.md §12 C）
  const badges = compact && minimal
  const toggle = (): void => {
    if (shown) window.dispatchEvent(new Event('pixelsky:close-right-workspace'))
    else openRightTab(id)
  }
  return (
    <IconButton
      icon={getLayoutIcon(action, icons)}
      label={action === 'git' ? tr(shown ? 'git.toolbar.close' : 'git.toolbar.open') : name}
      size={32}
      iconSize={16}
      style={
        compact
          ? badges && id === 'git'
            ? { ...SEGMENT_ICON, width: 'auto', minWidth: SEGMENT_ICON.width, paddingInline: 6, gap: 3 }
            : SEGMENT_ICON
          : undefined
      }
      className={badges ? 'relative' : undefined}
      active={shown}
      onClick={toggle}
    >
      {badges && id === 'git' && <GitCount />}
      {badges && id === 'terminal' && !shown && <TerminalDot />}
    </IconButton>
  )
}

/** 打开设置里的那一页（手机、机器与连接、扩展） */
function PageButton({ action, compact }: { action: PageAction; compact: boolean }) {
  useI18n()
  const { icons } = useSidebarPrefs()
  const settings = useSettings()
  const section = PAGE_SECTIONS[action]
  return (
    <IconButton
      icon={getLayoutIcon(action, icons)}
      label={tr(`sidebar.action.${action}`)}
      size={32}
      iconSize={16}
      style={compact ? SEGMENT_ICON : undefined}
      active={settings.open && settings.section === section}
      aria-haspopup="dialog"
      onClick={() => settings.openSettings(section)}
    />
  )
}
