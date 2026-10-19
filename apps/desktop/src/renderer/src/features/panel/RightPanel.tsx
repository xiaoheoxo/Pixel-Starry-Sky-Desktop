import { machineOf, useMachines } from '@/features/machines/store'
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { BrowserTab } from './BrowserTab'
import { TasksPanel } from './TasksPanel'
import { EnvironmentPanel, OPEN_BROWSER } from './EnvironmentPanel'
import { CopiesPanel } from './CopiesPanel'
import { ConnectorsPanel } from './connectors/ConnectorsPanel'
import { GitPanel } from './git/GitPanel'
import { ArtifactsPanel } from './artifacts/ArtifactsPanel'
import { FileTree } from '@/features/files/FileTree'
import { OPEN_FILES_EVENT, activateFile, ensureFile, getFiles, removeFile, useFiles } from '@/features/files/store'
import { confirmFiles } from '@/features/files/FileConfirm'
import { FileEditor } from '@/features/editor/FileEditor'
import { useActiveWorkspace } from '@/features/editor/target'
import { TerminalPanel } from '@/features/terminal/TerminalPanel'
import { useTerminalUi } from '@/features/terminal/TerminalProvider'
import { terminalState } from '@/features/terminal/store'
import { workspaceTerminals } from '@/features/terminal/workspace'
import { paneActions } from '@/features/panes/store'
import { isFileTab, parseFileTab } from '@/features/panes/tree'
import type { WorkspaceRef } from '../../../../shared/types/workspace'
import { WorkspaceTabs } from './WorkspaceTabs'
import { ToolLauncher } from './ToolLauncher'
import { recordRecentFile } from './recentFiles'
import {
  detachPanelFile,
  forgetPanelTabs,
  getPanelLayout,
  OPEN_RIGHT_WORKSPACE,
  selectPanelTab,
  setPanelScope,
  usePanelLayout,
} from './workspaceStore'

/** One dock owns the right-side tools; file and PTY state remain in their existing stores. */
export function RightPanel({ maximized = false, visible = true }: { maximized?: boolean; visible?: boolean }) {
  const { t } = useI18n(),
    workspace = useActiveWorkspace(),
    terminal = useTerminalUi(),
    files = useFiles()
  const normalizedPath = workspace.path.replaceAll('\\', '/')
  const machineState = useMachines(),
    machine = workspace.ref ? machineOf(workspace.ref.projectId ?? workspace.ref.sessionId) : machineState.currentId
  const localScope = normalizedPath
    ? machine === 'local' && window.pixelsky?.platform === 'win32'
      ? normalizedPath.toLowerCase()
      : normalizedPath
    : workspace.key
  const scope = machine === 'local' ? localScope : machine + ':' + localScope
  setPanelScope(scope)
  const layout = usePanelLayout(scope)
  const [busy, setBusy] = useState(false),
    working = useRef(false)
  const [requested, setRequested] = useState<WorkspaceRef | null>(null)
  const [browserRequest, setBrowserRequest] = useState<{ ref: WorkspaceRef; url: string; seq: number } | null>(null)
  const [visited, setVisited] = useState(new Set<string>())
  useEffect(() => {
    setRequested(null)
    setBrowserRequest(null)
  }, [scope])
  useEffect(() => {
    if (layout.active) setVisited(old => new Set([...old, layout.active!]))
    for (const id of layout.tabs.filter(isFileTab)) void ensureFile(id)
    if (layout.active && isFileTab(layout.active)) {
      activateFile(layout.active)
      recordRecentFile(scope, layout.active)
    }
  }, [layout, scope])
  useEffect(() => {
    const show = (e: Event) => {
      const detail = (e as CustomEvent<{ ref?: WorkspaceRef }>).detail
      setRequested(detail?.ref ?? null)
      selectPanelTab(scope, 'files')
    }
    const browser = (e: Event) => {
      const detail = (e as CustomEvent<{ ref: WorkspaceRef; url: string }>).detail
      setBrowserRequest({ ...detail, seq: Date.now() })
      selectPanelTab(scope, 'browser')
    }
    const task = () => selectPanelTab(scope, 'tasks')
    const hideTerminal = () => {
      if (getPanelLayout(scope).active === 'terminal') selectPanelTab(scope, 'files')
    }
    const opened = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string; scope: string }>).detail
      if (detail.scope === scope && detail.id === 'terminal') terminal.reveal(false)
    }
    window.addEventListener('pixelsky:hide-terminal', hideTerminal)
    window.addEventListener(OPEN_FILES_EVENT, show)
    window.addEventListener(OPEN_BROWSER, browser)
    window.addEventListener('pixelsky:open-task', task)
    window.addEventListener(OPEN_RIGHT_WORKSPACE, opened)
    return () => {
      window.removeEventListener('pixelsky:hide-terminal', hideTerminal)
      window.removeEventListener(OPEN_FILES_EVENT, show)
      window.removeEventListener(OPEN_BROWSER, browser)
      window.removeEventListener('pixelsky:open-task', task)
      window.removeEventListener(OPEN_RIGHT_WORKSPACE, opened)
    }
  }, [scope, terminal.reveal])
  const select = (id: string) => {
    if (id === 'terminal') terminal.reveal(false)
    selectPanelTab(scope, id)
  }
  const close = async (ids: string[]) => {
    if (working.current) return
    const targetScope = scope
    working.current = true
    setBusy(true)
    try {
      let discard: (() => void) | undefined
      if (
        !(await confirmFiles(ids.filter(isFileTab), t('workspace.close'), apply => {
          discard = apply
        }))
      )
        return
      const drafts = getFiles()
        .tabs.filter(f => ids.includes(f.id))
        .map(f => [f.id, f.draft] as const)
      if (ids.includes('terminal')) {
        for (const item of workspaceTerminals(
          terminalState().terminals,
          terminal.projectId,
          terminal.workspacePath,
          window.pixelsky?.platform === 'win32',
        ))
          if (!(await terminal.request('close', item.id))) return
      }
      // Never discard edits made while another confirmation was pending.
      if (drafts.some(([id, draft]) => getFiles().tabs.find(f => f.id === id)?.draft !== draft)) return
      discard?.()
      // Recheck after asynchronous confirmations; only close tabs from the originating scope.
      const actual = ids.filter(id => getPanelLayout(targetScope).tabs.includes(id))
      forgetPanelTabs(targetScope, actual)
      actual.filter(isFileTab).forEach(removeFile)
      if (actual.includes('terminal') && terminal.open) terminal.toggle()
    } finally {
      working.current = false
      setBusy(false)
    }
  }
  const moveFile = (id: string) => {
    detachPanelFile(id)
    paneActions.openFileTab(id)
  }
  const activeFile = files.tabs.find(f => f.id === layout.active)
  const parsed = layout.active ? parseFileTab(layout.active) : null
  return (
    <aside
      data-right-workspace
      className="relative flex h-full min-h-0 w-full min-w-0 flex-col border-l border-line-layout bg-panel"
      onKeyDown={e => {
        if (
          e.defaultPrevented ||
          e.nativeEvent.isComposing ||
          document.querySelector('[aria-modal="true"]') ||
          (e.target as HTMLElement).closest('[data-terminal-input]')
        )
          return
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'w' && layout.active) {
          e.preventDefault()
          e.stopPropagation()
          void close([layout.active])
        }
      }}
    >
      <WorkspaceTabs
        layout={layout}
        maximized={maximized}
        busy={busy}
        onSelect={select}
        onClose={ids => void close(ids)}
        onMoveFile={moveFile}
      />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {parsed && layout.active && (
          <FileEditor
            key={layout.active}
            id={layout.active}
            active={visible}
            explorer={
              <FileTree
                key={JSON.stringify(activeFile?.ref ?? parsed.ref)}
                requested={activeFile?.ref ?? parsed.ref}
                scoped
              />
            }
            onMoveToChat={() => moveFile(layout.active!)}
          />
        )}
        <div
          className={layout.active === 'files' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
          inert={layout.active !== 'files'}
        >
          <FileTree
            key={scope + JSON.stringify(requested)}
            requested={requested ?? workspace.ref}
            scoped
            heading={false}
          />
        </div>
        <TerminalPanel embedded visible={visible && layout.active === 'terminal'} />
        {(['git', 'artifacts', 'tasks', 'sandbox', 'copies', 'connectors', 'browser'] as const).map(
          kind =>
            (visited.has(kind) || layout.active === kind) && (
              <div
                key={kind}
                className={layout.active === kind ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
                inert={layout.active !== kind}
              >
                {kind === 'git' ? (
                  <GitPanel active={visible && layout.active === 'git'} />
                ) : kind === 'artifacts' ? (
                  <ArtifactsPanel active={visible && layout.active === 'artifacts'} />
                ) : kind === 'tasks' ? (
                  <TasksPanel />
                ) : kind === 'sandbox' ? (
                  <EnvironmentPanel />
                ) : kind === 'copies' ? (
                  <CopiesPanel />
                ) : kind === 'connectors' ? (
                  <ConnectorsPanel active={visible && layout.active === 'connectors'} />
                ) : (
                  <BrowserTab
                    requested={browserRequest}
                    onHandled={seq => setBrowserRequest(current => (current?.seq === seq ? null : current))}
                  />
                )}
              </div>
            ),
        )}
        {layout.active === null && <ToolLauncher scope={scope} showRecent={!!workspace.ref} onSelect={select} />}
      </div>
    </aside>
  )
}
