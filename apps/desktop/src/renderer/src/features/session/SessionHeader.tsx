import { Ellipsis, Keyboard, MessageSquare, PanelLeft, PanelRight, SquareArrowOutUpRight } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { cn, IconButton, SEGMENT_ICON, SEGMENT_TRACK } from '@/ui'
import { ActionMenu, type MenuAction } from '@/ui/ActionMenu'
import { isMac } from '@/features/layout/keybindings'
import {
  COMMAND_PALETTE,
  TOGGLE_PANEL,
  TOGGLE_SIDEBAR,
  TOGGLE_TUI_MODE,
  withShortcut,
} from '@/features/layout/shortcuts'
import { useI18n } from '@/i18n/I18nProvider'
import { useCommandPalette } from '@/features/commands/CommandPaletteProvider'
import { MachineSwitch } from '@/features/machines/MachineSwitch'
import { headerActions, MINIMAL_HEADER, useSidebarPrefs } from '@/features/appearance/sidebar'
import { useMinimal } from '@/features/appearance/ThemeProvider'
import { useAppMode } from '@/features/coding/mode'
import { useChannelUnreadTotal } from '@/features/channels/store'
import { tr, type TranslationKey } from '@/i18n/core'
import { LayoutActionButton } from '@/features/layout/LayoutActionButton'
import { ToolbarContext } from '@/features/layout/ToolbarContext'
import { SessionChannelBadge } from '@/features/channels/SessionChannelBadge'
import { useOpenInActions } from '@/features/editor/OpenInButton'

interface SessionHeaderProps {
  title: string
  showActions: boolean
  sidebarOpen: boolean
  panelOpen: boolean
  onToggleSidebar: () => void
  onTogglePanel: () => void
  filesPanelOpen?: boolean
  onCloseFiles?: () => void
  /** 替换最右的面板开关（协作频道页控制成员面板）；null 时不显示，不传时是右侧面板开关 */
  panelToggle?: { open: boolean; label: string; onToggle: () => void } | null
  /** 当前会话：加入了频道时标题旁显示「# 频道 · 成员名」（docs/ui/import-collab.md 第 5 项②） */
  sessionId?: string | null
  /**
   * 界面 ⇄ 终端（TUI）：方案 E 收进「更多」菜单（docs/ui/tui-toggle.md）；
   * 顶栏不再放分段开关；终端模式时「更多」上有绿点
   */
  tui?: {
    mode: 'ui' | 'terminal'
    running?: boolean
    disabledReason?: string | null
    onChange: (mode: 'ui' | 'terminal') => void
  } | null
}

/** 跨会话区和右面板的顶栏：标题在左，工具在右侧连续排列。
 *  机器切换和右面板开关固定，中间工具的顺序和去留由图标位置设置决定（docs/ui/sidebar-compact-controls.md）。 */
export function SessionHeader({
  title,
  showActions,
  sidebarOpen,
  panelOpen,
  onToggleSidebar,
  onTogglePanel,
  filesPanelOpen,
  onCloseFiles,
  panelToggle,
  sessionId,
  tui,
}: SessionHeaderProps) {
  const { text } = useI18n()
  const commands = useCommandPalette()
  const { layout } = useSidebarPrefs()
  const channelUnread = useChannelUnreadTotal()
  // 极简模式的会话页（对话模式）：顶栏默认摆上概况和常用工具（docs/ui/minimal-mode.md §12 C）；看板、频道页不变
  const minimalOn = useMinimal()
  const appMode = useAppMode()
  const headerItems = headerActions(layout, minimalOn && appMode !== 'code' && panelToggle === undefined)
  // 极简的默认摆法里没有「打开方式」：放进「⋯」
  const openIn = useOpenInActions(headerItems === MINIMAL_HEADER)
  const openInMenu = headerItems === MINIMAL_HEADER && openIn.length > 0
  const [more, setMore] = useState<{ x: number; y: number } | null>(null)
  const moreLabel = text('更多')
  const showMore = showActions || !!tui || openInMenu
  const tuiActive = Boolean(tui?.running || tui?.mode === 'terminal')

  const moreActions = useMemo((): MenuAction[] => {
    const actions: MenuAction[] = []
    if (tui) {
      const disabledTitle = tui.disabledReason ? tr(tui.disabledReason as TranslationKey) : undefined
      actions.push({
        label: tr('session.tui.toggle'),
        icon: Keyboard,
        hint: TOGGLE_TUI_MODE.label,
        children: [
          {
            label: tr('session.tui.ui'),
            icon: MessageSquare,
            checked: tui.mode === 'ui',
            disabled: tui.mode === 'ui',
            run: () => tui.onChange('ui'),
          },
          {
            label: tr('session.tui.terminal'),
            icon: Keyboard,
            checked: tui.mode === 'terminal',
            disabled: !!tui.disabledReason || tui.mode === 'terminal',
            title: tui.mode === 'terminal' ? undefined : disabledTitle,
            run: () => tui.onChange('terminal'),
          },
        ],
      })
      actions.push({
        label: tr('session.tui.commandPalette'),
        separator: true,
        run: () => commands.open(),
        hint: COMMAND_PALETTE.label,
      })
    } else {
      actions.push({
        label: tr('session.tui.commandPalette'),
        run: () => commands.open(),
        hint: COMMAND_PALETTE.label,
      })
    }
    if (openInMenu) actions.push({ label: tr('sidebar.action.openIn'), icon: SquareArrowOutUpRight, children: openIn })
    return actions
  }, [tui, commands, openInMenu, openIn])

  return (
    <header
      className={cn(
        'session-header drag @container flex h-12 shrink-0 items-center gap-2',
        isMac && !sidebarOpen ? 'pl-20' : 'pl-4',
      )}
      style={{ paddingRight: 'calc(var(--titlebar-reserve) + 12px)' }}
    >
      {!sidebarOpen && (
        <span className="relative inline-flex shrink-0">
          <IconButton
            icon={PanelLeft}
            label={[
              withShortcut(text('展开侧边栏'), TOGGLE_SIDEBAR),
              channelUnread > 0 ? tr('sidebar.channelsUnread', { n: channelUnread }) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
            size={32}
            iconSize={16}
            onClick={onToggleSidebar}
          />
          {channelUnread > 0 && (
            <span
              data-channel-unread
              className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-accent"
            />
          )}
        </span>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {title && (
          <h1 title={title} className="min-w-0 truncate text-ui font-semibold text-fg">
            {title}
          </h1>
        )}
        {sessionId && <SessionChannelBadge sessionId={sessionId} />}
        {showMore && (
          <span data-header-more data-tui-active={tuiActive ? '' : undefined} className="relative inline-flex shrink-0">
            <IconButton
              icon={Ellipsis}
              label={moreLabel}
              size={32}
              iconSize={16}
              aria-haspopup="menu"
              aria-expanded={more !== null}
              onClick={e => {
                const rect = e.currentTarget.getBoundingClientRect()
                setMore({ x: rect.left, y: rect.bottom + 4 })
              }}
            />
            {tuiActive && (
              <span
                className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-[var(--terminal-ansi-2,#3d9a6a)]"
                title={tr('session.tui.terminalActive')}
                aria-label={tr('session.tui.terminalActive')}
              />
            )}
          </span>
        )}
      </div>
      <div className="header-tools no-drag ml-auto flex shrink-0 items-center gap-0.5">
        <MachineSwitch />
        {(headerItems.length > 0 || panelToggle !== null) && (
          <div data-header-group className={SEGMENT_TRACK}>
            <ToolbarContext.Provider value={{ panelOpen, filesPanelOpen, onCloseFiles }}>
              {headerItems.map(action => (
                <Fragment key={action}>
                  <LayoutActionButton action={action} placement="header" />
                  {action === 'tool:overview' && headerItems === MINIMAL_HEADER && (
                    <span aria-hidden data-header-tools-sep className="mx-0.5 h-3.5 w-px shrink-0 bg-line" />
                  )}
                </Fragment>
              ))}
            </ToolbarContext.Provider>
            {headerItems.length > 0 && panelToggle !== null && (
              <span aria-hidden data-panel-sep className="mx-0.5 h-3.5 w-px shrink-0 bg-line" />
            )}
            {panelToggle === undefined ? (
              <IconButton
                icon={PanelRight}
                label={withShortcut(panelOpen ? text('收起右侧面板') : text('展开右侧面板'), TOGGLE_PANEL)}
                style={SEGMENT_ICON}
                active={panelOpen}
                aria-expanded={panelOpen}
                onClick={onTogglePanel}
              />
            ) : (
              panelToggle && (
                <IconButton
                  icon={PanelRight}
                  label={withShortcut(panelToggle.label, TOGGLE_PANEL)}
                  style={SEGMENT_ICON}
                  active={panelToggle.open}
                  aria-expanded={panelToggle.open}
                  onClick={panelToggle.onToggle}
                />
              )
            )}
          </div>
        )}
      </div>
      {more && (
        <ActionMenu x={more.x} y={more.y} label={moreLabel} actions={moreActions} onClose={() => setMore(null)} />
      )}
    </header>
  )
}
