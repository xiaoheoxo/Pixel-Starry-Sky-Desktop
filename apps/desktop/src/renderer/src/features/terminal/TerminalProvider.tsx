import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useActiveWorkspace } from '@/features/editor/target'
import { getEngineState } from '@/features/engine/store'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { isDemo, projects } from '@/data'
import type { WorkspaceRef } from '../../../../shared/types/workspace'
import {
  initTerminalStore,
  refreshTerminals,
  terminalClose,
  terminalCreate,
  terminalError,
  terminalRename,
  terminalRestart,
  terminalRunWhenReady,
  terminalState,
  useTerminalStore,
} from './store'
import { screens } from './screens'
import { exitSuffix, TaskCommandError } from '@/features/coding/tasks/model'
import { openRightTab } from '@/features/panel/workspaceStore'
import { workspaceTerminals } from './workspace'
import { getMachines, machineOf, selectMachine } from '@/features/machines/store'
import { getPage, showWorkbench } from '@/features/layout/page'
import { NEW_TERMINAL, TOGGLE_TERMINAL } from '@/features/layout/shortcuts'
import { getAppMode } from '@/features/coding/mode'
import { codingLayout, getCodingLayout } from '@/features/coding/layoutStore'

type Action = 'rename' | 'close' | 'restart' | 'search' | 'clear'
/** 左右分屏（docs/ui/files-search-terminal-pins.md §4.1）：两个终端 id 和左边所占比例 */
export interface TerminalSplit {
  left: string
  right: string
  ratio: number
}
interface TerminalUi {
  workspacePath: string
  open: boolean
  maximized: boolean
  activeId: string | null
  projectId: string | null
  height: number
  toggle(): void
  reveal(openDock?: boolean): void
  focus(): void
  toggleMaximize(): void
  select(id: string): void
  selectProject(id: string): void
  setHeight(value: number): void
  create(ref?: WorkspaceRef | null, profileId?: string): Promise<boolean>
  request(action: Action, id?: string): Promise<boolean>
  paste(id: string, text: string): void
  searchId: string | null
  stopSearch(): void
  split: TerminalSplit | null
  /** 新建一个终端放到右边（已分屏时替换右边） */
  splitRight(): Promise<void>
  /** 把已有的终端放到右边 */
  showRight(id: string): void
  unsplit(): void
  setSplitRatio(ratio: number): void
  /** 新建终端并运行一条项目脚本命令（标题用脚本名） */
  runScript(name: string, command: string): Promise<void>
  /**
   * 跑「任务」视图里的任务（docs/ui/coding-tasks.md §3）：reuseId 还在就复用它（已退出的先重启），否则新建；
   * 标题改成任务名，选中并显示，命令后面接「跑完退出带退出码」的后缀。返回终端 id，失败 null。
   * command 可以是函数：按终端程序给出命令（Gradle 在 cmd 里写法不同）。
   * onSent：命令真正写进终端之后调用（比返回晚，要等 shell 的提示符画完）
   */
  runTask(
    name: string,
    command: string | ((program: string | undefined) => string),
    reuseId?: string | null,
    onSent?: (id: string) => void,
  ): Promise<string | null>
}
interface Dialog {
  kind: 'rename' | 'close' | 'restart' | 'paste'
  id: string
  value: string
  generation: number
  resolve: (ok: boolean) => void
}
const Context = createContext<TerminalUi | null>(null)
const key = isDemo ? 'pixelsky.terminal.ui.demo' : 'pixelsky.terminal.ui'
const clampRatio = (ratio: number): number => Math.min(0.8, Math.max(0.2, ratio))
function readSplit(v: unknown): TerminalSplit | null {
  const s = v as Partial<TerminalSplit> | null
  return s && typeof s.left === 'string' && typeof s.right === 'string' && s.left !== s.right
    ? { left: s.left, right: s.right, ratio: typeof s.ratio === 'number' ? clampRatio(s.ratio) : 0.5 }
    : null
}
function read(): {
  open: boolean
  projectId: string | null
  activeId: string | null
  height: number
  split: TerminalSplit | null
} {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '{}')
    return {
      open: v.open === true,
      projectId: typeof v.projectId === 'string' ? v.projectId : null,
      activeId: typeof v.activeId === 'string' ? v.activeId : null,
      height: typeof v.height === 'number' ? Math.max(160, Math.min(620, v.height)) : 280,
      split: readSplit(v.split),
    }
  } catch {
    return { open: false, projectId: null, activeId: null, height: 280, split: null }
  }
}
export function TerminalProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n(),
    workspace = useActiveWorkspace(),
    state = useTerminalStore()
  const [ui, setUi] = useState(read),
    [maximized, setMaximized] = useState(false),
    [searchId, setSearch] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null),
    [value, setValue] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const creating = useRef(false),
    returning = useRef<HTMLElement | null>(null)
  const projectOf = (ref: WorkspaceRef | null): string | null => {
    if (!ref) return null
    if (ref.projectId) return ref.projectId
    if (isDemo) return projects.find(p => p.sessions.some(s => s.id === ref.sessionId))?.id ?? null
    const engine = getEngineState()
    return (
      engine.snapshots[ref.sessionId!]?.record.projectId ??
      engine.sessions.find(s => s.record.id === ref.sessionId)?.record.projectId ??
      null
    )
  }
  useEffect(() => {
    void initTerminalStore()
  }, [])
  useEffect(() => {
    const projectId = projectOf(workspace.ref)
    const items = workspaceTerminals(state.terminals, projectId, workspace.path, window.pixelsky?.platform === 'win32')
    setUi(v => ({
      ...v,
      projectId,
      activeId: items.some(t => t.id === v.activeId) ? v.activeId : (items[0]?.id ?? null),
    }))
  }, [workspace.path, workspace.ref?.projectId, workspace.ref?.sessionId])
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(ui))
    } catch {}
  }, [ui])
  useEffect(() => {
    if (!state.ready) return
    if (!ui.activeId || !state.terminals.some(r => r.id === ui.activeId)) {
      const next =
        workspaceTerminals(
          state.terminals,
          ui.projectId,
          projectOf(workspace.ref) === ui.projectId ? workspace.path : '',
          window.pixelsky?.platform === 'win32',
        )[0]?.id ?? null
      if (ui.activeId !== next) setUi(v => ({ ...v, activeId: next }))
    }
    if (!ui.projectId && workspace.ref) setUi(v => ({ ...v, projectId: projectOf(workspace.ref) }))
    // 分屏里的任一终端已关闭：退回单屏
    if (ui.split && ![ui.split.left, ui.split.right].every(id => state.terminals.some(r => r.id === id)))
      setUi(v => ({ ...v, split: null }))
  }, [state.ready, state.terminals, ui.projectId, ui.activeId, ui.split, workspace.key])
  const select = useCallback((id: string): void => {
    const r = terminalState().terminals.find(r => r.id === id)
    if (!r) return
    const machine = machineOf(r.projectId)
    if (machine !== getMachines().currentId) {
      // 切好了才再选一次：万一没切到也不会反复重试（原来切换中会陷入死循环，审查报告 2026-10-14 第 5 条）
      void selectMachine(machine)
        .then(() => {
          if (getMachines().currentId === machine) select(id)
        })
        .catch(terminalError)
      return
    }
    setUi(v => {
      // 分屏时选一个不在两边的终端：换掉当前聚焦的那一边
      const split =
        v.split && id !== v.split.left && id !== v.split.right
          ? v.activeId === v.split.right
            ? { ...v.split, right: id }
            : { ...v.split, left: id }
          : v.split
      return { ...v, activeId: id, projectId: r.projectId, open: true, split }
    })
    openRightTab('terminal')
    requestAnimationFrame(() => screens.get(id)?.focus())
  }, [])
  const defaultRef = (): WorkspaceRef | null =>
    workspace.ref && projectOf(workspace.ref) === ui.projectId
      ? workspace.ref
      : ui.projectId
        ? { projectId: ui.projectId }
        : workspace.ref
  const create = async (ref: WorkspaceRef | null = defaultRef(), profileId?: string): Promise<boolean> => {
    if (creating.current) return false
    if (!ref) {
      terminalError(new Error(t('terminal.chooseProject')))
      setUi(v => ({ ...v, open: true }))
      return false
    }
    creating.current = true
    terminalError(null)
    try {
      const record = await terminalCreate(ref, profileId)
      select(record.id)
      return record.status === 'running'
    } catch (cause) {
      terminalError(cause)
      return false
    } finally {
      creating.current = false
    }
  }
  const reveal = (openDock = true): void => {
    if (openDock) openRightTab('terminal')
    setUi(v => ({ ...v, open: true }))
    if (ui.activeId) requestAnimationFrame(() => screens.get(ui.activeId!)?.focus())
  }
  const toggle = (): void => {
    // 代码模式：底栏开着而且停在终端标签时收起底栏；否则往下走「选中或新建」，openRightTab 会路由成 showBottom
    const code = getAppMode() === 'code'
    if (code) {
      const bottom = getCodingLayout().bottom
      if (bottom.open && bottom.tab === 'terminal') {
        codingLayout.setOpen('bottom', false)
        return
      }
    }
    if (ui.open && !code) {
      setUi(v => ({ ...v, open: false }))
      setMaximized(false)
      window.dispatchEvent(new Event('pixelsky:hide-terminal'))
      requestAnimationFrame(() => {
        if (returning.current?.isConnected) returning.current.focus({ preventScroll: true })
      })
      return
    }
    returning.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const projectId = ui.projectId ?? projectOf(workspace.ref)
    setUi(v => ({ ...v, projectId, open: true }))
    openRightTab('terminal')
    const existing =
      state.terminals.find(r => r.id === ui.activeId) ??
      workspaceTerminals(
        state.terminals,
        projectId,
        projectOf(workspace.ref) === projectId ? workspace.path : '',
        window.pixelsky?.platform === 'win32',
      )[0]
    if (existing) select(existing.id)
    else if (projectId && state.ready)
      void create(workspace.ref && projectOf(workspace.ref) === projectId ? workspace.ref : { projectId })
  }
  const focus = (): void => {
    if (!ui.open) toggle()
    else if (ui.activeId) screens.get(ui.activeId)?.focus()
  }
  const request = async (kind: Action, id = ui.activeId ?? ''): Promise<boolean> => {
    const record = terminalState().terminals.find(r => r.id === id)
    if (!record || dialog) return false
    if (kind === 'clear') {
      screens.get(id)?.clear()
      return true
    }
    if (kind === 'search') {
      setUi(v => ({ ...v, activeId: id, projectId: record.projectId, open: true }))
      setSearch(id)
      openRightTab('terminal')
      return true
    }
    if ((kind === 'close' || kind === 'restart') && !['running', 'starting'].includes(record.status)) {
      try {
        if (kind === 'close') await terminalClose(id)
        else {
          await terminalRestart(id)
          select(id)
        }
        return true
      } catch (cause) {
        terminalError(cause)
        return false
      }
    }
    return new Promise<boolean>(resolve => {
      setValue(record.title)
      setError(null)
      setDialog({ kind, id, value: record.title, generation: record.generation, resolve })
    })
  }
  const paste = (id: string, text: string): void => {
    const record = terminalState().terminals.find(r => r.id === id)
    if (!record || record.status !== 'running') return
    if (text.length > 256 * 1024) {
      terminalError(new Error(t('terminal.inputLimit')))
      return
    }
    if (/[\r\n]/.test(text)) {
      if (!dialog) {
        setError(null)
        setDialog({ kind: 'paste', id, value: text, generation: record.generation, resolve: () => {} })
      }
    } else screens.get(id)?.paste(text)
  }
  const finish = (ok: boolean): void => {
    dialog?.resolve(ok)
    setDialog(null)
    setBusy(false)
    setError(null)
    if (dialog) requestAnimationFrame(() => screens.get(dialog.id)?.focus())
  }
  const confirm = async (): Promise<void> => {
    if (!dialog || busy) return
    setBusy(true)
    setError(null)
    try {
      const record = terminalState().terminals.find(r => r.id === dialog.id)
      if (!record) throw new Error(t('terminal.missing'))
      if (dialog.kind === 'rename') {
        // eslint-disable-next-line no-control-regex -- 故意匹配控制字符，拒绝包含换行等控制字符的标题
        if (!value.trim() || [...value.trim()].length > 120 || /[\u0000-\u001f\u007f]/.test(value))
          throw new Error(t('terminal.invalidTitle'))
        await terminalRename(dialog.id, value.trim())
      } else if (dialog.kind === 'paste') {
        if (record.generation !== dialog.generation || record.status !== 'running')
          throw new Error(t('terminal.changed'))
        screens.get(dialog.id)?.paste(dialog.value)
      } else {
        if (record.generation !== dialog.generation) throw new Error(t('terminal.changed'))
        if (dialog.kind === 'close') await terminalClose(dialog.id, true)
        else await terminalRestart(dialog.id, true)
      }
      finish(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // 显示 / 隐藏终端、新建终端：可以自定义（docs/ui/custom-shortcuts.md）
      const isNew = NEW_TERMINAL.match(event)
      if (
        (!isNew && !TOGGLE_TERMINAL.match(event)) ||
        event.isComposing ||
        document.querySelector('[aria-modal="true"]')
      )
        return
      event.preventDefault()
      event.stopPropagation()
      if (isNew)
        void create(
          document.activeElement?.closest('[data-terminal-input]') && ui.projectId
            ? { projectId: ui.projectId }
            : workspace.ref,
        )
      // 协作频道页时终端不可见：切回工作台显示它，而不是悄悄收起
      else if (ui.open && getPage() !== 'workbench') {
        showWorkbench()
        reveal()
      } else toggle()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  const splitRight = async (): Promise<void> => {
    const left = ui.split ? ui.split.left : ui.activeId
    const ref = defaultRef()
    if (!left || !ref || creating.current) return
    creating.current = true
    terminalError(null)
    try {
      const record = await terminalCreate(ref)
      setUi(v => ({
        ...v,
        activeId: record.id,
        open: true,
        split: { left, right: record.id, ratio: v.split?.ratio ?? 0.5 },
      }))
      openRightTab('terminal')
      requestAnimationFrame(() => screens.get(record.id)?.focus())
    } catch (cause) {
      terminalError(cause)
    } finally {
      creating.current = false
    }
  }
  const showRight = (id: string): void => {
    setUi(v => {
      const left = v.activeId && v.activeId !== id ? v.activeId : v.split?.left
      if (!left || left === id) return v
      return { ...v, activeId: id, split: { left, right: id, ratio: v.split?.ratio ?? 0.5 } }
    })
    requestAnimationFrame(() => screens.get(id)?.focus())
  }
  const runScript = async (name: string, command: string): Promise<void> => {
    const ref = defaultRef()
    if (!ref || creating.current) return
    creating.current = true
    terminalError(null)
    try {
      const record = await terminalCreate(ref)
      select(record.id)
      await terminalRename(record.id, name).catch(() => undefined)
      terminalRunWhenReady(record.id, command)
    } catch (cause) {
      terminalError(cause)
    } finally {
      creating.current = false
    }
  }
  const runTask = async (
    name: string,
    command: string | ((program: string | undefined) => string),
    reuseId?: string | null,
    onSent?: (id: string) => void,
  ): Promise<string | null> => {
    const ref = defaultRef()
    if (!ref || creating.current) return null
    creating.current = true
    terminalError(null)
    try {
      let record = reuseId ? terminalState().terminals.find(r => r.id === reuseId) : undefined
      if (record && record.status !== 'running' && record.status !== 'starting') {
        await terminalRestart(record.id)
        record = terminalState().terminals.find(r => r.id === reuseId)
      }
      const created = !record
      // 新建终端之前先按默认 Shell 拼一次：cmd 下含 % 之类拼不出来的，不必建一个马上关掉的终端（实际 Shell 不同时下面还会再拼一次）
      if (created && typeof command === 'function') {
        const state = terminalState()
        command(state.profiles.find(p => p.id === state.defaultProfileId)?.command)
      }
      record ??= await terminalCreate(ref)
      const profileOf = (id: string) => terminalState().profiles.find(p => p.id === id)
      // 第一次启动没有缓存时，主进程检测完才建终端，界面的 Shell 列表可能还没取回来
      if (!profileOf(record.profileId)) await refreshTerminals().catch(() => undefined)
      const program = profileOf(record.profileId)?.command
      let line: string
      try {
        line = typeof command === 'function' ? command(program) : command
      } catch (cause) {
        // 命令拼不出来（cmd 下路径含 %）：新建的终端用不上，关掉；错误交给调用方提示，不当终端故障
        if (created) await terminalClose(record.id).catch(() => undefined)
        throw cause
      }
      select(record.id)
      await terminalRename(record.id, name).catch(() => undefined)
      const id = record.id
      terminalRunWhenReady(id, isDemo ? line : line + exitSuffix(program), () => onSent?.(id))
      return id
    } catch (cause) {
      if (cause instanceof TaskCommandError) throw cause
      terminalError(cause)
      return null
    } finally {
      creating.current = false
    }
  }
  const context: TerminalUi = {
    ...ui,
    runTask,
    splitRight,
    showRight,
    runScript,
    unsplit: () => setUi(v => ({ ...v, split: null })),
    setSplitRatio: ratio => setUi(v => (v.split ? { ...v, split: { ...v.split, ratio: clampRatio(ratio) } } : v)),
    workspacePath: projectOf(workspace.ref) === ui.projectId ? workspace.path : '',
    maximized,
    toggle,
    reveal,
    focus,
    select,
    create,
    request,
    paste,
    searchId,
    stopSearch: () => {
      if (searchId) {
        screens.get(searchId)?.endSearch()
        screens.get(searchId)?.focus()
      }
      setSearch(null)
    },
    toggleMaximize: () => {
      setUi(v => ({ ...v, open: true }))
      setMaximized(v => !v)
    },
    setHeight: height => setUi(v => ({ ...v, height })),
    selectProject: id => {
      setUi(v => ({ ...v, projectId: id, activeId: state.terminals.find(r => r.projectId === id)?.id ?? null }))
    },
  }
  return (
    <Context.Provider value={context}>
      {children}
      {dialog && (
        <ConfirmDialog
          title={t(
            dialog.kind === 'rename'
              ? 'terminal.rename'
              : dialog.kind === 'paste'
                ? 'terminal.pasteTitle'
                : dialog.kind === 'restart'
                  ? 'terminal.restartTitle'
                  : 'terminal.closeRunningTitle',
          )}
          description={
            dialog.kind === 'rename' ? (
              <input
                aria-label={t('terminal.renamePrompt')}
                value={value}
                onChange={e => setValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void confirm()
                  }
                }}
                className="w-full rounded-md border border-line bg-surface px-3 py-2 text-ui text-fg outline-none focus:border-accent"
              />
            ) : dialog.kind === 'paste' ? (
              <>
                <p>{t('terminal.pasteHint')}</p>
                <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-subtle p-3 text-meta">
                  {dialog.value}
                </pre>
              </>
            ) : (
              t('terminal.closeRunningDescription')
            )
          }
          confirmLabel={t(
            dialog.kind === 'rename'
              ? 'terminal.save'
              : dialog.kind === 'paste'
                ? 'terminal.paste'
                : dialog.kind === 'restart'
                  ? 'terminal.restart'
                  : 'terminal.close',
          )}
          cancelLabel={t('terminal.cancel')}
          busy={busy}
          error={error}
          danger={dialog.kind === 'close' || dialog.kind === 'restart'}
          focusInput={dialog.kind === 'rename'}
          onConfirm={() => void confirm()}
          onCancel={() => finish(false)}
        />
      )}
    </Context.Provider>
  )
}
/** 没有 TerminalProvider 的窗口（设置独立窗口）里返回 null */
export function useOptionalTerminalUi(): TerminalUi | null {
  return useContext(Context)
}
export function useTerminalUi(): TerminalUi {
  const value = useContext(Context)
  if (!value) throw new Error('TerminalProvider missing')
  return value
}
