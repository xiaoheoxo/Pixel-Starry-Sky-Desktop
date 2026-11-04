// 界面的根渲染；由 main.tsx 在装入演示数据（如果是演示模式）之后动态加载
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/globals.css'
import { App } from './App'
import { ThemeProvider } from '../features/appearance/ThemeProvider'
import { SettingsProvider } from '../features/settings/SettingsProvider'
import { ExtStoreToastHost } from '@/features/extstore/ToastHost'
import { ExtCommandHost } from '@/features/extpacks/commands/ExtCommandHost'
import { ComingSoonProvider } from '../ui'
// 字体、强调色和配色设置在第一次渲染前就写到 <html> 上，避免启动时先闪一下默认字体
import '../features/appearance/fonts'
import '../features/appearance/accent'
import '../features/appearance/palette'
import { WallpaperLayer } from '../features/appearance/WallpaperLayer'
import { SearchProvider } from '../features/search/SearchProvider'
import { I18nProvider } from '../i18n/I18nProvider'
import { SessionActionsProvider } from '../features/sidebar/SessionActions'
import { ArchiveOldHost } from '../features/sidebar/ArchiveOldHost'
import { TerminalProvider } from '../features/terminal/TerminalProvider'
import { ResumeHost } from '../features/resume/ResumeHost'
import { ExportHost } from '../features/export/ExportDialog'
import { ResumeHintHost } from '../features/resume/ResumeHintHost'
import { CommandPaletteProvider } from '../features/commands/CommandPaletteProvider'
import { ShortcutsHelp } from '../features/layout/ShortcutsHelp'
import { installRendererErrorLog, reactRootErrorOptions } from '../features/logs/rendererErrors'
import { installLongTaskLog } from '../features/logs/longTasks'
import { installMemorySampler } from '../features/logs/memorySampler'
import { installInputClock } from '../features/logs/switchTiming'
import { RecoveredNotice } from '../features/recovery/RecoveredNotice'
import { SettingsSyncRunner } from '../features/settings/sync/RestoreNotice'
import { MainActionHost } from '../features/settings/MainActionHost'
import { WorkspaceReporter } from '../features/settings/WorkspaceReporter'
import { AuthDialogHost } from '../features/model-channels/AuthDialog'
import { BranchDialogHost } from '../features/session/branch/BranchViews'
import { startWindowActivity } from '../features/layout/windowActivity'
import { startAutoSave } from '../features/editor/autoSave'
import { startLoopClock } from '../features/layout/loopClock'
import { startPerfTier } from '../features/layout/perfTier'

document.documentElement.dataset.platform = window.pixelsky?.platform ?? 'web'
// 页面报错、未处理的 Promise 拒绝写进本机日志（docs/ui/logging.md §4.5）
installRendererErrorLog()
// 界面一次卡住超过 2 秒记一条（docs/ui/logging.md §4.9）
installLongTaskLog()
// 每隔一阵把界面的内存数报给主进程，写进本机日志（docs/ui/renderer-memory.md §3.2）
installMemorySampler()
// 窗口不在前台时暂停循环动画（docs/ui/performance.md）
startWindowActivity()
// 内置编辑器的自动保存（设置 › 编辑器 › 自动保存，默认关）
startAutoSave()
// 转圈、闪烁的点对齐同一个节奏（docs/ui/motion-proposal.html）
startLoopClock()
// 动画档位：插电、不卡时转圈平滑转，用电池或刚卡过时省电（docs/ui/performance.md §5.3）
startPerfTier()
// 记最近一次点击、按键：切换对话慢时记日志用（docs/ui/performance.md §5.2 B1）
installInputClock()

createRoot(document.getElementById('root')!, reactRootErrorOptions).render(
  <StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <WallpaperLayer />
        <SettingsSyncRunner />
        <ComingSoonProvider>
          <SettingsProvider>
            <SearchProvider>
              <SessionActionsProvider>
                <TerminalProvider>
                  <CommandPaletteProvider>
                    <App />
                    <ShortcutsHelp />
                    <AuthDialogHost />
                    <BranchDialogHost />
                    <ArchiveOldHost />
                    <ResumeHost />
                    <ExportHost />
                    <ResumeHintHost />
                    <RecoveredNotice />
                    <ExtStoreToastHost />
                    <ExtCommandHost />
                    <MainActionHost />
                    <WorkspaceReporter />
                  </CommandPaletteProvider>
                </TerminalProvider>
              </SessionActionsProvider>
            </SearchProvider>
          </SettingsProvider>
        </ComingSoonProvider>
      </ThemeProvider>
    </I18nProvider>
  </StrictMode>,
)
