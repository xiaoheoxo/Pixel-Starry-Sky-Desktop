import { PanelLeft } from 'lucide-react'
import { IconButton, cn } from '@/ui'
import { ModeSwitch } from '@/features/layout/ModeSwitch'
import { TOGGLE_SIDEBAR, withShortcut } from '@/features/layout/shortcuts'
import { useI18n } from '@/i18n/I18nProvider'

const isMac = window.pixelsky?.platform === 'darwin'

/**
 * 侧栏最上面一行（docs/ui/minimal-mode.md §18）：一个整宽胶囊，「对话 | 代码」平分，收起侧栏在右端。
 * 胶囊左边、顶上都离窗口 16：一条线时直接留 16，两块独立时侧栏整列是一张卡片（离窗口 8），胶囊在卡片里再留 8
 */
export function SidebarHeader({ onCollapse }: { onCollapse: () => void }) {
  const { text } = useI18n()
  return (
    <div
      data-sidebar-tools
      data-mac={isMac || undefined}
      className={cn('drag flex shrink-0 items-center pt-4 pr-2 pl-4', isMac && 'pl-20')}
    >
      <ModeSwitch>
        <IconButton
          icon={PanelLeft}
          label={withShortcut(text('收起侧边栏'), TOGGLE_SIDEBAR)}
          style={{ width: 28, height: '100%' }}
          onClick={onCollapse}
        />
      </ModeSwitch>
    </div>
  )
}
