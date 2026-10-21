// Git 面板的「历史」（docs/ui/git-panel.md §9）：分支线 + 提交列表、范围和搜索、点开看详情和改动、不改动仓库的操作
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ClipboardCopy,
  Copy,
  FileClock,
  GitBranchPlus,
  GitCommitHorizontal,
  GitCompare,
  GitPullRequestArrow,
  ListFilter,
  MessageSquarePlus,
  Search,
  RotateCcw,
  Sparkles,
  Tag,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { Button, cn, IconButton, Popover, Spinner, useToast } from '@/ui'
import { ActionMenu, type MenuAction } from '@/ui/ActionMenu'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { scrollInPane } from '@/ui/scrollInPane'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { demo as demoData } from '@/data/demo'
import { isLive } from '@/features/engine'
import { appendComposerDraft } from '@/features/engine/drafts'
import { getPaneState } from '@/features/panes/store'
import { focusedTab, isFileTab, visibleTabs } from '@/features/panes/tree'
import { useRemember } from '../ToolsUi'
import type {
  GitChangeSet,
  GitCommit,
  GitCommitFile,
  GitCompareKind,
  GitCompareTarget,
  GitDiff,
  GitDiffInput,
  GitFailure,
  GitHistoryAction,
  GitLogScope,
  GitRefs,
  GitResult,
  GitStatus,
} from '../../../../../shared/types/project-tools'
import type { WorkspaceRef } from '../../../../../shared/types/workspace'
import { failureHint, failureTitle } from './gitModel'
import { GitDiffView } from './GitDiffView'
import { hasCodeOpener, openFile } from '@/features/files/store'
import { refKey as workspaceRefKey } from '@/features/editor/target'
import { routeGitDiff } from '@/features/coding/editor/gitDiffModel'
import { commitDiffInput, openGitDiffTab, useCurrentGitDiff } from '@/features/coding/editor/gitDiffTabs'
import { layoutGraph, type GraphRow } from './graph'
import { ChangedFiles, GraphCell, RefBadge, RefBadges, ROW_H, SYNC_COLOR } from './HistoryParts'
import {
  HistoryActionDialog,
  touchesWorktree,
  type ActionOptions,
  type ActionOutcome,
  type PendingAction,
} from './HistoryActionDialog'
import {
  commitTime,
  fullMessage,
  fullTime,
  historyEntries,
  SYNC_TITLE_KEY,
  syncStates,
  refBadges,
  shortHash,
  type HistoryEntry,
} from './historyModel'

const PAGE = 50
/** 滚到离底部这么近时加载下一页 */
const LOAD_AHEAD = 240
/** 详情里的提交信息超过这么多行时先折叠 */
const BODY_LINES = 8

type CommitDiffInput = Extract<GitDiffInput, { area: 'commit' }>
/** 差异视图里的一项：一个文件在两个提交之间；caption 写在文件名下面 */
interface DiffItem {
  file: GitCommitFile
  from: string | null
  to: string
  caption?: string
}
type Detail =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; data: GitChangeSet; commits?: number }

/** 当前焦点的会话输入框（焦点在文件标签上时找另一个可见的会话）；没有时为 null */
function composerTarget(): string | null {
  const layout = getPaneState().layout
  const focused = focusedTab(layout)
  const tab = focused && !isFileTab(focused) ? focused : visibleTabs(layout).find(t => !isFileTab(t))
  if (!tab) return null
  return isLive ? tab : `demo:${tab}`
}

const errorText = (e: unknown): string =>
  ((e as Error)?.message ?? String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function useHistoryApi(target: WorkspaceRef, demo: boolean) {
  const key = JSON.stringify(target)
  return useMemo(() => {
    const api = window.pixelsky?.projectTools
    const d = () => demoData().git.history
    const local = <T,>(fn: () => T): Promise<T> => Promise.resolve().then(fn)
    return {
      log: (q: Parameters<NonNullable<typeof api>['gitLog']>[1]) =>
        demo ? local(() => d().log(q)) : api!.gitLog(target, q),
      refs: (): Promise<GitRefs> => (demo ? local(() => d().refs) : api!.gitRefs(target)),
      show: (hash: string) => (demo ? local(() => d().show(hash)) : api!.gitShow(target, hash)),
      compare: (kind: GitCompareTarget) => (demo ? local(() => d().compare(kind)) : api!.gitCompare(target, kind)),
      action: (action: GitHistoryAction) => api!.gitHistoryAction(target, action),
      switchBranch: (branch: string, remote: boolean) => api!.gitSwitch(target, { branch, remote }),
      diff: (input: CommitDiffInput): Promise<GitDiff> =>
        demo ? local(() => d().diff(input)) : api!.gitDiff(target, input),
      createBranch: (input: { name: string; start: string; switch: boolean }) => api!.gitCreateBranch(target, input),
    }
  }, [demo, key])
}

export function GitHistory({
  target,
  demo,
  status,
  reloadKey,
  onStatus,
  onFailure,
  fileRequest,
}: {
  target: WorkspaceRef
  demo: boolean
  status: GitStatus
  /** 顶部「刷新」按一次加一 */
  reloadKey: number
  /** 新建分支后带回的最新状态 */
  onStatus: (status: GitStatus) => void
  /** 冲突这类要在面板上处理的失败（带「中止」等按钮），交给面板的失败卡片 */
  onFailure: (failure: GitFailure) => void
  /** 打开某个文件的历史（§9.15）：nonce 变了就换成这个文件 */
  fileRequest?: { path: string; base: 'workspace' | 'repo'; nonce: number } | null
}) {
  useI18n()
  const api = useHistoryApi(target, demo)
  const toast = useToast()
  const [scope, setScope] = useRemember<GitLogScope>(
    `pixelsky.git.historyScope:${target.sessionId ?? target.projectId ?? ''}`,
    'auto',
  )
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [more, setMore] = useState(false)
  const [shallow, setShallow] = useState(false)
  const [loading, setLoading] = useState<'first' | 'more' | null>('first')
  const [error, setError] = useState('')
  const [refs, setRefs] = useState<GitRefs | null>(null)
  const [stale, setStale] = useState(false)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [details, setDetails] = useState<Record<string, Detail>>({})
  const [diff, setDiff] = useState<{ items: DiffItem[]; index: number } | null>(null)
  // 代码模式：提交里的文件在中栏开只读的「Git 对比」标签（左栏提交列表不动）；对话模式仍在面板里就地看
  const currentDiff = useCurrentGitDiff(workspaceRefKey(target))
  const showDiff = (items: DiffItem[], index: number) => {
    const item = items[index]
    if (item && routeGitDiff(hasCodeOpener()) === 'center') {
      const caption =
        item.caption ?? (item.from ? `${shortHash(item.from)} ↔ ${shortHash(item.to)}` : shortHash(item.to))
      openGitDiffTab(commitDiffInput(target, workspaceRefKey(target), demo, item.file, item.from, item.to, caption))
    } else setDiff({ items, index })
  }
  /** 单文件历史（§9.15）：只列改过这个文件的提交；filePath 是查到的仓库内路径 */
  const [file, setFile] = useState<{ path: string; base: 'workspace' | 'repo' } | null>(
    fileRequest ? { path: fileRequest.path, base: fileRequest.base } : null,
  )
  const [filePath, setFilePath] = useState<string | null>(null)
  /** 单文件历史里选为比较一端的版本 */
  const [pinned, setPinned] = useState<GitCommit | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; commit: GitCommit } | null>(null)
  const [scopeMenu, setScopeMenu] = useState<{ x: number; y: number } | null>(null)
  const [picking, setPicking] = useState(false)
  const [branchAt, setBranchAt] = useState<GitCommit | null>(null)
  const [pending, setPending] = useState<PendingAction | null>(null)
  /** 和分支 / 标签比较（§9.6 第二期）：from 是选的引用，to 是提交 */
  const [comparison, setComparison] = useState<{ from: string; to: string } | null>(null)
  const [comparePick, setComparePick] = useState<GitCommit | null>(null)
  const [hover, setHover] = useState<{ commit: GitCommit; rect: DOMRect } | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const token = useRef(0)
  const list = useRef<HTMLDivElement>(null)
  const commitsRef = useRef(commits)
  commitsRef.current = commits
  const hoverTimer = useRef(0)
  // 看完差异回来时回到原来的滚动位置
  const scrollBack = useRef(0)
  useLayoutEffect(() => {
    if (!diff && list.current) list.current.scrollTop = scrollBack.current
  }, [diff])

  const lastNonce = useRef(fileRequest?.nonce)
  useEffect(() => {
    if (!fileRequest || fileRequest.nonce === lastNonce.current) return
    lastNonce.current = fileRequest.nonce
    setFile({ path: fileRequest.path, base: fileRequest.base })
    setDiff(null)
  }, [fileRequest])
  const openFileHistory = (path: string) => {
    setDiff(null)
    setFile({ path, base: 'repo' })
  }
  useEffect(() => {
    setPinned(null)
    setFilePath(null)
    list.current?.scrollTo({ top: 0 })
  }, [file])

  useEffect(() => {
    const t = window.setTimeout(() => setQuery(search.trim()), 300)
    return () => window.clearTimeout(t)
  }, [search])

  const load = useCallback(
    async (reset: boolean) => {
      const id = ++token.current
      setLoading(reset ? 'first' : 'more')
      if (reset) {
        setError('')
        setStale(false)
      }
      try {
        const skip = reset ? 0 : commitsRef.current.length
        const [page, nextRefs] = await Promise.all([
          api.log({
            scope,
            search: query || undefined,
            skip,
            limit: PAGE,
            ...(file ? { path: file.path, pathBase: file.base } : {}),
          }),
          reset ? api.refs() : Promise.resolve(null),
        ])
        if (id !== token.current) return
        if (reset) {
          setCommits(page.commits)
          // 未拉取 / 未推送 / 相对基础分支的改动跟着刷新
          setDetails(d => Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith('@'))))
        } else
          setCommits(prev => {
            const seen = new Set(prev.map(c => c.hash))
            return [...prev, ...page.commits.filter(c => !seen.has(c.hash))]
          })
        setMore(page.more)
        setShallow(page.shallow)
        setFilePath(page.path ?? null)
        if (nextRefs) setRefs(nextRefs)
      } catch (e) {
        if (id === token.current) setError(errorText(e))
      } finally {
        if (id === token.current) setLoading(null)
      }
    },
    [api, scope, query, file],
  )

  // 打开、换范围 / 搜索、点顶部刷新：重新加载第一页
  useEffect(() => {
    void load(true)
  }, [load, reloadKey])

  // HEAD 变了（提交、拉取、切换分支）重新加载；只有远端引用变了（检查远端）时，往下翻着就不打断，顶部提示「有更新」
  const headKey = `${status.head}|${status.branch}`
  const refKey = `${status.upstream}|${status.ahead}|${status.behind}|${status.fetchedAt}`
  const seen = useRef({ headKey, refKey })
  useEffect(() => {
    const prev = seen.current
    seen.current = { headKey, refKey }
    if (prev.headKey !== headKey) void load(true)
    else if (prev.refKey !== refKey) {
      if ((list.current?.scrollTop ?? 0) < 8) void load(true)
      else setStale(true)
    }
  }, [headKey, refKey])

  // 搜索和单文件历史不画分支线（列出的提交不连续）
  // 当前分支的提交按「和上游的关系」分状态（未推送 / 已推送 / 远程新提交），分支线和标记按状态上色（docs/ui/git-graph-colors.md）
  const upstreamTip = useMemo(
    () =>
      (status.upstream &&
        commits.find(c => c.refs.some(r => r.kind === 'remote' && r.name === status.upstream))?.hash) ||
      null,
    [commits, status.upstream],
  )
  const states = useMemo(
    () =>
      query || file
        ? null
        : syncStates(commits, {
            head: status.head,
            upstreamTip,
            ...(status.upstream ? { ahead: status.ahead, behind: status.behind } : {}),
          }),
    [commits, query, file, status.head, status.upstream, status.ahead, status.behind, upstreamTip],
  )
  const rows = useMemo(
    () => (query || file ? null : layoutGraph(commits, states ?? undefined)),
    [commits, query, file, states],
  )
  const lanes = useMemo(() => Math.max(1, ...(rows ?? []).map(r => r.width)), [rows])
  const entries = useMemo(
    () =>
      historyEntries(commits, rows, {
        head: status.head,
        upstream: status.upstream,
        ahead: status.ahead,
        behind: status.behind,
        unpublished:
          !status.upstream && !status.detached && !status.initial && !!status.branch && status.remotes.length > 0,
      }),
    [commits, rows, status],
  )

  const onScroll = () => {
    const el = list.current
    if (!el || !more || loading || error) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_AHEAD) void load(false)
  }
  // 第一页不够撑满时接着加载
  useEffect(() => {
    if (!loading && !diff) onScroll()
  }, [loading, commits.length, diff])

  const toggle = (key: string, fetch: () => Promise<Detail>) => {
    setOpen(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    if (open.has(key) || details[key]?.state === 'ready') return
    setDetails(d => ({ ...d, [key]: { state: 'loading' } }))
    fetch().then(
      detail => setDetails(d => ({ ...d, [key]: detail })),
      e => setDetails(d => ({ ...d, [key]: { state: 'error', message: errorText(e) } })),
    )
  }
  const toggleCommit = (c: GitCommit) => toggle(c.hash, async () => ({ state: 'ready', data: await api.show(c.hash) }))
  const toggleCompare = (kind: GitCompareKind) =>
    toggle('@' + kind, async () => {
      const r = await api.compare(kind)
      return { state: 'ready', data: r, commits: r.commits }
    })

  const startCompare = (from: string, to: GitCommit) => {
    setComparison({ from, to: to.hash })
    setDetails(d => ({ ...d, cmp: { state: 'loading' } }))
    api.compare({ from, to: to.hash }).then(
      r => setDetails(d => ({ ...d, cmp: { state: 'ready', data: r, commits: r.commits } })),
      e => setDetails(d => ({ ...d, cmp: { state: 'error', message: errorText(e) } })),
    )
    list.current?.scrollTo({ top: 0 })
  }

  /** 运行一个会改动仓库的操作；成功后提示并重新加载，冲突之类交给面板的失败卡片 */
  const runAction = async (p: PendingAction, o: ActionOptions): Promise<ActionOutcome> => {
    const name = 'commit' in p ? (p.kind === 'tag' ? o.tagName : shortHash(p.commit.hash)) : p.name
    const done = () => {
      setPending(null)
      toast(tr(`git.history.done.${p.kind}`, { name }))
    }
    if (demo) {
      done()
      return null
    }
    const request = (): GitHistoryAction => {
      if ('commit' in p) {
        const hash = p.commit.hash
        if (p.kind === 'reset') return { kind: 'reset', hash, mode: o.mode }
        if (p.kind === 'tag') return { kind: 'tag', hash, name: o.tagName, message: o.message }
        return { kind: p.kind, hash }
      }
      if (p.kind === 'deleteBranch') return { kind: 'deleteBranch', name: p.name, force: o.force }
      return { kind: 'deleteTag', name: p.name }
    }
    const r = p.kind === 'switch' ? await api.switchBranch(p.name, p.remote) : await api.action(request())
    if (r.status) onStatus(r.status)
    if (!r.ok) {
      if (p.kind === 'deleteBranch' && r.failure.kind === 'unmerged' && !o.force) return 'unmerged'
      if (r.failure.kind === 'conflict' || r.failure.remedies.length) {
        setPending(null)
        // cherry-pick / revert 冲突后停在进行中：面板顶部的横幅已经有「中止」「继续」，不再叠一张失败卡片
        if (!(r.failure.kind === 'conflict' && r.status?.operation)) onFailure(r.failure)
        return null
      }
      return [failureTitle(r.failure.kind), r.failure.detail].filter(Boolean).join(' · ')
    }
    done()
    void load(true)
    return null
  }

  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => toast(tr('git.history.copied')),
      () => {},
    )
  const toSession = (text: string) => {
    const key = composerTarget()
    if (!key) {
      toast(tr('git.history.noSession'))
      return
    }
    appendComposerDraft(key, text)
    toast(tr('git.history.referenced'))
  }
  const reference = (c: GitCommit) =>
    toSession(tr('git.history.referenceText', { hash: shortHash(c.hash), subject: c.subject }))
  const review = (c: GitCommit) =>
    toSession(tr('git.history.reviewPrompt', { hash: shortHash(c.hash), subject: c.subject }))
  const rangeWhat = (kind: GitCompareKind) =>
    kind === 'base' ? tr('git.history.what.base', { base: refs?.base ?? 'main' }) : tr(`git.history.what.${kind}`)
  const reviewRange = (what: string, set: GitChangeSet, n: number) =>
    toSession(
      tr('git.history.reviewRangePrompt', {
        what,
        n,
        from: shortHash(set.from ?? ''),
        to: shortHash(set.to),
      }),
    )
  const jumpTo = (hash: string) => {
    const el = list.current?.querySelector<HTMLElement>(`[data-commit="${hash}"]`)
    if (!el) return
    scrollInPane(el, 'center', { behavior: 'smooth' })
    el.querySelector<HTMLElement>('[role="button"]')?.focus({ preventScroll: true })
    setFlash(hash)
    window.setTimeout(() => setFlash(f => (f === hash ? null : f)), 1200)
  }
  const busySessions = status.busySessions > 0
  const actions = (c: GitCommit): MenuAction[] => {
    const repo = (
      kind: Extract<PendingAction, { commit: GitCommit }>['kind'],
    ): Pick<MenuAction, 'run' | 'disabled'> => ({
      disabled: touchesWorktree(kind) && busySessions,
      run: () => setPending({ kind, commit: c }),
    })
    const refActions: MenuAction[] = []
    for (const r of c.refs) {
      if (r.kind === 'branch' && !r.current)
        refActions.push(
          {
            label: tr('git.history.switchBranch', { name: r.name }),
            icon: GitBranchPlus,
            disabled: busySessions,
            run: () => setPending({ kind: 'switch', name: r.name, remote: false }),
          },
          {
            label: tr('git.history.deleteBranch', { name: r.name }),
            icon: Trash2,
            danger: true,
            run: () => setPending({ kind: 'deleteBranch', name: r.name }),
          },
        )
      // 远端分支：本地还没有同名分支时可以检出（建跟踪分支）；已有时检出的是本地那个，不在这里给
      else if (r.kind === 'remote' && !refs?.local.includes(r.name.slice(r.name.indexOf('/') + 1)))
        refActions.push({
          label: tr('git.history.switchBranch', { name: r.name }),
          icon: GitBranchPlus,
          disabled: busySessions,
          run: () => setPending({ kind: 'switch', name: r.name, remote: true }),
        })
      else if (r.kind === 'tag')
        refActions.push({
          label: tr('git.history.deleteTag', { name: r.name }),
          icon: Trash2,
          danger: true,
          run: () => setPending({ kind: 'deleteTag', name: r.name }),
        })
    }
    if (refActions.length) refActions[0] = { ...refActions[0], section: tr('git.history.section.refs') }
    const fileActions: MenuAction[] =
      file && c.file
        ? [
            { label: tr('git.history.file.diffPrev'), icon: FileClock, run: () => openVersion(c) },
            pinned && pinned.hash !== c.hash && pinned.file
              ? {
                  label: tr('git.history.file.compareWith', { hash: shortHash(pinned.hash) }),
                  icon: GitCompare,
                  run: () => compareVersions(pinned, c),
                }
              : {
                  label: tr('git.history.file.pin'),
                  icon: GitCompare,
                  run: () => {
                    setPinned(c)
                    toast(tr('git.history.file.pinned', { hash: shortHash(c.hash) }))
                  },
                },
            {
              label: tr('git.history.file.showCommit'),
              icon: ChevronDown,
              run: () => toggleCommit(c),
            },
          ]
        : []
    return [
      ...fileActions,
      { label: tr('git.history.copyHash'), icon: Copy, separator: fileActions.length > 0, run: () => copy(c.hash) },
      { label: tr('git.history.copyMessage'), icon: ClipboardCopy, run: () => copy(fullMessage(c)) },
      { label: tr('git.history.reference'), icon: MessageSquarePlus, separator: true, run: () => reference(c) },
      { label: tr('git.history.review'), icon: Sparkles, run: () => review(c) },
      {
        label: tr('git.history.createBranch'),
        icon: GitBranchPlus,
        separator: true,
        disabled: demo ? false : !window.pixelsky,
        run: () => setBranchAt(c),
      },
      {
        label: tr('git.history.compareWith'),
        icon: GitCompare,
        disabled: !refs,
        run: () => setComparePick(c),
      },
      {
        label: tr('git.history.checkout'),
        icon: GitCommitHorizontal,
        section: tr('git.history.section.repo'),
        ...repo('checkout'),
      },
      { label: tr('git.history.cherryPick'), icon: GitPullRequestArrow, ...repo('cherryPick') },
      { label: tr('git.history.revert'), icon: Undo2, ...repo('revert') },
      { label: tr('git.history.reset'), icon: RotateCcw, ...repo('reset') },
      { label: tr('git.history.tag'), icon: Tag, ...repo('tag') },
      ...refActions,
    ]
  }

  const showHover = (commit: GitCommit, el: HTMLElement) => {
    window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => setHover({ commit, rect: el.getBoundingClientRect() }), 600)
  }
  const hideHover = () => {
    window.clearTimeout(hoverTimer.current)
    setHover(null)
  }
  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])

  const scopeLabel =
    scope === 'auto'
      ? tr('git.history.scope.auto')
      : scope === 'all'
        ? tr('git.history.scope.all')
        : tr('git.history.scope.picked', { n: scope.length })
  const base = !query && !file && refs?.base && refs.branch && refs.head ? refs.base : null

  const renderDetail = (key: string, body: (data: GitChangeSet, commits?: number) => ReactNode) => {
    const detail = details[key]
    if (!detail || detail.state === 'loading')
      return (
        <div className="flex items-center gap-2 py-2 text-meta text-fg-muted">
          <Spinner size={12} />
          {tr('projectTools.loading')}
        </div>
      )
    if (detail.state === 'error') return <p className="py-2 text-meta text-danger">{detail.message}</p>
    return body(detail.data, detail.commits)
  }
  const files = (set: GitChangeSet) =>
    set.files.length ? (
      <>
        <ChangedFiles
          files={set.files}
          onOpenFile={index => {
            const local = set.files[index].local
            if (local) void openFile(target, local)
          }}
          onHistory={index => openFileHistory(set.files[index].path)}
          isCurrent={f =>
            currentDiff?.area === 'commit' &&
            currentDiff.path === f.path &&
            currentDiff.to === set.to &&
            currentDiff.from === set.from
          }
          onOpen={index => {
            hideHover()
            scrollBack.current = list.current?.scrollTop ?? 0
            showDiff(
              set.files.map(f => ({ file: f, from: set.from, to: set.to })),
              index,
            )
          }}
        />
        {set.truncated && <p className="px-1.5 text-meta text-warn">{tr('git.history.truncated')}</p>}
      </>
    ) : (
      <p className="px-1.5 py-1 text-meta text-fg-faint">{tr('git.history.noFiles')}</p>
    )

  const renderCompare = (key: string, what: string) =>
    renderDetail(key, (set, n = 0) => (
      <div className="pr-2 pb-2">
        <div className="flex items-center gap-1.5 px-1.5 pb-1 text-meta text-fg-muted">
          <span className="min-w-0 flex-1 truncate">
            {tr('git.history.commits', { n })} · <DiffStat {...statOf(set)} />
          </span>
          <SmallAction icon={Sparkles} outline={false} onClick={() => reviewRange(what, set, n)}>
            {tr('git.history.reviewChanges')}
          </SmallAction>
        </div>
        {files(set)}
      </div>
    ))

  /** 单文件历史里一个提交的这个文件：和上一版本（第一父提交）比较 */
  const versionItem = (c: GitCommit): DiffItem | null =>
    c.file
      ? {
          file: c.file,
          from: c.file.code === 'A' ? null : (c.parents[0] ?? null),
          to: c.hash,
          caption: `${shortHash(c.hash)} · ${c.subject}`,
        }
      : null
  /** 点一行：看这个文件在这个提交里的改动；上一个 / 下一个文件换成更新 / 更早的版本 */
  const openVersion = (c: GitCommit) => {
    const items = commits.flatMap(x => {
      const item = versionItem(x)
      return item ? [item] : []
    })
    const index = items.findIndex(item => item.to === c.hash)
    if (index < 0) return
    hideHover()
    scrollBack.current = list.current?.scrollTop ?? 0
    showDiff(items, index)
  }
  /** 任意两个版本之间这个文件的差异：旧的在左 */
  const compareVersions = (a: GitCommit, b: GitCommit) => {
    const [older, newer] = commits.indexOf(a) > commits.indexOf(b) ? [a, b] : [b, a]
    if (!older.file || !newer.file) return
    hideHover()
    scrollBack.current = list.current?.scrollTop ?? 0
    showDiff(
      [
        {
          file: {
            ...newer.file,
            code: 'M',
            origPath: older.file.path !== newer.file.path ? older.file.path : null,
          },
          from: older.hash,
          to: newer.hash,
          caption: tr('git.history.file.versions', { from: shortHash(older.hash), to: shortHash(newer.hash) }),
        },
      ],
      0,
    )
  }

  const renderEntry = (entry: HistoryEntry) => {
    const graph: GraphRow = entry.graph ?? { lane: 0, color: 0, lines: [], width: 1, merge: false }
    if (entry.type === 'special') {
      const key = '@' + entry.kind
      const expanded = open.has(key)
      const Icon = entry.kind === 'outgoing' ? ArrowUp : ArrowDown
      const tone = entry.kind === 'outgoing' ? 'local' : 'incoming'
      const label = entry.unpublished
        ? tr('git.history.outgoingUnpublished')
        : tr(`git.history.${entry.kind}`, { n: entry.count })
      return (
        <div key={key} data-history-special={entry.kind} className="flex min-w-0">
          <GraphCell
            row={{ ...graph, state: tone }}
            lanes={lanes}
            node="special"
            expanded={expanded}
            title={tr(SYNC_TITLE_KEY[tone])}
          />
          <div className="min-w-0 flex-1">
            <div
              role={entry.unpublished ? undefined : 'button'}
              tabIndex={entry.unpublished ? undefined : 0}
              aria-expanded={entry.unpublished ? undefined : expanded}
              onClick={entry.unpublished ? undefined : () => toggleCompare(entry.kind)}
              onKeyDown={
                entry.unpublished
                  ? undefined
                  : e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        toggleCompare(entry.kind)
                      }
                    }
              }
              title={tr(SYNC_TITLE_KEY[tone])}
              data-sync-tone={tone}
              className={cn(
                'flex min-w-0 items-center gap-1.5 rounded-md pr-2 pl-1 text-list italic',
                !entry.unpublished && 'cursor-pointer hover:bg-hover',
              )}
              style={{ height: ROW_H, color: SYNC_COLOR[tone] }}
            >
              <Icon size={13} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {!entry.unpublished && (
                <ChevronDown size={13} className={cn('shrink-0 transition-transform', !expanded && '-rotate-90')} />
              )}
            </div>
            {expanded && renderCompare(key, rangeWhat(entry.kind))}
          </div>
        </div>
      )
    }
    const c = entry.commit
    const expanded = open.has(c.hash)
    const state = entry.graph?.state
    const badges = refBadges(c.refs, refs?.base ?? null, { state, upstream: status.upstream })
    const nodeTitle = !state
      ? undefined
      : state === 'synced' && status.upstream
        ? tr('git.history.sync.syncedTo', { upstream: status.upstream })
        : tr(SYNC_TITLE_KEY[state])
    return (
      <div
        key={c.hash}
        data-commit={c.hash}
        className={cn('flex min-w-0 rounded-md transition-colors', flash === c.hash && 'bg-accent-soft')}
      >
        <GraphCell
          row={graph}
          lanes={lanes}
          node={entry.head ? 'head' : graph.merge ? 'merge' : 'commit'}
          expanded={expanded}
          title={nodeTitle}
        />
        <div className="min-w-0 flex-1">
          <div
            role="button"
            tabIndex={0}
            aria-expanded={expanded}
            aria-label={`${c.subject} · ${shortHash(c.hash)}`}
            onClick={() => (file && c.file ? openVersion(c) : toggleCommit(c))}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                if (file && c.file) openVersion(c)
                else toggleCommit(c)
              } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
                e.preventDefault()
                const r = e.currentTarget.getBoundingClientRect()
                setMenu({ x: r.left + 24, y: r.bottom, commit: c })
              }
            }}
            onContextMenu={e => {
              e.preventDefault()
              hideHover()
              setMenu({ x: e.clientX, y: e.clientY, commit: c })
            }}
            onMouseEnter={e => showHover(c, e.currentTarget)}
            onMouseLeave={hideHover}
            className={cn(
              'flex min-w-0 cursor-pointer flex-col justify-center rounded-md pr-2 pl-1 hover:bg-hover',
              expanded && 'bg-hover',
            )}
            style={{ height: ROW_H }}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <span className={cn('min-w-0 flex-1 truncate text-list text-fg', entry.head && 'font-medium')}>
                {c.subject || '—'}
              </span>
              <RefBadges badges={badges} />
            </div>
            <div className="flex min-w-0 items-center gap-1 text-meta text-fg-faint">
              <button
                type="button"
                title={tr('git.history.copyHashHint')}
                onClick={e => {
                  e.stopPropagation()
                  copy(c.hash)
                }}
                className="shrink-0 rounded font-mono text-[11px] hover:text-fg"
              >
                {shortHash(c.hash)}
              </button>
              <span aria-hidden>·</span>
              <span className="min-w-0 truncate">{c.author}</span>
              <span aria-hidden>·</span>
              <span className="shrink-0 tabular-nums">{commitTime(c.committedAt)}</span>
              {c.file && (
                <>
                  {c.file.insertions !== null && (
                    <span className="shrink-0 font-mono text-[11px] tabular-nums">
                      <span className="text-success">+{c.file.insertions}</span>{' '}
                      <span className="text-danger">−{c.file.deletions}</span>
                    </span>
                  )}
                  {(c.file.path !== filePath || c.file.origPath) && (
                    <span className="min-w-0 truncate" title={c.file.origPath ?? c.file.path}>
                      · {c.file.origPath ? tr('git.history.file.renamedFrom', { path: c.file.origPath }) : c.file.path}
                    </span>
                  )}
                </>
              )}
              {pinned?.hash === c.hash && (
                <span className="shrink-0 rounded-full border border-accent-line px-1.5 text-[11px] text-accent-fg">
                  {tr('git.history.file.pinnedBadge')}
                </span>
              )}
            </div>
          </div>
          {expanded &&
            renderDetail(c.hash, set => (
              <CommitDetail
                commit={c}
                set={set}
                files={files(set)}
                onCopy={copy}
                onReference={() => reference(c)}
                onReview={() => review(c)}
                onBranch={() => setBranchAt(c)}
                onJump={jumpTo}
              />
            ))}
        </div>
      </div>
    )
  }

  if (diff) {
    const item = diff.items[diff.index]
    const f = item.file
    return (
      <GitDiffView
        key={`${item.from}:${item.to}:${f.path}`}
        file={{ path: f.path, origPath: f.origPath, code: f.code, local: f.local ?? null, submodule: false }}
        area="commit"
        busy={false}
        caption={item.caption}
        load={() => api.diff({ area: 'commit', path: f.path, origPath: f.origPath, from: item.from, to: item.to })}
        onBack={() => setDiff(null)}
        onOpen={f.local ? () => void openFile(target, f.local!) : undefined}
        onNeighbour={delta => setDiff(d => d && { ...d, index: (d.index + delta + d.items.length) % d.items.length })}
        onHistory={file ? undefined : () => openFileHistory(f.path)}
      />
    )
  }

  return (
    <div data-git-history className="flex min-h-0 flex-1 flex-col">
      {/* 搜索和范围 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line-subtle px-3 py-1.5">
        <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line bg-surface px-2 focus-within:border-accent">
          <Search size={13} className="shrink-0 text-fg-faint" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape' && search) {
                e.stopPropagation()
                setSearch('')
              }
            }}
            placeholder={tr('git.history.search')}
            aria-label={tr('git.history.search')}
            className="min-w-0 flex-1 bg-transparent text-meta text-fg outline-none placeholder:text-fg-faint"
          />
          {search && (
            <IconButton
              icon={X}
              label={tr('git.history.clearSearch')}
              size={20}
              iconSize={12}
              onClick={() => setSearch('')}
            />
          )}
        </label>
        <div className="relative shrink-0">
          <button
            type="button"
            aria-haspopup="menu"
            title={scope === 'auto' ? tr('git.history.scope.autoHint') : undefined}
            aria-label={`${tr('git.history.scope.label')} · ${scopeLabel}`}
            onClick={e => {
              const r = e.currentTarget.getBoundingClientRect()
              setScopeMenu({ x: r.left, y: r.bottom + 4 })
            }}
            className="flex h-7 max-w-36 items-center gap-1 rounded-md px-1.5 text-meta text-fg-muted hover:bg-hover hover:text-fg"
          >
            <ListFilter size={13} className="shrink-0" />
            <span className="min-w-0 truncate">{scopeLabel}</span>
          </button>
          {comparePick && refs && (
            <ScopePicker
              refs={refs}
              initial={[]}
              single={tr('git.history.compare.pick')}
              onClose={() => setComparePick(null)}
              onApply={([name]) => {
                const c = comparePick
                setComparePick(null)
                if (name) startCompare(name, c)
              }}
            />
          )}
          {picking && refs && (
            <ScopePicker
              refs={refs}
              initial={Array.isArray(scope) ? scope : []}
              onClose={() => setPicking(false)}
              onApply={names => {
                setPicking(false)
                setScope(names.length ? names : 'auto')
              }}
            />
          )}
        </div>
      </div>
      {file && (
        <div
          data-history-file
          className="flex shrink-0 items-center gap-2 border-b border-line-subtle bg-accent-soft/40 py-1 pr-1.5 pl-3"
        >
          <FileClock size={13} className="shrink-0 text-accent-fg" />
          <span className="shrink-0 text-meta text-fg-muted">{tr('git.history.file.title')}</span>
          <span className="min-w-0 flex-1 truncate text-list text-fg" title={filePath ?? file.path}>
            {filePath ?? file.path}
          </span>
          <IconButton
            icon={X}
            label={tr('git.history.file.close')}
            size={22}
            iconSize={12}
            onClick={() => setFile(null)}
          />
        </div>
      )}
      {stale && (
        <button
          type="button"
          onClick={() => {
            list.current?.scrollTo({ top: 0 })
            void load(true)
          }}
          className="mx-auto -mb-6 mt-1.5 z-10 shrink-0 rounded-full border border-accent-line bg-accent-soft px-2.5 py-0.5 text-meta text-accent-fg shadow-sm"
        >
          {tr('git.history.updated')}
        </button>
      )}

      <div ref={list} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {comparison && (
          <div data-history-compare className="mb-1 rounded-md border border-accent-line">
            <div className="flex h-8 min-w-0 items-center gap-2 pr-1 pl-2 text-list text-fg-secondary">
              <GitCompare size={13} className="shrink-0 text-accent-fg" />
              <span className="min-w-0 flex-1 truncate">
                {tr('git.history.compare.title', { to: shortHash(comparison.to), from: comparison.from })}
              </span>
              <IconButton
                icon={X}
                label={tr('git.history.compare.close')}
                size={22}
                iconSize={12}
                onClick={() => setComparison(null)}
              />
            </div>
            <div className="pl-2">
              {renderCompare(
                'cmp',
                tr('git.history.what.compare', { to: shortHash(comparison.to), from: comparison.from }),
              )}
            </div>
          </div>
        )}
        {base && (
          <div data-history-base className="mb-1 rounded-md border border-line-subtle">
            <div
              role="button"
              tabIndex={0}
              aria-expanded={open.has('@base')}
              onClick={() => toggleCompare('base')}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  toggleCompare('base')
                }
              }}
              className="flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-list text-fg-secondary hover:bg-hover"
            >
              <GitCompare size={13} className="shrink-0 text-fg-muted" />
              <span className="min-w-0 flex-1 truncate">{tr('git.history.base', { base })}</span>
              <ChevronDown
                size={13}
                className={cn('shrink-0 text-fg-muted transition-transform', !open.has('@base') && '-rotate-90')}
              />
            </div>
            {open.has('@base') && <div className="pl-2">{renderCompare('@base', rangeWhat('base'))}</div>}
          </div>
        )}
        {loading === 'first' && !commits.length ? (
          <div className="flex items-center justify-center gap-2 p-6 text-meta text-fg-muted">
            <Spinner size={13} />
            {tr('git.history.loading')}
          </div>
        ) : error && !commits.length ? (
          <div role="alert" className="m-1 rounded-lg border border-danger/40 bg-surface p-2.5">
            <p className="text-list font-medium text-danger">{historyFailure(error).title}</p>
            {historyFailure(error).hint && (
              <p className="mt-0.5 text-meta text-fg-muted">{historyFailure(error).hint}</p>
            )}
            <Button className="mt-2 h-7 px-2.5 text-meta" onClick={() => void load(true)}>
              {tr('git.history.retry')}
            </Button>
          </div>
        ) : !commits.length ? (
          <div className="py-6 text-center">
            <p className="text-list text-fg-muted">
              {tr(query ? 'git.history.noMatch' : file ? 'git.history.file.empty' : 'git.history.empty')}
            </p>
            {!query && !file && <p className="mt-1 text-meta text-fg-faint">{tr('git.history.emptyHint')}</p>}
          </div>
        ) : (
          <div role="list" aria-label={tr('git.tab.history')} className={cn(loading === 'first' && 'opacity-60')}>
            {entries.map(renderEntry)}
          </div>
        )}
        {commits.length > 0 && (
          <div className="flex h-8 items-center justify-center gap-2 text-meta text-fg-faint">
            {loading === 'more' ? (
              <>
                <Spinner size={12} />
                {tr('git.history.loadingMore')}
              </>
            ) : error ? (
              <button type="button" onClick={() => void load(false)} className="text-danger hover:underline">
                {error} · {tr('git.history.retry')}
              </button>
            ) : more ? null : shallow ? (
              tr('git.history.shallow')
            ) : (
              tr('git.history.end')
            )}
          </div>
        )}
      </div>

      {menu && (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          label={tr('git.history.actions')}
          actions={actions(menu.commit)}
          onClose={() => setMenu(null)}
        />
      )}
      {scopeMenu && (
        <ActionMenu
          x={scopeMenu.x}
          y={scopeMenu.y}
          label={tr('git.history.scope.label')}
          onClose={() => setScopeMenu(null)}
          actions={[
            { label: tr('git.history.scope.auto'), checked: scope === 'auto', run: () => setScope('auto') },
            { label: tr('git.history.scope.all'), checked: scope === 'all', run: () => setScope('all') },
            {
              label: tr('git.history.scope.pick'),
              checked: Array.isArray(scope),
              disabled: !refs,
              run: () => setPicking(true),
            },
          ]}
        />
      )}
      {hover && (
        <HoverCard
          commit={hover.commit}
          rect={hover.rect}
          badges={refBadges(hover.commit.refs, refs?.base ?? null, {
            state: states?.get(hover.commit.hash),
            upstream: status.upstream,
          })}
        />
      )}
      {pending && (
        <HistoryActionDialog
          action={pending}
          status={status}
          onCancel={() => setPending(null)}
          onRun={options => runAction(pending, options)}
        />
      )}
      {branchAt && (
        <BranchDialog
          commit={branchAt}
          busySessions={status.busySessions}
          onCancel={() => setBranchAt(null)}
          onCreate={async (name, switchTo) => {
            if (demo) {
              setBranchAt(null)
              toast(tr('git.history.newBranch.done', { name }))
              return null
            }
            const r: GitResult = await api.createBranch({ name, start: branchAt.hash, switch: switchTo })
            if (r.status) onStatus(r.status)
            if (!r.ok) return [failureTitle(r.failure.kind), r.failure.detail].filter(Boolean).join(' · ')
            setBranchAt(null)
            toast(tr('git.history.newBranch.done', { name }))
            void load(true)
            return null
          }}
        />
      )}
    </div>
  )
}

/** 点开一个提交（§9.5）：完整信息、作者、时间、父提交、操作、改动文件 */
function CommitDetail({
  commit: c,
  set,
  files,
  onCopy,
  onReference,
  onReview,
  onBranch,
  onJump,
}: {
  commit: GitCommit
  set: GitChangeSet
  files: ReactNode
  onCopy: (text: string) => void
  onReference: () => void
  onReview: () => void
  onBranch: () => void
  onJump: (hash: string) => void
}) {
  const [full, setFull] = useState(false)
  const lines = c.body.split('\n')
  const long = lines.length > BODY_LINES
  return (
    <div data-commit-detail className="flex flex-col gap-1.5 pt-1 pr-2 pb-2 pl-1">
      {/* 三块分开（GitHub #19）：信息卡（浅底）、描边按钮、文件卡（描边 + 浅底标题行） */}
      <div className="rounded-lg bg-subtle px-2.5 py-2">
        {c.body && (
          <p className="mb-1.5 text-meta break-words whitespace-pre-wrap text-fg-secondary">
            {long && !full ? lines.slice(0, BODY_LINES).join('\n') + '…' : c.body}
          </p>
        )}
        {long && (
          <button
            type="button"
            onClick={() => setFull(!full)}
            className="mb-1.5 -mt-1 text-meta text-accent-fg hover:underline"
          >
            {tr(full ? 'git.history.collapseMessage' : 'git.history.expandMessage')}
          </button>
        )}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-meta">
          <dt className="text-fg-faint">{tr('git.history.author')}</dt>
          <dd className="truncate text-fg-secondary" title={`${c.author} <${c.email}>`}>
            {c.author} <span className="text-fg-faint">&lt;{c.email}&gt;</span>
          </dd>
          <dt className="text-fg-faint">{tr('git.history.date')}</dt>
          <dd className="text-fg-secondary tabular-nums">{fullTime(c.committedAt)}</dd>
          {c.parents.length > 0 && (
            <>
              <dt className="text-fg-faint">{tr('git.history.parents')}</dt>
              <dd className="flex flex-wrap gap-1.5">
                {c.parents.map(p => (
                  <button
                    key={p}
                    type="button"
                    title={tr('git.history.jumpParent', { hash: shortHash(p) })}
                    onClick={() => onJump(p)}
                    className="font-mono text-[11px] text-accent-fg hover:underline"
                  >
                    {shortHash(p)}
                  </button>
                ))}
              </dd>
            </>
          )}
        </dl>
      </div>
      <div className="flex flex-wrap gap-1">
        <SmallAction icon={Copy} onClick={() => onCopy(c.hash)}>
          {tr('git.history.copyHash')}
        </SmallAction>
        <SmallAction icon={MessageSquarePlus} onClick={onReference}>
          {tr('git.history.reference')}
        </SmallAction>
        <SmallAction icon={Sparkles} onClick={onReview}>
          {tr('git.history.review')}
        </SmallAction>
        <SmallAction icon={GitBranchPlus} onClick={onBranch}>
          {tr('git.history.createBranch')}
        </SmallAction>
      </div>
      <div className="overflow-hidden rounded-lg border border-line-card">
        <p className="border-b border-line-subtle bg-subtle px-2.5 py-1 text-meta text-fg-muted">
          <DiffStat {...statOf(set)} />
          {c.parents.length > 1 && <span className="text-fg-faint"> · {tr('git.history.mergeNote')}</span>}
        </p>
        <div className="p-0.5">{files}</div>
      </div>
    </div>
  )
}

/** 详情里的小按钮：窄面板里一行放得下几个；outline 是提交详情里的描边样式（GitHub #19），比较那一行的保持文字按钮 */
function SmallAction({
  icon: Icon,
  onClick,
  outline = true,
  children,
}: {
  icon: typeof Copy
  onClick: () => void
  outline?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-meta text-fg-secondary hover:bg-hover hover:text-fg',
        outline && 'border border-line bg-surface px-2',
      )}
    >
      <Icon size={12} className="shrink-0" />
      {children}
    </button>
  )
}

const statOf = (set: GitChangeSet) => ({
  files: set.files.length,
  ins: set.files.reduce((n, f) => n + (f.insertions ?? 0), 0),
  del: set.files.reduce((n, f) => n + (f.deletions ?? 0), 0),
})

/** 「N 个文件 +x −y」：增删数和文件行一样用绿 / 红（GitHub #36） */
function DiffStat({ files, ins, del }: { files: number; ins: number; del: number }) {
  return (
    <>
      {tr('git.history.files', { files })} <span className="text-success">+{ins}</span>{' '}
      <span className="text-danger">−{del}</span>
    </>
  )
}

/** 主进程的失败类型（notRepo、timeout…）换成 §3 的文案；其余原样显示 */
function historyFailure(message: string): { title: string; hint: string } {
  const kind = /^(missing|notRepo|timeout|locked|unknown)$/.exec(message.trim())?.[1]
  if (!kind) return { title: tr('git.history.loadFailed'), hint: message }
  return { title: failureTitle(kind as never), hint: failureHint(kind as never) }
}

/** 悬停卡片（参照 VS Code）：作者和邮箱、时间、完整提交信息、改动统计、引用 */
function HoverCard({
  commit: c,
  rect,
  badges,
}: {
  commit: GitCommit
  rect: DOMRect
  badges: ReturnType<typeof refBadges>
}) {
  const width = 300
  const left = rect.left - width - 8 >= 8 ? rect.left - width - 8 : Math.min(rect.left, innerWidth - width - 8)
  const below = rect.left - width - 8 < 8
  const style = below
    ? { left, top: Math.min(rect.bottom + 4, innerHeight - 160), width }
    : { left, top: Math.max(8, Math.min(rect.top, innerHeight - 200)), width }
  return createPortal(
    <div
      role="tooltip"
      data-history-hover
      style={style}
      className="pop-in pointer-events-none fixed z-[60] rounded-lg border border-line-card bg-popover p-2.5 text-meta shadow-menu"
    >
      <p className="font-medium text-fg">
        {c.author} <span className="font-normal text-fg-faint">&lt;{c.email}&gt;</span>
      </p>
      <p className="text-fg-faint tabular-nums">
        {commitTime(c.committedAt)} · {fullTime(c.committedAt)}
      </p>
      <p className="mt-1.5 line-clamp-[12] break-words whitespace-pre-wrap text-fg">{fullMessage(c)}</p>
      {c.stat && (
        <p className="mt-1.5 text-fg-muted">
          <DiffStat files={c.stat.files} ins={c.stat.insertions} del={c.stat.deletions} />
        </p>
      )}
      {badges.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {badges.map(b => (
            <RefBadge key={b.kind + b.name} badge={b} className="max-w-full" />
          ))}
        </div>
      )}
      <p className="mt-1.5 font-mono text-[11px] text-fg-faint">{c.hash}</p>
    </div>,
    document.body,
  )
}

/** 自选范围：本地 / 远端分支和标签，多选，可搜索 */
function ScopePicker({
  refs,
  initial,
  single,
  onApply,
  onClose,
}: {
  refs: GitRefs
  initial: string[]
  /** 单选（「和…比较」）：标题；点一下就选定 */
  single?: string
  onApply: (names: string[]) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set(initial))
  // Esc 只关菜单，不再往外传（点外面由 Popover 处理）
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [onClose])
  const match = (name: string) => name.toLowerCase().includes(q.trim().toLowerCase())
  const groups: Array<[string, string[]]> = [
    [tr('git.branch.local'), refs.local.filter(match)],
    [tr('git.branch.remote'), refs.remote.filter(match)],
    [tr('git.history.scope.tags'), refs.tags.filter(match)],
  ]
  return (
    <Popover
      open
      onClose={onClose}
      align="end"
      bare
      role="dialog"
      aria-label={single ?? tr('git.history.scope.pick')}
      className="flex max-h-80 w-64 flex-col overflow-hidden"
    >
      <div className="shrink-0 border-b border-line-subtle p-2">
        <input
          autoFocus
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={tr('git.history.scope.search')}
          aria-label={tr('git.history.scope.search')}
          className="h-8 w-full rounded-md border border-line bg-surface px-2.5 text-list text-fg outline-none focus-visible:border-accent"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {groups.map(
          ([label, names]) =>
            names.length > 0 && (
              <div key={label} className="mt-1">
                <h4 className="px-2 py-1 text-label font-medium text-fg-muted">{label}</h4>
                {names.map(name =>
                  single ? (
                    <button
                      key={label + name}
                      type="button"
                      onClick={() => onApply([name])}
                      className="flex h-7 w-full min-w-0 items-center rounded-md px-2 text-left text-list text-fg hover:bg-hover"
                    >
                      <span className="min-w-0 truncate">{name}</span>
                    </button>
                  ) : (
                    <label
                      key={label + name}
                      className="flex h-7 min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-list text-fg hover:bg-hover"
                    >
                      <input
                        type="checkbox"
                        checked={picked.has(name)}
                        onChange={() =>
                          setPicked(prev => {
                            const next = new Set(prev)
                            if (next.has(name)) next.delete(name)
                            else next.add(name)
                            return next
                          })
                        }
                        className="accent-[var(--accent)]"
                      />
                      <span className="min-w-0 truncate">{name}</span>
                    </label>
                  ),
                )}
              </div>
            ),
        )}
      </div>
      {single && <p className="shrink-0 border-b border-line-subtle px-3 py-1.5 text-meta text-fg-muted">{single}</p>}
      <div className={cn('flex shrink-0 justify-end gap-1.5 border-t border-line-subtle p-2', single && 'hidden')}>
        <Button className="h-7 px-2.5 text-meta" onClick={onClose}>
          {tr('projectTools.cancel')}
        </Button>
        <Button
          variant="primary"
          className="h-7 px-2.5 text-meta"
          disabled={!picked.size}
          onClick={() => onApply([...picked])}
        >
          {tr('git.history.scope.apply')}
        </Button>
      </div>
    </Popover>
  )
}

/** 在某个提交上新建分支（§9.6）：默认不切过去，只新建引用 */
function BranchDialog({
  commit,
  busySessions,
  onCreate,
  onCancel,
}: {
  commit: GitCommit
  busySessions: number
  /** 返回错误文字；成功返回 null */
  onCreate: (name: string, switchTo: boolean) => Promise<string | null>
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [switchTo, setSwitchTo] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      setError(await onCreate(name.trim(), switchTo && busySessions === 0))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <ConfirmDialog
      title={tr('git.history.newBranch.title')}
      description={
        <>
          <p>{tr('git.history.newBranch.body', { hash: shortHash(commit.hash) })}</p>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
            aria-label={tr('git.history.newBranch.name')}
            placeholder={tr('git.history.newBranch.name')}
            className="mt-2 h-8 w-full rounded-md border border-line bg-surface px-2.5 text-list text-fg outline-none focus-visible:border-accent"
          />
          <label className={cn('mt-2 flex items-center gap-2', busySessions > 0 && 'opacity-55')}>
            <input
              type="checkbox"
              checked={switchTo && busySessions === 0}
              disabled={busySessions > 0}
              onChange={e => setSwitchTo(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            {tr('git.history.newBranch.switch')}
          </label>
          {busySessions > 0 && <p className="mt-1 text-fg-muted">{tr('git.history.newBranch.switchBusy')}</p>}
        </>
      }
      confirmLabel={tr('git.history.newBranch.ok')}
      cancelLabel={tr('projectTools.cancel')}
      busy={busy}
      error={error}
      focusInput
      confirmDisabled={!name.trim()}
      onCancel={onCancel}
      onConfirm={() => void submit()}
    />
  )
}
