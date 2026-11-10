// 会话界面 ⇄ 终端（TUI）切换的 React hook / IPC（docs/ui/tui-toggle.md）
import { useCallback, useEffect, useState, useSyncExternalStore, type RefObject } from 'react'
import { isChatProject } from '@pixelsky/protocol'
import { isDemo } from '@/data'
import { matchesAction } from '@/features/layout/keybindings'
import { machineOf } from '@/features/machines/store'
import { keyForConversation } from '@/features/search/ConversationFind'
import { useSession } from '@/features/engine'
import { getEngineState, updateDemoSnapshot } from '@/features/engine/store'
import { forgetTerminal, terminalState, useTerminalStore } from '@/features/terminal/store'
import { useToast } from '@/ui'
import { openResumePicker } from '@/features/resume/store'
import { tr } from '@/i18n/core'
import {
  DEMO_TUI_TERMINAL_ID,
  isTuiRunningError,
  tuiDisabledReason,
  tuiBlockKey,
  tuiConfirm,
  tuiModeOf,
  tuiToggleVisible,
  type TuiMode,
} from './tuiMode'

export async function checkTui(sessionId: string): Promise<string | null> {
  if (isDemo) return null
  const api = window.pixelsky?.engine
  if (!api?.tuiCheck) return null
  try {
    return tuiBlockKey(await api.tuiCheck(sessionId))
  } catch {
    return null
  }
}

export async function openTui(sessionId: string): Promise<{ terminalId: string }> {
  if (isDemo) {
    updateDemoSnapshot(sessionId, snap => ({
      ...snap,
      record: { ...snap.record, tui: { terminalId: DEMO_TUI_TERMINAL_ID, since: Date.now() } },
    }))
    return { terminalId: DEMO_TUI_TERMINAL_ID }
  }
  const api = window.pixelsky?.engine
  if (!api?.tuiOpen) throw new Error(tr('session.tui.unavailable'))
  return api.tuiOpen(sessionId)
}

export async function closeTui(sessionId: string, force = false): Promise<{ added: number; mismatched: boolean }> {
  if (isDemo) {
    updateDemoSnapshot(sessionId, snap => ({
      ...snap,
      record: { ...snap.record, tui: null },
    }))
    return { added: 0, mismatched: false }
  }
  const api = window.pixelsky?.engine
  if (!api?.tuiClose) throw new Error(tr('session.tui.unavailable'))
  const terminalId = getEngineState().snapshots[sessionId]?.record.tui?.terminalId
  const result = await api.tuiClose(sessionId, { force })
  if (terminalId) forgetTerminal(terminalId)
  return result
}

/** 顶栏 / 会话共用的 TUI 开关状态（窗格里 SessionView 是 embedded，顶栏在 WorkspaceHeader） */
export function useTuiToggle(
  sessionId: string | null,
  /**
   * 这个对话区：Alt+T 只给按在它里面（或它是最近用过的）的那个对话，不是所有挂着的对话一起切。
   * 顶栏那份不传：快捷键只由对话区那份监听，免得同一个对话被切两次
   */
  main?: RefObject<HTMLElement | null>,
): {
  mode: TuiMode
  running: boolean
  disabledReason: string | null
  busy: boolean
  confirm: boolean
  setConfirm: (v: boolean) => void
  onChange: (mode: TuiMode) => void
  forceClose: () => void
  terminalId: string | null
  visible: boolean
} | null {
  const snapshot = useSession(sessionId)
  const toast = useToast()
  const terminals = useTerminalStore()
  const [busy, setBusy] = useState(false)
  const confirm = useSyncExternalStore(tuiConfirm.subscribe, () => !!sessionId && tuiConfirm.has(sessionId))
  const setConfirm = useCallback(
    (on: boolean) => {
      if (sessionId) tuiConfirm.set(sessionId, on)
    },
    [sessionId],
  )
  const record = snapshot?.record
  // 远程机器（SSH / WSL）上的对话不开放（§3.1）
  const visible = tuiToggleVisible(record) && !!sessionId && machineOf(sessionId) === 'local'
  const mode = tuiModeOf(record)
  const terminalId = record?.tui?.terminalId || null
  const tuiTerminal = terminalId ? (terminals.terminals.find(t => t.id === terminalId) ?? null) : null
  const baseDisabled = tuiDisabledReason(snapshot)
  const [liveDisabled, setLiveDisabled] = useState<string | null>(null)
  const disabledReason = busy ? 'session.tui.switching' : (baseDisabled ?? liveDisabled)

  useEffect(() => {
    if (!sessionId || !visible || mode === 'terminal' || baseDisabled || isDemo) {
      setLiveDisabled(null)
      return
    }
    let cancelled = false
    const run = (): void => {
      void checkTui(sessionId).then(reason => {
        if (!cancelled) setLiveDisabled(reason)
      })
    }
    run()
    const timer = window.setInterval(run, 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [sessionId, visible, mode, baseDisabled, snapshot?.record.engineSessionId])

  // 终端里的会话和这里对不上（/rewind、/clear 过）：不猜，给「从 /resume 导入」打开现有的选择器（§3.3）
  const projectId = record?.projectId ?? null
  const mismatch = useCallback(
    () =>
      toast(tr('session.tui.mismatch'), {
        duration: 15_000,
        // 聊天没有项目文件夹，Claude 的选择框列不出东西：不给导入按钮
        ...(isChatProject(projectId)
          ? {}
          : {
              action: {
                label: tr('session.tui.importResume'),
                run: () => openResumePicker({ engine: 'claude', projectId }),
              },
            }),
      }),
    [toast, projectId],
  )

  const onChange = useCallback(
    async (next: TuiMode) => {
      if (!sessionId || busy) return
      if (next === 'terminal') {
        if (disabledReason) return
        setBusy(true)
        try {
          await openTui(sessionId)
          void terminalState()
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
        return
      }
      setBusy(true)
      try {
        const result = await closeTui(sessionId, false)
        if (result.mismatched) mismatch()
      } catch (err) {
        if (isTuiRunningError(err)) setConfirm(true)
        else toast(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [sessionId, busy, disabledReason, toast, mismatch, setConfirm],
  )

  const forceClose = useCallback(() => {
    if (!sessionId) return
    setConfirm(false)
    setBusy(true)
    void closeTui(sessionId, true)
      .then(result => {
        if (result.mismatched) mismatch()
      })
      .catch(err => toast(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }, [sessionId, toast, mismatch, setConfirm])

  useEffect(() => {
    if (!sessionId || !visible || !main) return
    const onKey = (e: KeyboardEvent) => {
      const el = main.current
      if (!matchesAction('toggleTuiMode', e) || !el || !keyForConversation(el, e)) return
      if (disabledReason && mode === 'ui') return
      e.preventDefault()
      void onChange(mode === 'ui' ? 'terminal' : 'ui')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [sessionId, visible, mode, disabledReason, onChange, main])

  if (!sessionId || !visible) return null
  return {
    mode,
    running: tuiTerminal?.status === 'running' || (isDemo && mode === 'terminal'),
    disabledReason,
    busy,
    confirm,
    setConfirm,
    onChange: mode => void onChange(mode),
    forceClose,
    terminalId,
    visible: true,
  }
}
