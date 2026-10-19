// 设置独立窗口（docs/ui/settings-window.md）：窗口标题、自绘标题栏上的按钮、浮层里的「在独立窗口中打开」
export const settingsWindowMessages = {
  'settingsWindow.title': { zh: '设置 · 像素星空', en: 'Settings · Pixel Starry Sky' },
  'settingsWindow.popOut': { zh: '在独立窗口中打开', en: 'Open in a separate window' },
  'settingsWindow.popOutTip': {
    zh: '在独立窗口中打开（可以拖到软件外）',
    en: 'Open in a separate window (can be dragged outside the app)',
  },
  'settingsWindow.pin': { zh: '置顶', en: 'Pin' },
  'settingsWindow.pinOnTip': {
    zh: '置顶中：盖在主窗口上面。点一下取消',
    en: 'Pinned above the main window. Click to unpin',
  },
  'settingsWindow.pinOffTip': {
    zh: '没有置顶。点一下盖在主窗口上面',
    en: 'Not pinned. Click to keep it above the main window',
  },
  'settingsWindow.dock': { zh: '收回', en: 'Dock' },
  'settingsWindow.dockTip': { zh: '收回到主窗口里', en: 'Move back into the main window' },
  'settingsWindow.controls': { zh: '设置窗口操作', en: 'Settings window controls' },
  'settingsWindow.minimize': { zh: '最小化窗口', en: 'Minimize window' },
  'settingsWindow.maximize': { zh: '最大化窗口', en: 'Maximize window' },
  'settingsWindow.restore': { zh: '还原窗口', en: 'Restore window' },
  'settingsWindow.close': { zh: '关闭设置窗口（Ctrl+W）', en: 'Close settings window (Ctrl+W)' },
} as const
