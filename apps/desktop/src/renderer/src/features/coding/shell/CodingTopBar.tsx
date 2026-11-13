import { useI18n } from '@/i18n/I18nProvider'
import { useLayoutEffect, useRef, useState } from 'react'
import { PanelLeft } from 'lucide-react'
import { IconButton, SEGMENT_TRACK, cn } from '@/ui'
import { tr } from '@/i18n/core'
import { TOGGLE_SIDEBAR, withShortcut } from '@/features/layout/shortcuts'
import { useLayoutSize } from '@/features/layout/sizes'
import { codingLayout } from '../layoutStore'
import { isMac } from '@/features/layout/keybindings'
import { LayoutActionButton } from '@/features/layout/LayoutActionButton'
import { ModeSwitch } from '@/features/layout/ModeSwitch'
import { ToolbarContext } from '@/features/layout/ToolbarContext'
import { MachineSwitch } from '@/features/machines/MachineSwitch'
import { useSidebarPrefs } from '@/features/appearance/sidebar'
import { BranchWidget, CommandCenterButton, ProjectWidget, RunWidget } from '../topbar'

const TOOLBAR_STATE = { panelOpen: false }
/** 胶囊里两段字和收起按钮放得下的最小宽度 */
const MIN_CAPSULE = 220

/** 代码模式顶栏：模式切换 + 项目 / 分支，中间命令中心，右边运行 / 机器 / 打开方式（高 48） */
/** leftEdge：左边一列（活动栏 + 左栏）的右边，左栏收起时传 0 */
export function CodingTopBar({ leftEdge }: { leftEdge: number }) {
  useI18n()
  const { layout } = useSidebarPrefs()
  const header = useRef<HTMLElement>(null)
  const leading = useRef<HTMLDivElement>(null)
  const trailing = useRef<HTMLDivElement>(null)
  const [searchWidth, setSearchWidth] = useState(32)
  // 「对话 | 代码」胶囊左边离窗口 16、右边到左栏右边减 8，和对话模式侧栏里的胶囊一个排法（docs/ui/minimal-mode.md §18）；
  // 左栏收起或太窄时用对话模式侧栏里的宽度，不跟着缩
  const chatWidth = useLayoutSize('sidebar') - 24
  const capsuleWidth = leftEdge - 24 >= MIN_CAPSULE ? leftEdge - 24 : chatWidth
  useLayoutEffect(() => {
    const bar = header.current
    const left = leading.current
    const right = trailing.current
    if (!bar || !left || !right) return
    const place = (): void => {
      const bounds = bar.getBoundingClientRect()
      const middle = bounds.left + bounds.width / 2
      const available =
        2 * Math.min(middle - left.getBoundingClientRect().right - 8, right.getBoundingClientRect().left - middle - 8)
      setSearchWidth(available >= 200 ? Math.min(480, bounds.width * 0.36, available) : 32)
    }
    const observer = new ResizeObserver(place)
    ;[bar, left, right].forEach(element => observer.observe(element))
    place()
    return () => observer.disconnect()
  }, [])
  return (
    <header
      ref={header}
      data-coding-topbar
      className="drag @container grid h-12 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b border-line-layout bg-sidebar pr-2 pl-4"
    >
      <div ref={leading} className={cn('no-drag flex w-max items-center gap-2', isMac && 'pl-16')}>
        <div className="shrink-0" style={{ width: capsuleWidth }}>
          <ModeSwitch>
            <IconButton
              icon={PanelLeft}
              label={withShortcut(tr('coding.shell.cmd.toggleLeft'), TOGGLE_SIDEBAR)}
              style={{ width: 30, height: '100%' }}
              onClick={() => codingLayout.toggle('left')}
            />
          </ModeSwitch>
        </div>
        <ProjectWidget />
        <BranchWidget />
      </div>
      <div className="no-drag min-w-0" style={{ width: searchWidth }}>
        <CommandCenterButton compact={searchWidth === 32} />
      </div>
      <div
        ref={trailing}
        className="no-drag flex w-max items-center justify-self-end gap-0.5"
        style={{ paddingRight: 'var(--titlebar-reserve)' }}
      >
        <RunWidget />
        <MachineSwitch />
        {/* 用户的图标位置设置照样生效；代码模式没有右侧面板开关 */}
        {layout.header.length > 0 && (
          <div data-header-group className={SEGMENT_TRACK}>
            <ToolbarContext.Provider value={TOOLBAR_STATE}>
              {layout.header.map(action => (
                <LayoutActionButton key={action} action={action} placement="header" />
              ))}
            </ToolbarContext.Provider>
          </div>
        )}
      </div>
    </header>
  )
}
