import { useEffect, useState } from 'react'
import { AppWindow, Pin, PinOff } from 'lucide-react'
import { cn } from '@/ui'
import { tr } from '../../i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import type { WindowState } from '../../../../shared/types/window'
import { SettingsContent, type SectionId } from './SettingsContent'
import { useSettingsWindowState } from './windowBridge'
import { leaveSettings } from './unsavedEdits'

/** Windows 自绘的最小化 / 最大化 / 关闭（和主窗口同一套样式，没有窗口布局弹层） */
function WindowButtons() {
  useI18n()
  const controls = window.pixelsky?.window
  const [state, setState] = useState<WindowState>({ maximized: false, focused: true, snapped: false })
  useEffect(() => {
    if (!controls) return
    let changed = false
    const off = controls.onState(next => {
      changed = true
      setState(next)
    })
    void controls
      .getState()
      .then(next => {
        if (!changed) setState(next)
      })
      .catch(() => undefined)
    return off
  }, [controls])
  if (!controls) return null
  const run = (action: () => Promise<void>): void => void action().catch(() => undefined)
  const svg = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.35 }
  const maximize = tr(state.maximized ? 'settingsWindow.restore' : 'settingsWindow.maximize')
  return (
    <div
      data-focused={state.focused}
      role="group"
      aria-label={tr('settingsWindow.controls')}
      className="window-controls no-drag fixed top-0 right-0 z-[100] flex h-12"
    >
      <button
        type="button"
        className="window-control"
        aria-label={tr('settingsWindow.minimize')}
        title={tr('settingsWindow.minimize')}
        onClick={() => run(controls.minimize)}
      >
        <svg {...svg} strokeLinecap="round" aria-hidden="true">
          <path d="M3 8h10" />
        </svg>
      </button>
      <button
        type="button"
        className="window-control"
        aria-label={maximize}
        title={maximize}
        onClick={() => run(controls.toggleMaximize)}
      >
        <svg {...svg} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {state.maximized ? (
            <>
              <path d="M5 3h8v8" />
              <rect x="2.5" y="5" width="8" height="8" rx=".5" />
            </>
          ) : (
            <rect x="3" y="3" width="10" height="10" rx=".5" />
          )}
        </svg>
      </button>
      <button
        type="button"
        className="window-control window-control-close"
        aria-label={tr('settingsWindow.close')}
        title={tr('settingsWindow.close')}
        onClick={() => run(controls.close)}
      >
        <svg {...svg} strokeLinecap="round" aria-hidden="true">
          <path d="m3 3 10 10m0-10L3 13" />
        </svg>
      </button>
    </div>
  )
}

const TITLE_BUTTON =
  'press no-drag inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-meta text-fg-muted hover:bg-hover hover:text-fg'

/**
 * 设置独立窗口的外框（docs/ui/settings-window.md §2）：自绘标题栏（置顶、收回、窗口按钮）+ 和浮层共用的内容，没有遮罩。
 * Esc 不关窗口（容易误关），只清空搜索框；关闭用 Ctrl+W 或窗口按钮。
 */
export function SettingsWindow({
  section,
  onSectionChange,
  jumpToken,
}: {
  section: SectionId
  onSectionChange: (section: SectionId) => void
  jumpToken: number
}) {
  useI18n()
  const { pinned } = useSettingsWindowState()
  const bridge = window.pixelsky?.settingsWindow
  const platform = window.pixelsky?.platform

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        void window.pixelsky?.window.close().catch(() => undefined)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-app text-fg">
      {/* 标题栏空白处按住拖动；右侧给窗口按钮留位置（Windows 自绘，Linux 是系统叠加层，macOS 的红绿灯在左边） */}
      <header
        className={cn(
          'drag titlebar-reserve flex h-12 shrink-0 items-center gap-1 border-b border-line pr-2 select-none',
          platform === 'darwin' ? 'pl-[84px]' : 'pl-5',
        )}
      >
        <h1 className="min-w-0 flex-1 truncate text-section font-semibold text-fg">{tr('settingsWindow.title')}</h1>
        <button
          type="button"
          aria-pressed={pinned}
          title={tr(pinned ? 'settingsWindow.pinOnTip' : 'settingsWindow.pinOffTip')}
          onClick={() => void bridge?.setPinned(!pinned).catch(() => undefined)}
          className={cn(
            TITLE_BUTTON,
            pinned && 'bg-accent-soft text-accent-fg hover:bg-accent-soft hover:text-accent-fg',
          )}
        >
          {pinned ? <Pin size={14} strokeWidth={1.5} /> : <PinOff size={14} strokeWidth={1.5} />}
          {tr('settingsWindow.pin')}
        </button>
        <button
          type="button"
          title={tr('settingsWindow.dockTip')}
          onClick={() => leaveSettings(() => void bridge?.dock(section).catch(() => undefined))}
          className={TITLE_BUTTON}
        >
          <AppWindow size={14} strokeWidth={1.5} />
          {tr('settingsWindow.dock')}
        </button>
      </header>
      {platform === 'win32' && <WindowButtons />}
      <SettingsContent
        section={section}
        onSectionChange={onSectionChange}
        standalone
        onClose={() => undefined}
        jumpToken={jumpToken}
      />
    </div>
  )
}
