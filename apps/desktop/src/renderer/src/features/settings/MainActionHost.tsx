// 主窗口里执行「设置要主窗口去做的事」（docs/ui/settings-window.md §3.4）：
// 设置在浮层里时，按钮经 runMainAction 发一个窗口事件；设置在独立窗口里时，主进程把主窗口提到前面，再推 mainWindow:action。
// 两种来源走同一段逻辑。要在 TerminalProvider 里面挂（「在终端里授权」要用终端界面）。
import { useEffect, useRef } from 'react'
import { useToast } from '@/ui'
import { OPEN_SESSION_EVENT } from '@/features/engine'
import { openMachineManager, selectMachine } from '@/features/machines/store'
import { openResumeFor } from '@/features/resume/hint'
import { useTerminalUi } from '@/features/terminal/TerminalProvider'
import type { MainWindowAction } from '../../../../shared/types/settings-window'
import { MAIN_ACTION_EVENT } from './windowBridge'

export function MainActionHost() {
  const terminal = useTerminalUi()
  const toast = useToast()
  // 终端界面、提示条的引用每次渲染都可能换：用最新的，不因此重新订阅（订阅空档里来的操作会丢）
  const latest = useRef({ terminal, toast })
  latest.current = { terminal, toast }
  useEffect(() => {
    const run = (action: MainWindowAction): void => {
      switch (action.kind) {
        case 'manageMachines':
          openMachineManager()
          return
        case 'openSession':
          // 由 App 打开对应会话（docs/ui/usage.md §3）
          window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: { sessionId: action.sessionId } }))
          return
        case 'openResume':
          openResumeFor(action.projectId, action.engine)
          return
        case 'selectLocalMachine':
          void selectMachine('local').catch((e: Error) => latest.current.toast(e.message))
          return
        case 'terminalScript':
          void latest.current.terminal
            .runScript(action.name, action.command)
            .then(() => latest.current.terminal.reveal(true))
          return
      }
    }
    const onEvent = (e: Event): void => run((e as CustomEvent<MainWindowAction>).detail)
    window.addEventListener(MAIN_ACTION_EVENT, onEvent)
    const off = window.pixelsky?.settingsWindow?.onMainAction(run)
    return () => {
      window.removeEventListener(MAIN_ACTION_EVENT, onEvent)
      off?.()
    }
  }, [])
  return null
}
