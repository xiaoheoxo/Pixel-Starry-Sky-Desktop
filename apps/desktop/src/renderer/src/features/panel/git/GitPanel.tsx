import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CloudDownload,
  FileClock,
  FileCode2,
  GitBranch,
  Minus,
  Plus,
  RefreshCw,
  TriangleAlert,
  Undo2,
  X,
} from 'lucide-react'
import { Button, cn, IconButton, Segmented, Select, Spinner } from '@/ui'
import { useEngineState } from '@/features/engine'
import { folderLabel } from '@/features/files/extraFolderPaths'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { hasCodeOpener, openFile, refreshHeads } from '@/features/files/store'
import { keyRef, refKey } from '@/features/editor/target'
import { gitOpenTarget, routeGitDiff } from '@/features/coding/editor/gitDiffModel'
import { getGitOpenStyle } from '@/features/coding/editor/gitOpenStyle'
import { openWorkFile, useActiveCodeFile } from '@/features/coding/editor/gitWorkOpen'
import {
  openGitDiffTab,
  registerGitFileActions,
  setGitActionsBusy,
  inGitWorkspace,
  noteGitHead,
  setGitFileKey,
  syncGitDiffTabs,
  useCurrentGitDiff,
  workDiffInput,
} from '@/features/coding/editor/gitDiffTabs'
import { machineOf } from '@/features/machines/store'
import { useProjectContext } from '../projectContext'
import { openRightTab } from '../workspaceStore'
import { NoProject, useRemember } from '../ToolsUi'
import { EmptyState, PanelCard } from '../PanelSurface'
import type {
  GitArea,
  GitBranch as Branch,
  GitFailure,
  GitFileChange,
  GitRemedy,
  GitResult,
  GitStatus,
} from '../../../../../shared/types/project-tools'
import type { WorkspaceRef } from '../../../../../shared/types/workspace'
import {
  ago,
  changeCount,
  failureHint,
  failureTitle,
  gitSections,
  needsCommitAll,
  neighbour,
  splitPath,
  type GitSection,
} from './gitModel'
import { GitDiffView } from './GitDiffView'
import type { GitFileActions } from '@/features/coding/editor/gitDiffTabs'
import { AiCommitButton, AiCommitNote, useAiCommit } from './AiCommit'
import { BranchMenu } from './BranchMenu'
import { GitHistory } from './GitHistory'
import { FILE_HISTORY_EVENT, takeFileHistory } from './fileHistory'
import { publishGitStatus, refreshGitStatus, useGitLoadError, useGitRevision, useGitStatus } from './summary'
import { demoApply } from './demoGit'
import { demo as demoData } from '@/data/demo'

/** 命令面板触发的 Git 操作（docs/ui/git-panel.md §6）：先打开 Git 页，状态读到后再执行；history 切到「历史」（§9.1） */
export type GitPaletteAction = 'pull' | 'push' | 'fetch' | 'branch' | 'history' | 'changes'
const GIT_ACTION_EVENT = 'pixelsky:git-action'
let pendingAction: GitPaletteAction | null = null
export function requestGitAction(action: GitPaletteAction): void {
  pendingAction = action
  window.dispatchEvent(new Event(GIT_ACTION_EVENT))
}

/** 面板宽度低于它就用紧凑样式（图标按钮、竖排提交、短占位符、隐藏目录） */
const COMPACT_MAX = 280
const POLL_MS = 15_000
const AUTO_FETCH_MS = 10 * 60_000

export function GitPanel({ active }: { active: boolean }) {
  useI18n()
  const context = useProjectContext()
  // 多文件夹项目（docs/ui/multi-root-projects.md §3.4）：顶上切仓库，0 是主文件夹，N 是第 N 个附加文件夹
  const folders = useEngineState(s => s.projects.find(p => p.id === context.projectId)?.folders)
  const [picked, setPicked] = useState<{ key: string; folder: number }>({ key: '', folder: 0 })
  const folder = picked.key === context.key && folders && picked.folder <= folders.length ? picked.folder : 0
  if (!context.ref && !context.demo) return <NoProject />
  const target = context.ref ? (folder ? { ...context.ref, folder } : context.ref) : { projectId: 'demo' }
  const body = (
    <GitBody key={context.key + ':' + JSON.stringify(target)} target={target} demo={context.demo} active={active} />
  )
  if (!folders?.length || context.demo) return body
  const options = [
    { value: '0', label: context.name, hint: tr('projectFolders.main') },
    ...folders.map((f, i) => ({ value: String(i + 1), label: folderLabel(f), hint: f.path })),
  ]
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div data-git-repo-switch className="shrink-0 border-b border-line-subtle px-3 py-1.5">
        <Select
          label={tr('git.repository')}
          value={String(folder)}
          options={options}
          onChange={value => setPicked({ key: context.key, folder: Number(value) })}
          className="w-full"
        />
      </div>
      {body}
    </div>
  )
}

type Confirm = { title: string; body: ReactNode; label: string; danger: boolean; run: () => void }

function GitBody({ target, demo, active }: { target: WorkspaceRef; demo: boolean; active: boolean }) {
  useI18n()
  const api = window.pixelsky?.projectTools
  // 真实状态的读取、监听、去抖都在 ./summary.ts，这里只订阅（顶栏、输入框上方读的是同一份）；演示数据放在这里自己的内存里
  const workspaceKey = refKey(target)
  const [demoStatus, setDemoStatus] = useState<GitStatus | null>(() =>
    demo ? structuredClone(demoData().git.status) : null,
  )
  // 不在前台时只读缓存、不登记监听：附加文件夹没别人在看，隐藏时不必每次事件都读；切回来时登记并先读一次
  const watched = useGitStatus(demo ? null : target, active)
  const loadError = useGitLoadError(demo ? null : target)
  const revision = useGitRevision(demo ? null : target)
  const status = demo ? demoStatus : watched
  // 每读到一次状态变一次（内容没变也变）：对比里的文件内容、中栏对比标签据此重读
  const stamp: unknown = demo ? demoStatus : revision
  const setStatus = (next: GitStatus) => (demo ? setDemoStatus(next) : publishGitStatus(target, next))
  const [failure, setFailure] = useState<GitFailure | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const ai = useAiCommit({ target, demo, message, setMessage })
  const [selected, setSelected] = useState<{ area: GitArea; path: string } | null>(null)
  const [menu, setMenu] = useState(false)
  const branchTrigger = useRef<HTMLButtonElement>(null)
  const [branches, setBranches] = useState<Branch[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [now, setNow] = useState(Date.now)
  // 面板窄于 280px（代码模式左栏、大字号 / 宽衬线字体）时进入紧凑样式；按面板自身宽度判断，和字体无关
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null)
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    if (!rootEl) return
    const measure = () => setCompact(rootEl.clientWidth > 0 && rootEl.clientWidth < COMPACT_MAX)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(rootEl)
    return () => ro.disconnect()
  }, [rootEl])
  const authPaused = useRef(false)
  const last = useRef<(() => Promise<GitResult>) | null>(null)
  const busyRef = useRef(false)
  const remote = machineOf(target.sessionId ?? target.projectId) !== 'local'
  // 「更改 | 历史」（docs/ui/git-panel.md §9.1）：每个项目记住上次看的
  const [view, setView] = useRemember<'changes' | 'history'>(
    `pixelsky.git.view:${target.sessionId ?? target.projectId ?? ''}`,
    'changes',
  )
  const [historyKey, setHistoryKey] = useState(0)
  // 单文件历史（§9.15）：文件树等地方发来的请求，或者在「更改」里点文件的历史
  const [fileRequest, setFileRequest] = useState<{
    path: string
    base: 'workspace' | 'repo'
    nonce: number
  } | null>(null)
  const showFileHistory = (path: string, base: 'workspace' | 'repo') => {
    setSelected(null)
    setView('history')
    setFileRequest({ path, base, nonce: Date.now() })
  }
  useEffect(() => {
    const consume = () => {
      const request = takeFileHistory(target, demo)
      if (request) showFileHistory(request.path, request.base)
    }
    consume()
    window.addEventListener(FILE_HISTORY_EVENT, consume)
    return () => window.removeEventListener(FILE_HISTORY_EVENT, consume)
  }, [])

  /** 运行一个写操作：同一时间只有一个；结果带回最新状态，失败显示原因卡片 */
  const perform = useCallback(
    async (fn: () => Promise<GitResult>, demoAction?: [string, unknown?]) => {
      if (busyRef.current) return
      busyRef.current = true
      setBusy(true)
      setFailure(null)
      try {
        if (demo) {
          if (demoAction) setDemoStatus(s => s && demoApply(s, demoAction[0], demoAction[1]))
          return
        }
        last.current = fn
        const result = await fn()
        // 写操作的结果带着最新状态；没带（不是仓库等）就强制重读一次
        if (result.status) setStatus(result.status)
        else void refreshGitStatus(target)
        if (!result.ok) setFailure(result.failure)
        else if (result.ok && authPaused.current) authPaused.current = false
      } catch (e) {
        setFailure({ kind: 'invalid', action: 'operation', detail: (e as Error).message, remedies: [] })
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [demo],
  )

  // 兜底轮询：可见时每 15 秒读一次，外部改动（终端里的 git 操作）没有事件；窗口聚焦、项目工具变化、AI 回合结束的重读在 ./summary.ts
  useEffect(() => {
    if (!active || demo || !api) return
    void refreshGitStatus(target, true)
    const poll = window.setInterval(() => {
      if (!busyRef.current) void refreshGitStatus(target)
    }, POLL_MS)
    return () => window.clearInterval(poll)
  }, [active, demo, workspaceKey])

  // 自动检查远端：Git 页可见且窗口在前台时每 10 分钟；认证失败后暂停，手动检查成功后恢复
  useEffect(() => {
    const tick = window.setInterval(() => {
      setNow(Date.now())
      if (!active || demo || !api || busyRef.current || authPaused.current || !document.hasFocus()) return
      if (
        !status?.repo ||
        !status.remotes.length ||
        (status.fetchedAt && Date.now() - status.fetchedAt < AUTO_FETCH_MS)
      )
        return
      busyRef.current = true
      void api
        .gitFetch(target)
        .then(
          r => {
            if (r.status) setStatus(r.status)
            if (!r.ok && (r.failure.kind === 'auth' || r.failure.kind === 'timeout')) authPaused.current = true
          },
          () => {},
        )
        .finally(() => {
          busyRef.current = false
        })
    }, 60_000)
    return () => window.clearInterval(tick)
  }, [active, status?.repo, status?.fetchedAt, status?.remotes.length])

  const pull = (mode: 'ff-only' | 'rebase' | 'stash') => perform(() => api!.gitPull(target, mode), ['pull'])
  const push = (publish: boolean) => perform(() => api!.gitPush(target, { publish }), ['push'])
  const fetch = () => perform(() => api!.gitFetch(target), ['fetch'])
  const openBranches = async () => {
    setMenu(true)
    if (demo) {
      setBranches(demoData().git.branches)
      return
    }
    setBranchesLoading(true)
    try {
      setBranches(await api!.gitBranches(target))
    } catch (e) {
      setFailure({ kind: 'invalid', action: 'switch', detail: (e as Error).message, remedies: [] })
    } finally {
      setBranchesLoading(false)
    }
  }

  // 命令面板：拉取 / 推送 / 检查远端 / 切换分支（Git 页可见且状态读到后执行）
  useEffect(() => {
    if (!active || !status?.repo) return
    const consume = () => {
      const action = pendingAction
      if (!action) return
      pendingAction = null
      if (action === 'pull') void pull('ff-only')
      else if (action === 'push') void push(!status.upstream)
      else if (action === 'fetch') void fetch()
      else if (action === 'history') {
        setSelected(null)
        setView('history')
      } else if (action === 'changes') {
        // 输入框上方的「N 个改动」（docs/ui/composer-git.md）
        setSelected(null)
        setView('changes')
      } else void openBranches()
    }
    consume()
    window.addEventListener(GIT_ACTION_EVENT, consume)
    return () => window.removeEventListener(GIT_ACTION_EVENT, consume)
  })

  const remedy = (r: GitRemedy) => {
    if (r === 'retry' && last.current) void perform(last.current)
    else if (r === 'pullRebase') void pull('rebase')
    else if (r === 'pullStash') void pull('stash')
    else if (r === 'publish') void push(true)
    else if (r === 'abort') void perform(() => api!.gitOperation(target, 'abort'))
    else if (r === 'terminal') openRightTab('terminal')
  }

  const sections = useMemo(() => (status?.repo ? gitSections(status) : []), [status, stamp])
  const stage = (paths: string[] | 'all') => perform(() => api!.gitStage(target, paths), ['stage', paths])
  const unstage = (paths: string[] | 'all') => perform(() => api!.gitUnstage(target, paths), ['unstage', paths])
  const busyNote = status && status.busySessions > 0 ? <p className="mt-2 text-warn">{tr('git.confirm.busy')}</p> : null
  const discard = (input: { paths: string[]; untracked: string[] } | 'all', body: string) =>
    setConfirm({
      title: tr('git.confirm.discard.title'),
      body: (
        <>
          {body}
          {busyNote}
        </>
      ),
      label: tr('git.confirm.ok'),
      danger: true,
      run: () => void perform(() => api!.gitDiscard(target, input), ['discard', input]),
    })
  const discardFile = (file: GitFileChange, area: GitArea) => {
    const { name } = splitPath(file.path)
    if (area === 'untracked')
      discard(
        { paths: [], untracked: [file.path] },
        tr(remote ? 'git.confirm.delete.body' : 'git.confirm.trash.body', { name }),
      )
    else discard({ paths: [file.path], untracked: [] }, tr('git.confirm.discard.body', { name }))
  }
  const discardSection = (section: GitSection) => {
    if (section.area === 'untracked')
      discard(
        { paths: [], untracked: section.files.map(f => f.path) },
        tr('git.confirm.discardAll.body', { count: 0, untracked: section.files.length }),
      )
    else
      discard(
        { paths: section.files.map(f => f.path), untracked: [] },
        tr('git.confirm.discardAll.body', { count: section.files.length, untracked: 0 }),
      )
  }
  const commit = (andPush: boolean) => {
    if (!status || !message.trim()) return
    const run = (all: boolean) =>
      perform(async () => {
        const r = await api!.gitCommit(target, { message, all, push: andPush })
        if (r.ok) setMessage('')
        return r
      }, ['commit', { all, push: andPush }]).then(() => {
        if (demo) setMessage('')
      })
    if (needsCommitAll(status))
      setConfirm({
        title: tr('git.confirm.commitAll.title'),
        body: tr('git.confirm.commitAll.body', { count: status.unstaged.length + status.untracked.length }),
        label: tr(andPush ? 'git.commitAllPush' : 'git.commitAll'),
        danger: false,
        run: () => void run(true),
      })
    else void run(false)
  }

  // 代码模式：点文件打开到中栏（左栏列表不动、高亮当前文件）——样式 A 工作区改动开成文件标签、其余开「Git 对比」标签，
  // 样式 B 一律「Git 对比」标签（docs/ui/coding-mode.md §3.3.1–3.3.2）；对话模式仍在面板里就地看
  const openDiff = (area: GitArea, file: GitFileChange) => {
    if (routeGitDiff(hasCodeOpener()) !== 'center') setSelected({ area, path: file.path })
    else if (gitOpenTarget(getGitOpenStyle(), area, file) === 'file' && file.local)
      void openWorkFile(target, file.local)
    else openGitDiffTab(workDiffInput(target, workspaceKey, demo, area, file))
  }
  const currentDiff = useCurrentGitDiff(workspaceKey)
  const currentFile = useActiveCodeFile(workspaceKey)
  // 中栏对比标签上的暂存 / 取消暂存 / 还原 / 看历史由这里执行（状态、确认框、演示数据都在这里）
  const diffTabActions = useRef<GitFileActions | null>(null)
  diffTabActions.current = {
    stage: path => void stage([path]),
    unstage: path => void unstage([path]),
    discard: (path, area) => {
      const file = sections.find(s => s.area === area)?.files.find(f => f.path === path)
      if (file) discardFile(file, area)
    },
    history: path => showFileHistory(path, 'repo'),
  }
  useEffect(() => {
    registerGitFileActions(workspaceKey, {
      stage: path => diffTabActions.current?.stage(path),
      unstage: path => diffTabActions.current?.unstage(path),
      discard: (path, area) => diffTabActions.current?.discard(path, area),
      history: path => diffTabActions.current?.history(path),
    })
    return () => registerGitFileActions(workspaceKey, null)
  }, [workspaceKey])
  useEffect(() => setGitActionsBusy(workspaceKey, busy), [workspaceKey, busy])
  // 文件标签用 files.target 换过的 ref（会话在项目文件夹里时是项目）：记下对应关系，样式 A 的文件标签才找得到这里的状态和按钮
  useEffect(() => {
    if (demo || !window.pixelsky) return
    let live = true
    const ref = keyRef(workspaceKey)
    void window.pixelsky.files.target(ref).then(
      t => live && setGitFileKey(workspaceKey, refKey('ref' in t && t.ref ? t.ref : ref)),
      () => undefined,
    )
    return () => void (live = false)
  }, [workspaceKey, demo])
  // 状态变了，中栏的对比标签跟着文件走：暂存 / 取消暂存后换到新区，还原 / 提交后关掉
  useEffect(() => {
    if (status?.repo) syncGitDiffTabs(workspaceKey, sections)
  }, [workspaceKey, status?.repo, sections])
  // HEAD 换了（提交、切分支、拉取、终端里提交）：这个工作区打开着的文件标签重读「变更」的基准
  useEffect(() => {
    if (status?.repo && noteGitHead(workspaceKey, status.head ?? null)) void refreshHeads(inGitWorkspace(workspaceKey))
  }, [workspaceKey, status?.repo, status?.head])

  if (!status)
    return (
      <div className="flex flex-1 items-center justify-center gap-2 p-6 text-meta text-fg-muted">
        {loadError ? (
          <span className="text-danger">{loadError}</span>
        ) : (
          <>
            <Spinner size={13} />
            {tr('projectTools.loading')}
          </>
        )}
      </div>
    )
  if (status.missing || !status.repo)
    return (
      <div className="flex min-h-0 flex-1 p-3">
        <PanelCard>
          <EmptyState
            icon={GitBranch}
            title={tr(status.missing ? 'git.missing.title' : 'git.notRepo.title')}
            hint={tr(status.missing ? 'git.missing.hint' : 'git.notRepo.hint')}
          />
        </PanelCard>
      </div>
    )

  const selectedFile = selected
    ? sections.find(s => s.area === selected.area)?.files.find(f => f.path === selected.path)
    : undefined
  const fileActions = (file: GitFileChange, area: GitArea) => ({
    onOpen: file.local && file.code !== 'D' ? () => void openFile(target, file.local!) : undefined,
    onStage:
      area === 'unstaged' || area === 'untracked' || area === 'conflicted' ? () => void stage([file.path]) : undefined,
    onUnstage: area === 'staged' ? () => void unstage([file.path]) : undefined,
    onDiscard: area === 'unstaged' || area === 'untracked' ? () => discardFile(file, area) : undefined,
  })
  const overlay = confirm && (
    <ConfirmDialog
      title={confirm.title}
      description={confirm.body}
      confirmLabel={confirm.label}
      cancelLabel={tr('projectTools.cancel')}
      busy={busy}
      danger={confirm.danger}
      onCancel={() => setConfirm(null)}
      onConfirm={() => {
        const c = confirm
        setConfirm(null)
        c.run()
      }}
    />
  )

  if (selected && selectedFile) {
    return (
      <>
        <GitDiffView
          file={selectedFile}
          area={selected.area}
          busy={busy}
          // 每次读到新状态都重读一次（文件还在同一区、字母没变时内容也可能变了）
          revision={stamp}
          {...fileActions(selectedFile, selected.area)}
          load={() =>
            demo
              ? Promise.resolve(demoData().git.diff(selectedFile.path))
              : api!.gitDiff(target, { path: selectedFile.path, area: selected.area, origPath: selectedFile.origPath })
          }
          onBack={() => setSelected(null)}
          onHistory={
            selected.area !== 'untracked' && selectedFile.code !== 'A'
              ? () => showFileHistory(selectedFile.path, 'repo')
              : undefined
          }
          onNeighbour={delta => {
            const next = neighbour(sections, selected.area, selected.path, delta)
            if (next) setSelected({ area: next.area, path: next.file.path })
          }}
        />
        {overlay}
      </>
    )
  }

  const total = changeCount(status)
  // 合并 / 变基 / cherry-pick / revert 没结束：更改和历史两页都显示（历史里的 cherry-pick 冲突后在这里中止或继续）
  const operationBanner = status.operation && (
    <div role="status" className="shrink-0 rounded-lg border border-warn/40 bg-surface p-2.5">
      <div className="flex items-center gap-2 text-list font-medium text-warn">
        <TriangleAlert size={14} />
        {tr(`git.operation.${status.operation}`)}
      </div>
      <p className="mt-1 text-meta text-fg-muted">{tr('git.operation.hint')}</p>
      <div className="mt-2 flex gap-1.5">
        <Button
          className="h-7 px-2.5 text-meta"
          disabled={busy}
          onClick={() => void perform(() => api!.gitOperation(target, 'abort'))}
        >
          {tr('git.operation.abort')}
        </Button>
        <Button
          variant="primary"
          className="h-7 px-2.5 text-meta"
          disabled={busy || status.conflicted.length > 0}
          onClick={() => void perform(() => api!.gitOperation(target, 'continue'))}
        >
          {tr('git.operation.continue')}
        </Button>
      </div>
    </div>
  )
  const failureCard = failure && (
    <div
      role="alert"
      data-git-failure={failure.kind}
      className="shrink-0 rounded-lg border border-danger/40 bg-surface p-2.5"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-meta text-fg-faint">{tr(`git.action.${failure.action}`)}</p>
          <p className="text-list font-medium text-danger">{failureTitle(failure.kind)}</p>
          <p className="mt-0.5 text-meta text-fg-muted">{failureHint(failure.kind, failure.action)}</p>
        </div>
        <IconButton
          icon={X}
          label={tr('git.failure.dismiss')}
          size={24}
          iconSize={13}
          onClick={() => setFailure(null)}
        />
      </div>
      {failure.detail && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-meta text-fg-muted">{tr('git.failure.detail')}</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-subtle p-2 font-mono text-[11px] whitespace-pre-wrap text-fg-secondary">
            {failure.detail}
          </pre>
        </details>
      )}
      {failure.remedies.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {failure.remedies.map((r, i) => (
            <Button
              key={r}
              variant={i === 0 ? 'primary' : 'outline'}
              className="h-7 px-2.5 text-meta"
              disabled={busy}
              onClick={() => remedy(r)}
            >
              {tr(`git.remedy.${r}`)}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
  const canCommit = !!message.trim() && !busy && !ai.running && total > 0 && !status.conflicted.length
  const commitAll = needsCommitAll(status)
  return (
    <div ref={setRootEl} data-git-panel className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      {/* 顶部：分支、领先落后、拉取推送、远端检查 */}
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-line-subtle px-3 py-2">
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <button
              ref={branchTrigger}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={menu}
              onClick={() => (menu ? setMenu(false) : void openBranches())}
              disabled={busy}
              className="flex h-8 max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-list font-medium text-fg hover:bg-hover"
            >
              <GitBranch size={14} className="shrink-0 text-fg-muted" />
              <span className="min-w-0 truncate">
                {status.detached ? tr('git.branch.detached', { hash: (status.head ?? '').slice(0, 7) }) : status.branch}
              </span>
              <ChevronDown size={13} className="shrink-0 text-fg-muted" />
            </button>
            {menu && (
              <BranchMenu
                anchor={branchTrigger}
                branches={branches}
                loading={branchesLoading}
                onClose={() => setMenu(false)}
                onSwitch={b => {
                  setMenu(false)
                  void perform(() => api!.gitSwitch(target, { branch: b.name, remote: b.remote }), ['switch', b.name])
                }}
                onCreate={name => {
                  setMenu(false)
                  void perform(() => api!.gitCreateBranch(target, { name }), ['switch', name])
                }}
              />
            )}
          </div>
          {status.upstream && (status.ahead > 0 || status.behind > 0) && (
            <span className="flex shrink-0 items-center gap-1.5 text-meta text-fg-muted tabular-nums">
              {status.ahead > 0 && (
                <span title={tr('git.ahead', { n: status.ahead })} className="flex items-center">
                  <ArrowUp size={12} />
                  {status.ahead}
                </span>
              )}
              {status.behind > 0 && (
                <span title={tr('git.behind', { n: status.behind })} className="flex items-center">
                  <ArrowDown size={12} />
                  {status.behind}
                </span>
              )}
            </span>
          )}
          <IconButton
            icon={RefreshCw}
            label={tr('git.refresh')}
            size={28}
            iconSize={14}
            disabled={busy}
            onClick={() => {
              void refreshGitStatus(target, false, true)
              void refreshHeads(inGitWorkspace(workspaceKey))
              if (view === 'history') setHistoryKey(k => k + 1)
            }}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            className="h-7 shrink-0 whitespace-nowrap px-2.5 text-meta @max-[280px]:px-2"
            icon={ArrowDown}
            title={compact ? tr('git.pull') : undefined}
            aria-label={compact ? tr('git.pull') : undefined}
            disabled={busy || !status.upstream}
            onClick={() => void pull('ff-only')}
          >
            {!compact && tr('git.pull')}
          </Button>
          <Button
            className="h-7 shrink-0 whitespace-nowrap px-2.5 text-meta @max-[280px]:px-2"
            icon={ArrowUp}
            title={compact ? tr(status.upstream ? 'git.push' : 'git.publish') : undefined}
            aria-label={compact ? tr(status.upstream ? 'git.push' : 'git.publish') : undefined}
            disabled={busy || status.detached || !status.remotes.length}
            onClick={() => void push(!status.upstream)}
          >
            {!compact && tr(status.upstream ? 'git.push' : 'git.publish')}
          </Button>
          <span className="min-w-0 flex-1 truncate whitespace-nowrap text-right text-meta text-fg-faint">
            {!status.remotes.length
              ? tr('git.noRemoteShort')
              : status.fetchedAt
                ? tr('git.fetchedAt', { ago: ago(status.fetchedAt, now) })
                : tr('git.fetchedNever')}
          </span>
          {status.remotes.length > 0 && (
            <IconButton
              icon={CloudDownload}
              label={tr('git.fetch')}
              size={26}
              iconSize={14}
              disabled={busy}
              onClick={() => void fetch()}
            />
          )}
          {busy && <Spinner size={13} className="shrink-0" />}
        </div>
        <div className="flex min-w-0">
          <Segmented
            label={tr('git.tab.label')}
            value={view}
            onChange={v => {
              setSelected(null)
              setView(v)
            }}
            options={[
              { value: 'changes', label: tr('git.tab.changes') + (total ? ` ${total}` : '') },
              { value: 'history', label: tr('git.tab.history') },
            ]}
          />
        </div>
      </div>

      {view === 'history' ? (
        <>
          {(failure || status.operation) && (
            <div className="flex shrink-0 flex-col gap-2 px-3 pt-2">
              {operationBanner}
              {failure && failureCard}
            </div>
          )}
          <GitHistory
            target={target}
            demo={demo}
            status={status}
            reloadKey={historyKey}
            onStatus={setStatus}
            onFailure={setFailure}
            fileRequest={fileRequest}
          />
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
          {operationBanner}
          {failure && failureCard}
          {status.busySessions > 0 && (
            <p className="shrink-0 rounded-md bg-subtle px-2.5 py-1.5 text-meta text-fg-muted">{tr('git.busy')}</p>
          )}

          {/* 提交；右上角是 AI 写提交信息（docs/ui/ai-commit-codex-warnings-history.md §2） */}
          <div className="shrink-0">
            <div className="relative">
              <textarea
                value={message}
                onChange={e => setMessage(e.target.value)}
                // 多行的提交信息（AI 写的标题加正文）跟着变高，最多 7 行，再多就滚动
                rows={Math.min(7, Math.max(2, message.split('\n').length))}
                readOnly={ai.running}
                aria-label={tr('git.commit.label')}
                title={tr('git.commit.placeholder')}
                placeholder={tr(
                  ai.running ? 'aiCommit.writing' : compact ? 'git.commit.placeholderShort' : 'git.commit.placeholder',
                )}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    if (canCommit) commit(false)
                  }
                }}
                className={cn(
                  'block max-h-40 min-h-14 w-full resize-y rounded-md border border-line bg-surface px-2.5 py-2 text-list text-fg outline-none placeholder:text-fg-faint focus-visible:border-accent',
                  ai.enabled && 'pr-8',
                )}
              />
              {ai.enabled && (
                <AiCommitButton
                  ai={ai}
                  scope={commitAll ? 'all' : 'staged'}
                  disabled={busy || total === 0 || status.conflicted.length > 0}
                />
              )}
            </div>
            <AiCommitNote ai={ai} />
            <div className="mt-1.5 flex gap-1.5 @max-[280px]:flex-col">
              <Button
                variant="primary"
                className="h-7 min-w-0 flex-1 justify-center truncate whitespace-nowrap px-2.5 text-meta @max-[280px]:flex-none"
                disabled={!canCommit}
                onClick={() => commit(false)}
              >
                {tr(commitAll ? 'git.commitAll' : 'git.commit')}
              </Button>
              <Button
                className="h-7 min-w-0 flex-1 justify-center truncate whitespace-nowrap px-2.5 text-meta @max-[280px]:flex-none"
                disabled={!canCommit || !status.remotes.length || status.detached}
                onClick={() => commit(true)}
              >
                {tr(commitAll ? 'git.commitAllPush' : 'git.commitPush')}
              </Button>
            </div>
          </div>

          {total === 0 && (
            <div className="py-6 text-center">
              <p className="text-list text-fg-muted">{tr('git.clean')}</p>
              <p className="mt-1 text-meta text-fg-faint">{tr('git.cleanHint')}</p>
            </div>
          )}
          {status.truncated && <p className="shrink-0 text-meta text-warn">{tr('git.truncated')}</p>}
          {sections.map(section => (
            <section key={section.area} data-git-section={section.area} className="shrink-0">
              <div className="group/section flex h-7 items-center gap-1 pr-0.5">
                <h3
                  className={cn(
                    'min-w-0 flex-1 truncate text-label font-medium',
                    section.area === 'conflicted' ? 'text-danger' : 'text-fg-muted',
                  )}
                >
                  {tr(section.title)} <span className="tabular-nums text-fg-faint">{section.files.length}</span>
                </h3>
                {section.area === 'staged' ? (
                  <IconButton
                    icon={Minus}
                    label={tr('git.unstageAll')}
                    size={24}
                    iconSize={13}
                    disabled={busy}
                    onClick={() => void unstage('all')}
                  />
                ) : (
                  <>
                    {section.area !== 'conflicted' && (
                      <IconButton
                        icon={Undo2}
                        label={tr('git.discardAll')}
                        size={24}
                        iconSize={13}
                        disabled={busy}
                        onClick={() => discardSection(section)}
                      />
                    )}
                    <IconButton
                      icon={Plus}
                      label={tr('git.stageAll')}
                      size={24}
                      iconSize={13}
                      disabled={busy}
                      onClick={() => void stage(section.files.map(f => f.path))}
                    />
                  </>
                )}
              </div>
              <ul className="flex flex-col">
                {section.files.map(file => {
                  const { name, dir } = splitPath(file.path)
                  const actions = fileActions(file, section.area)
                  return (
                    <li
                      key={section.area + ':' + file.path}
                      className={cn(
                        'group/file flex h-7 min-w-0 items-center gap-1 rounded-md pr-0.5 hover:bg-hover',
                        ((currentDiff?.area === section.area && currentDiff.path === file.path) ||
                          (section.area !== 'staged' && currentFile !== null && file.local === currentFile)) &&
                          'bg-selected',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => openDiff(section.area, file)}
                        title={`${tr('git.viewDiff')} · ${file.origPath ? file.origPath + ' → ' : ''}${file.path}`}
                        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pl-2 text-left"
                      >
                        <span
                          className={cn(
                            'w-3 shrink-0 text-center font-mono text-[11px] font-semibold',
                            file.code === 'D'
                              ? 'text-danger'
                              : file.code === 'A' || file.code === '?'
                                ? 'text-success'
                                : file.code === 'U'
                                  ? 'text-danger'
                                  : 'text-warn',
                          )}
                        >
                          {file.code}
                        </span>
                        <span
                          className={cn(
                            'min-w-0 truncate whitespace-nowrap text-list',
                            file.code === 'D' ? 'text-fg-muted line-through' : 'text-fg',
                          )}
                        >
                          {name}
                        </span>
                        {dir && !compact && (
                          <span className="min-w-0 shrink-[3] truncate whitespace-nowrap text-meta text-fg-faint">
                            {dir}
                          </span>
                        )}
                      </button>
                      <span className="flex shrink-0 items-center opacity-0 group-hover/file:opacity-100 group-focus-within/file:opacity-100">
                        {actions.onOpen && (
                          <IconButton
                            icon={FileCode2}
                            label={tr('git.open')}
                            size={22}
                            iconSize={12}
                            onClick={actions.onOpen}
                          />
                        )}
                        {section.area !== 'untracked' && file.code !== 'A' && (
                          <IconButton
                            icon={FileClock}
                            label={tr('git.history.file.show')}
                            size={22}
                            iconSize={12}
                            onClick={() => showFileHistory(file.path, 'repo')}
                          />
                        )}
                        {actions.onDiscard && (
                          <IconButton
                            icon={Undo2}
                            label={tr('git.discard')}
                            size={22}
                            iconSize={12}
                            disabled={busy}
                            onClick={actions.onDiscard}
                          />
                        )}
                        {actions.onStage && (
                          <IconButton
                            icon={Plus}
                            label={tr('git.stage')}
                            size={22}
                            iconSize={12}
                            disabled={busy}
                            onClick={actions.onStage}
                          />
                        )}
                        {actions.onUnstage && (
                          <IconButton
                            icon={Minus}
                            label={tr('git.unstage')}
                            size={22}
                            iconSize={12}
                            disabled={busy}
                            onClick={actions.onUnstage}
                          />
                        )}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
      {overlay}
    </div>
  )
}
