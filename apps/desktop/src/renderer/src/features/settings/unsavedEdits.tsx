import { useEffect, useRef, useSyncExternalStore } from 'react'
import { tr } from '@/i18n/core'
import { ConfirmDialog } from '@/ui/ConfirmDialog'

/**
 * 设置里没保存的改动（子智能体编辑区、插件配置表单……）：关设置（Esc、点遮罩、×）和切分区前问一句，
 * 不直接卸载编辑区把内容丢掉。各编辑区用 useUnsavedCheck 登记「现在有没有没保存的改动」，
 * 外框用 leaveSettings 包住要做的事，SettingsContent 里放一个 UnsavedLeaveDialog 显示确认
 */
const checks = new Set<{ current: () => boolean }>()
let pending: (() => void) | null = null
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach(fn => fn())

export const hasUnsavedEdits = (): boolean => [...checks].some(c => c.current())
/** 刚在确认框里选了放弃：这之后一小会儿关窗（收回到主窗口）不再拦，免得再问一次 */
let discardedAt = 0
const DISCARD_GRACE_MS = 3_000

/**
 * 独立设置窗口：有没保存的改动时拦下关窗（窗口按钮、Ctrl+W、Alt+F4、主窗口带着关、退出软件），
 * 主进程收到 will-prevent-unload 后弹系统确认框（main/app/settings-window.ts）
 */
export function useBlockUnloadWhenUnsaved(): void {
  useEffect(() => {
    const before = (e: BeforeUnloadEvent): void => {
      if (!hasUnsavedEdits() || Date.now() - discardedAt < DISCARD_GRACE_MS) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', before)
    return () => window.removeEventListener('beforeunload', before)
  }, [])
}

/** 有没保存的改动先问；没有就直接做 */
export function leaveSettings(action: () => void): void {
  if (!hasUnsavedEdits()) return action()
  pending = action
  emit()
}

/** 编辑区登记检查函数；卸载时自动撤销 */
export function useUnsavedCheck(check: () => boolean): void {
  const ref = useRef(check)
  ref.current = check
  useEffect(() => {
    checks.add(ref)
    return () => {
      checks.delete(ref)
    }
  }, [])
}

export function UnsavedLeaveDialog() {
  const action = useSyncExternalStore(
    fn => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => pending,
  )
  if (!action) return null
  const clear = (): void => {
    pending = null
    emit()
  }
  return (
    <ConfirmDialog
      title={tr('customApi.discardTitle')}
      description={tr('ui.ConfirmDialog.unsaved')}
      confirmLabel={tr('ui.ConfirmDialog.discard')}
      cancelLabel={tr('ui.ConfirmDialog.keepEditing')}
      busy={false}
      danger
      onConfirm={() => {
        clear()
        discardedAt = Date.now()
        action()
      }}
      onCancel={clear}
    />
  )
}
