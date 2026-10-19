import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { OPEN_SETTINGS } from '@/features/layout/shortcuts'
import { SettingsDialog } from './SettingsDialog'
import { isSectionId, type SectionId } from './SettingsContent'
import { openInSettingsWindow, openSettingsRouted, startSettingsWindowSync } from './windowBridge'

export interface SettingsContextValue {
  open: boolean
  /** 设置内部导航也同步到这里，侧栏入口据此显示当前分类。 */
  section: SectionId
  /** 打开设置；传入分类时直接定位到那一页（例如账号菜单里的「账号设置…」） */
  openSettings: (section?: SectionId) => void
  closeSettings: () => void
}

export const SettingsContext = createContext<SettingsContextValue | null>(null)

/**
 * 设置界面的开关状态 + Ctrl+, 快捷键；对话框渲染在这里（docs/ui/settings.md）。
 * 记住的打开方式是独立窗口时（docs/ui/settings-window.md），openSettings 改为请主进程打开 / 提到前面设置窗口，这里的浮层不弹。
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  useI18n()
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<SectionId>('appearance')
  const triggerRef = useRef<HTMLElement | null>(null)
  const triggerSidebarActionRef = useRef<string | null>(null)
  // 没指定分类时停在「外观」；设置已经打开时也跳过去
  const openDialog = useCallback(
    (target?: SectionId) => {
      if (!open) {
        triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        triggerSidebarActionRef.current =
          triggerRef.current?.closest('[data-sidebar-action]')?.getAttribute('data-sidebar-action') ?? null
      }
      setSection(target ?? 'appearance')
      setOpen(true)
    },
    [open],
  )
  const openSettings = useCallback((target?: SectionId) => openSettingsRouted(target, openDialog), [openDialog])
  const closeSettings = useCallback(() => setOpen(false), [])
  // 浮层标题栏的「在独立窗口中打开」：窗口打开（并记住下次也用窗口）后关掉浮层，停在同一个分区
  const popOut = useCallback(() => {
    openInSettingsWindow(section)
      .then(() => setOpen(false))
      .catch(() => undefined)
  }, [section])

  // 设置窗口的状态（记住的打开方式）；设置窗口点「收回」时主进程让这里打开浮层
  const openDialogRef = useRef(openDialog)
  openDialogRef.current = openDialog
  useEffect(() => {
    startSettingsWindowSync()
    return window.pixelsky?.settingsWindow?.onOpenDialog(target =>
      openDialogRef.current(isSectionId(target.section) ? target.section : undefined),
    )
  }, [])

  useEffect(() => {
    if (open || !triggerRef.current) return
    const trigger = triggerRef.current
    const sidebarAction = triggerSidebarActionRef.current
    triggerRef.current = null
    triggerSidebarActionRef.current = null
    // 在设置中把入口移到另一排后，原按钮已卸载；按动作找到它的新位置。
    const target = trigger.isConnected
      ? trigger
      : sidebarAction
        ? Array.from(document.querySelectorAll<HTMLElement>('[data-sidebar-action]')).find(
            button => button.dataset.sidebarAction === sidebarAction,
          )
        : null
    target?.focus({ preventScroll: true })
  }, [open])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!OPEN_SETTINGS.match(e)) return
      if (
        e.defaultPrevented ||
        e.isComposing ||
        document.activeElement?.closest('[data-terminal-input]') ||
        document.querySelector('[aria-modal="true"]')
      )
        return
      e.preventDefault()
      openSettings()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openSettings])

  const value = useMemo(
    () => ({ open, section, openSettings, closeSettings }),
    [open, section, openSettings, closeSettings],
  )

  return (
    <SettingsContext.Provider value={value}>
      {children}
      {open && (
        <SettingsDialog
          section={section}
          onSectionChange={setSection}
          onClose={closeSettings}
          onPopOut={window.pixelsky?.settingsWindow ? popOut : undefined}
        />
      )}
    </SettingsContext.Provider>
  )
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext)
  if (!value) throw new Error(tr('settings.SettingsProvider.usesettingsMustBeUsed'))
  return value
}
