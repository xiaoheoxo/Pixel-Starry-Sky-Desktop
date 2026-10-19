// 设置独立窗口的界面根（docs/ui/settings-window.md §3.2）：由 app/startSettings.tsx 挂载。
// 只带设置页用得上的：引擎状态、机器、终端的 Shell 列表、授权弹窗；主界面那一套（会话、通知分发、首次打开页、
// 更新提示、设置云同步、全局快捷键）都不挂，免得两个窗口各响一次、各推一次。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { AuthDialogHost } from '@/features/model-channels/AuthDialog'
import { refreshMachineEngine } from '@/features/engine/store'
import { useEngineBoot } from '@/features/engine/hooks'
import { initMachines, useMachines } from '@/features/machines/store'
import { initTerminalStore, refreshTerminals } from '@/features/terminal/store'
import type { SettingsTarget } from '../../../../shared/types/settings-window'
import { SettingsContext, type SettingsContextValue } from './SettingsProvider'
import { isSectionId, type SectionId } from './SettingsContent'
import { SettingsWindow } from './SettingsWindow'
import { requestSettingsRow } from './settingsJump'
import { applySettingsHints } from './windowHints'
import { startSettingsWindowSync } from './windowBridge'

/** 打开窗口时主进程把要跳到哪放在地址的 target 参数里（JSON）；读不出来就当没有 */
function initialTarget(): SettingsTarget {
  try {
    const raw = new URLSearchParams(location.search).get('target')
    const value: unknown = raw ? JSON.parse(raw) : null
    return value && typeof value === 'object' ? (value as SettingsTarget) : {}
  } catch {
    return {}
  }
}

/** 记下要高亮的行、放回「先记一笔」的请求，返回要停在哪个分区 */
function takeTarget(target: SettingsTarget): SectionId | null {
  applySettingsHints(target.hints)
  if (target.row) requestSettingsRow(target.row)
  return isSectionId(target.section) ? target.section : null
}

export function SettingsWindowApp() {
  useI18n()
  useEngineBoot()
  const [section, setSection] = useState<SectionId>(() => takeTarget(initialTarget()) ?? 'appearance')
  // 已经开着时又要跳到某一行：数字变一次，内容里再取一次 takeSettingsRow
  const [jumpToken, setJumpToken] = useState(0)

  useEffect(() => {
    startSettingsWindowSync()
    void initMachines().catch(() => undefined)
    void initTerminalStore().catch(() => undefined)
  }, [])

  // 别处（主窗口的任何入口）又要打开设置：窗口已经开着，主进程把它提到前面后推来要跳到哪
  useEffect(
    () =>
      window.pixelsky?.settingsWindow.onNavigate(target => {
        const next = takeTarget(target)
        if (next) setSection(next)
        setJumpToken(n => n + 1)
      }),
    [],
  )

  // 主窗口切了机器：当前机器在主进程、全局一份，这边的项目、会话、终端 Shell 列表要跟着重新取
  const { currentId } = useMachines()
  const seen = useRef(currentId)
  useEffect(() => {
    if (seen.current === currentId) return
    seen.current = currentId
    void refreshMachineEngine(currentId).catch(() => undefined)
    void refreshTerminals().catch(() => undefined)
  }, [currentId])

  const openSettings = useCallback((target?: SectionId) => {
    setSection(target ?? 'appearance')
    setJumpToken(n => n + 1)
  }, [])
  const value = useMemo<SettingsContextValue>(
    // 设置页里调 openSettings 就是在本窗口切分区；closeSettings 不关窗口（浮层里「做完关掉设置」的那几处在这里不适用）
    () => ({ open: true, section, openSettings, closeSettings: () => undefined }),
    [section, openSettings],
  )

  return (
    <SettingsContext.Provider value={value}>
      <SettingsWindow section={section} onSectionChange={setSection} jumpToken={jumpToken} />
      <AuthDialogHost />
    </SettingsContext.Provider>
  )
}
