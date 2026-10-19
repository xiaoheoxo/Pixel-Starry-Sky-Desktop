// 设置独立窗口（?view=settings，docs/ui/settings-window.md）的界面根渲染；由 main.tsx 在装入演示数据（如果是演示模式）之后动态加载。
// 只挂设置页用得上的：语言、主题、壁纸、提示条、设置页本身。
// 不挂（主窗口才有）：通知分发、首次打开页、更新提示、设置云同步、全局快捷键、自动保存、内存采样。
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/globals.css'
import { ThemeProvider } from '../features/appearance/ThemeProvider'
import { SettingsWindowApp } from '../features/settings/SettingsWindowApp'
import { ComingSoonProvider } from '../ui'
// 字体、强调色和配色设置在第一次渲染前就写到 <html> 上，避免启动时先闪一下默认字体
import '../features/appearance/fonts'
import '../features/appearance/accent'
import '../features/appearance/palette'
import { WallpaperLayer } from '../features/appearance/WallpaperLayer'
import { I18nProvider } from '../i18n/I18nProvider'
import { installRendererErrorLog, reactRootErrorOptions } from '../features/logs/rendererErrors'
import { installLongTaskLog } from '../features/logs/longTasks'
import { startWindowActivity } from '../features/layout/windowActivity'
import { startLoopClock } from '../features/layout/loopClock'

document.documentElement.dataset.platform = window.pixelsky?.platform ?? 'web'
// 页面报错、未处理的 Promise 拒绝写进本机日志（docs/ui/logging.md §4.5）
installRendererErrorLog()
// 界面一次卡住超过 2 秒记一条（docs/ui/logging.md §4.9）
installLongTaskLog()
// 窗口不在前台时暂停循环动画（docs/ui/performance.md）
startWindowActivity()
// 转圈、闪烁的点对齐同一个节奏（docs/ui/motion-proposal.html）
startLoopClock()

createRoot(document.getElementById('root')!, reactRootErrorOptions).render(
  <StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <WallpaperLayer />
        <ComingSoonProvider>
          <SettingsWindowApp />
        </ComingSoonProvider>
      </ThemeProvider>
    </I18nProvider>
  </StrictMode>,
)
