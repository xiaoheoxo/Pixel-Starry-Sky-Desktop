import { tr } from '../../i18n/core'
// 多对话窗格的状态：布局树 + 关闭中 / 拖动中的标记，存 localStorage，重启恢复。规格见 docs/ui/multi-pane.md
import { useSyncExternalStore } from 'react'
import { isDemo, projects } from '@/data'
import { composerDraft, migrateNewComposerDraft } from '@/features/engine/drafts'
import { cssDuration, motionEnabled } from './motion'
import * as T from './tree'
import type { Dir, Layout } from './tree'
import { dropLayout, dropProblem, MIN_PANE, type DropTarget } from './drop'
import { openFileLayout } from './file-layout'
import { confirmFiles } from '@/features/files/FileConfirm'
import { dirtyFile, getFiles, removeFile } from '@/features/files/store'
import { bindDraftWorkspace, draftWorkspace } from '@/features/machines/drafts'
import { getEngineState, setCurrentProject } from '@/features/engine/store'
import { hasAttachmentDraft } from '@/features/session/attachments/drafts'
import type { SessionRecord } from '@pixelsky/protocol'
import type { WorkspaceChoice } from '../../../../shared/types/machines'
import { getMachines } from '@/features/machines/store'
import { showWorkbench } from '@/features/layout/page'

export { MIN_PANE } from './drop'

export interface PaneState {
  layout: Layout
  /** 正在播放关闭动画的窗格（占比已收拢到 0，动画结束后从布局里删掉） */
  closing: Record<string, true>
  /** 一次性提示（如「窗口放不下更多窗格了」），null 表示没有 */
  notice: { id: number; text: string } | null
}

// 演示模式和真实数据的布局分开存，互不覆盖
let STORAGE_KEY = isDemo ? 'pixelsky.panes.demo' : 'pixelsky.panes'

let seq = 0
const newId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`

function load(initialTab: string | null): Layout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? T.parseLayout(JSON.parse(raw)) : null
    if (parsed) return parsed
  } catch {
    // localStorage 不可用或内容损坏：用默认布局
  }
  return T.initialLayout(newId('p'), initialTab)
}

let state: PaneState = { layout: T.initialLayout('p0', null), closing: {}, notice: null }
let started = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

let saveTimer: number | undefined
function save(): void {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    try {
      // 关闭动画还没播完的窗格不保存
      let layout = state.layout
      for (const file of getFiles().tabs)
        if (file.ref.projectId && T.parseFileTab(file.id)?.ref.sessionId)
          layout = T.replaceTab(layout, file.id, T.fileTab(file.ref, file.path))
      for (const id of Object.keys(state.closing)) layout = T.removeLeaf(layout, id, newId('p'))
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, root: layout.root, focused: layout.focused }))
    } catch {
      // 存不了就算了，下次启动用默认布局
    }
  }, 300)
}

function setLayout(layout: Layout, persist = true): void {
  if (layout === state.layout) return
  state = { ...state, layout }
  emit()
  if (persist) save()
  else window.clearTimeout(saveTimer)
}

/** 启动时调用一次：读出保存的布局；initialTab 是没有保存记录时默认打开的标签 */
export function startPanes(initialTab: string | null): void {
  if (started) return
  started = true
  state = { ...state, layout: load(initialTab) }
  const focused = T.focusedTab(state.layout)
  const newTab =
    focused && T.isNewTab(focused)
      ? focused
      : T.leaves(state.layout.root)
          .flatMap(l => l.tabs)
          .find(T.isNewTab)
  if (!isDemo && newTab) migrateNewComposerDraft(newTab)
  emit()
}

export function getPaneState(): PaneState {
  return state
}

export function usePaneState<T>(selector: (s: PaneState) => T): T {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => selector(state),
  )
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

export function notify(text: string): void {
  state = { ...state, notice: { id: (state.notice?.id ?? 0) + 1, text } }
  emit()
}

/** 这个对话标签的任务还在跑（运行中、等你确认、有后台任务）：关掉标签不会停它 */
function sessionRunning(tab: string): boolean {
  if (T.isFileTab(tab) || T.isNewTab(tab)) return false
  const engine = getEngineState()
  const summary = engine.sessions.find(s => s.record.id === tab)
  if (summary)
    return summary.state !== 'idle' || !!summary.background || (engine.snapshots[tab]?.pending.length ?? 0) > 0
  return isDemo && projects.some(p => p.sessions.some(s => s.id === tab && s.status === 'running'))
}

/**
 * 标签在用吗（「关闭不活跃的标签页」留下这些，GitHub #32）：对话在运行 / 等你确认 / 有没看的回复，
 * 文件有没保存的改动，新对话的输入框里有草稿
 */
export function tabInUse(tab: string): boolean {
  if (T.isFileTab(tab)) {
    const file = getFiles().tabs.find(t => t.id === tab)
    return !!file && dirtyFile(file)
  }
  if (T.isNewTab(tab)) return !!composerDraft(tab).trim() || hasAttachmentDraft(tab)
  return sessionRunning(tab) || !!getEngineState().unread[tab]
}

/**
 * 新会话标签用哪个项目、哪个工作目录：从会话里新开的沿用那个会话的目录；
 * 否则用这台机器上次选的工作目录（同一个项目时），再不然用项目目录。
 */
function bindNewTab(tab: string, record: SessionRecord | null, projectId: string | null, explicit: boolean): void {
  const engine = getEngineState()
  const project = engine.projects.find(p => p.id === projectId)
  if (!project) return
  let chosen: WorkspaceChoice | null = null
  try {
    chosen = JSON.parse(localStorage.getItem('pixelsky.last-workspace.' + getMachines().currentId) ?? 'null')
  } catch {}
  bindDraftWorkspace(
    tab,
    {
      projectId: project.id,
      name: project.name,
      path: record?.cwd ?? (chosen?.projectId === project.id ? chosen.path : project.path),
      copyId: chosen?.projectId === project.id && (!record || chosen.path === record.cwd) ? chosen.copyId : null,
      branch: chosen?.branch ?? null,
      error: null,
      sessionId: record?.id,
    },
    explicit,
  )
  // 指定了项目（侧栏项目行）：当前项目也换过去，欢迎页跟着变（它订阅的是当前项目）
  if (explicit) setCurrentProject(project.id)
}

export const paneActions = {
  switchMachine(id: string): void {
    window.clearTimeout(saveTimer)
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ v: 1, root: state.layout.root, focused: state.layout.focused }),
      )
    } catch {}
    STORAGE_KEY = id === 'local' ? 'pixelsky.panes' : 'pixelsky.panes.' + id
    state = { ...state, layout: load(null), closing: {}, notice: null }
    emit()
  },
  /** Transfer an editor without closing its document or losing undo history. */
  detachFileTab(tab: string): void {
    if (!T.isFileTab(tab)) return
    let layout = state.layout
    for (const leaf of T.leaves(layout.root)) {
      if (!leaf.tabs.includes(tab)) continue
      layout = T.closeTab(layout, leaf.id, tab)
      if (!T.findLeaf(layout.root, leaf.id)?.tabs.length && T.leaves(layout.root).length > 1)
        layout = T.removeLeaf(layout, leaf.id, newId('p'))
    }
    setLayout(layout)
  },
  openFileTab(tab: string): void {
    showWorkbench()
    const area = document.querySelector('.pane-area')?.getBoundingClientRect()
    // 面板正在开合时按最终宽度检查，否则快速点文件会错误地落回单窗格。
    const remaining = [...document.querySelectorAll<HTMLElement>('.collapsible-slot')].reduce(
      (sum, slot) => sum + slot.getBoundingClientRect().width - (Number.parseFloat(slot.style.width) || 0),
      0,
    )
    const leafId = newId('p'),
      anchorId = state.layout.focused
    const next = openFileLayout(
      state.layout,
      tab,
      { width: (area?.width ?? window.innerWidth - 300) + remaining, height: area?.height ?? window.innerHeight - 48 },
      leafId,
      newId('s'),
    )
    if (!T.findLeaf(next.root, leafId) || !motionEnabled()) {
      setLayout(next)
      return
    }
    setLayout(T.splitStart(next, leafId, anchorId))
    const goal = T.parentSplit(next.root, leafId)
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const now = T.parentSplit(state.layout.root, leafId)
        if (goal && now && now.id === goal.id && now.children.length === goal.children.length)
          setLayout(T.setSizes(state.layout, now.id, goal.sizes))
      }),
    )
  },
  focus(leafId: string): void {
    setLayout(T.focusLeaf(state.layout, leafId))
  },
  focusIndex(n: number): void {
    setLayout(T.focusIndex(state.layout, n))
  },
  cycleFocus(delta: number): void {
    setLayout(T.cycleFocus(state.layout, delta))
  },

  /**
   * 打开会话（侧栏点击）；null 表示新会话（欢迎页）。
   * project：在这个项目下新建会话（侧栏项目行的「新建会话」）。当前窗格是还没写东西的新会话时直接换到这个项目，
   * 写了东西的另开一个，免得草稿跟着换了项目。
   */
  open(sessionId: string | null, opts: { project?: string } = {}): void {
    // 在协作频道页打开会话 / 新任务时先切回工作台（docs/ui/channels.md §2）
    showWorkbench()
    const { layout } = state
    if (sessionId) {
      setLayout(T.openTab(layout, sessionId))
      return
    }
    const current = T.focusedTab(layout)
    if (current && T.isNewTab(current)) {
      // 当前窗格已经在显示一个新会话：不再多开一个
      if (!opts.project || isDemo) return
      if (draftWorkspace(current)?.projectId === opts.project) {
        setCurrentProject(opts.project)
        return
      }
      if (!composerDraft(current).trim() && !hasAttachmentDraft(current)) {
        bindNewTab(current, null, opts.project, true)
        return
      }
    }
    const tab = newId(T.NEW_TAB_PREFIX)
    if (!isDemo) {
      const engine = getEngineState(),
        record =
          current && !opts.project
            ? (engine.snapshots[current]?.record ?? engine.sessions.find(s => s.record.id === current)?.record)
            : null
      bindNewTab(tab, record ?? null, opts.project ?? record?.projectId ?? engine.currentProjectId, !!opts.project)
    }
    if (!isDemo) migrateNewComposerDraft(tab)
    setLayout(T.openTab(layout, tab))
  },
  activate(leafId: string, tab: string): void {
    setLayout(T.activateTab(state.layout, leafId, tab))
  },
  replace(from: string, to: string): void {
    setLayout(T.replaceTab(state.layout, from, to))
  },
  cycleTab(delta: number): void {
    setLayout(T.cycleTab(state.layout, state.layout.focused, delta))
  },

  /** 移动只改变布局，不发送、停止或重建引擎任务。提交时再校验一次当前布局。 */
  async dropTab(tab: string, target: DropTarget, area: { width: number; height: number }): Promise<void> {
    const source = T.leafOfTab(state.layout.root, tab)
    if (!source || state.closing[source.id] || state.closing[target.leafId]) return
    if (
      T.isFileTab(tab) &&
      (source.id !== target.leafId || target.edge) &&
      !(await confirmFiles([tab], tr('panes.store.moveTab')))
    )
      return
    if (!T.leafOfTab(state.layout.root, tab) || state.closing[target.leafId]) return
    const problem = dropProblem(state.layout, tab, target, area)
    if (problem) {
      notify(problem)
      return
    }
    const leafId = newId('p')
    const next = dropLayout(state.layout, tab, target, leafId, newId('s'), area)
    if (!target.edge || next === state.layout || !motionEnabled()) {
      setLayout(next)
      return
    }
    setLayout(T.splitStart(next, leafId, target.leafId))
    const goal = T.parentSplit(next.root, leafId)
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const now = T.parentSplit(state.layout.root, leafId)
        if (
          goal &&
          now &&
          now.id === goal.id &&
          now.children.every((c, i) => c.id === goal.children[i]?.id) &&
          now.children.length === goal.children.length
        ) {
          setLayout(T.setSizes(state.layout, now.id, goal.sizes))
        }
      }),
    )
  },

  /** 关闭标签；窗格空了、而且还有别的窗格时，连窗格一起关掉 */
  async closeTab(leafId: string, tab: string): Promise<void> {
    if (T.isFileTab(tab) && !(await confirmFiles([tab]))) return
    if (!T.findLeaf(state.layout.root, leafId)?.tabs.includes(tab)) return
    const next = T.closeTab(state.layout, leafId, tab)
    if (T.isFileTab(tab)) removeFile(tab)
    const leaf = T.findLeaf(next.root, leafId)
    if (leaf && leaf.tabs.length === 0 && T.leaves(next.root).length > 1) {
      state = { ...state, layout: next }
      paneActions.closePane(leafId)
      return
    }
    setLayout(next)
  },

  /**
   * 批量关闭（GitHub #32）：没保存的文件整批确认一次；一次改完布局；窗格关空了、还有别的窗格时连窗格一起关。
   * 关掉的对话标签里有还在跑的，提示一句（关标签不停任务）
   */
  async closeTabs(leafId: string, kind: T.BulkClose, anchor: string | null = null): Promise<void> {
    const leaf = T.findLeaf(state.layout.root, leafId)
    if (!leaf) return
    const targets = T.tabsToClose(leaf, kind, anchor, tabInUse)
    if (!targets.length) return
    const files = targets.filter(T.isFileTab)
    if (files.length && !(await confirmFiles(files))) return
    const current = T.findLeaf(state.layout.root, leafId)
    const closing = targets.filter(t => current?.tabs.includes(t))
    if (!closing.length) return
    const running = closing.filter(sessionRunning).length
    const next = T.closeTabs(state.layout, leafId, closing)
    for (const tab of closing) if (T.isFileTab(tab)) removeFile(tab)
    const after = T.findLeaf(next.root, leafId)
    if (after && after.tabs.length === 0 && T.leaves(next.root).length > 1) {
      state = { ...state, layout: next }
      paneActions.closePane(leafId)
    } else setLayout(next)
    if (running) notify(tr('panes.store.closedRunning', { p0: running }))
  },

  /** Ctrl+W：关当前窗格的当前标签；窗格是空的就关窗格 */
  closeCurrent(): void {
    const leaf = T.findLeaf(state.layout.root, state.layout.focused)
    if (!leaf) return
    if (leaf.active) paneActions.closeTab(leaf.id, leaf.active)
    else if (T.leaves(state.layout.root).length > 1) paneActions.closePane(leaf.id)
  },

  /**
   * 拆分当前窗格。先按像素检查放不放得下（每个窗格至少 400×300），放不下就提示。
   * 有动画时分两步：先以占比 0 插入新窗格，下一帧再切到目标占比，CSS 过渡让它从 0 展开。
   */
  split(dir: Dir, container: { width: number; height: number }): void {
    const { layout } = state
    const rect = T.computeRects(layout.root).panes.get(layout.focused)
    if (!rect) return
    const room =
      dir === 'row'
        ? (rect.w * container.width) / 2 >= MIN_PANE.width
        : (rect.h * container.height) / 2 >= MIN_PANE.height
    if (!room) {
      notify(tr('panes.store.notEnoughSpaceFor'))
      return
    }
    const leafId = newId('p')
    const target = T.splitLeaf({ ...layout, maximized: null }, layout.focused, dir, leafId, newId('s'))
    if (!motionEnabled()) {
      setLayout(target)
      return
    }
    setLayout(T.splitStart(target, leafId))
    // 两帧：第一帧让浏览器先按「占比 0」布局，第二帧再改，过渡才会生效。
    // 中间用户可能又做了别的操作，所以只把新窗格所在 split 的占比改成目标值，不整个覆盖
    const goal = T.parentSplit(target.root, leafId)
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const now = T.parentSplit(state.layout.root, leafId)
        if (goal && now && now.id === goal.id && now.children.length === goal.sizes.length) {
          setLayout(T.setSizes(state.layout, now.id, goal.sizes))
        }
      }),
    )
  },

  /**
   * 分屏打开会话（侧栏会话右键菜单）：已经显示在某个窗格里就聚焦那个窗格；
   * 否则在当前窗格右侧分出新窗格打开，宽度不够往下分，都放不下就提示
   */
  openInSplit(sessionId: string, container: { width: number; height: number }): void {
    showWorkbench()
    const owner = T.leafOfTab(state.layout.root, sessionId)
    if (owner) {
      setLayout(T.activateTab(state.layout, owner.id, sessionId))
      return
    }
    const rect = T.computeRects(state.layout.root).panes.get(state.layout.focused)
    if (!rect) return
    const dir: Dir | null =
      (rect.w * container.width) / 2 >= MIN_PANE.width
        ? 'row'
        : (rect.h * container.height) / 2 >= MIN_PANE.height
          ? 'col'
          : null
    if (!dir) {
      notify(tr('panes.store.notEnoughSpaceFor'))
      return
    }
    paneActions.split(dir, container)
    // 拆分后新窗格已是当前窗格，把会话开在里面
    setLayout(T.openTab(state.layout, sessionId))
  },

  /** 关闭窗格：先收拢到 0（有动画时），动画结束后再从布局里删掉；里面的会话继续在后台运行 */
  async closePane(leafId: string): Promise<void> {
    const fileTabs = T.findLeaf(state.layout.root, leafId)?.tabs.filter(T.isFileTab) ?? []
    if (!(await confirmFiles(fileTabs, tr('panes.PaneView.closePane')))) return
    if (state.closing[leafId]) return
    const all = T.leaves(state.layout.root)
    if (!all.some(l => l.id === leafId)) return
    // 文件条目等布局里没了这些标签再删：收拢动画期间窗格还在布局里，先删的话 FileLifecycle 会按布局把条目重建，
    // 留下没有标签引用、永远不清理的条目。动画期间标签可能被拖到别的窗格，只删布局里已经不在的
    const dropFiles = (): void => {
      const left = new Set(T.leaves(state.layout.root).flatMap(l => l.tabs))
      fileTabs.filter(tab => !left.has(tab)).forEach(removeFile)
    }
    if (all.length === 1) {
      // 只剩一个窗格：清空标签，保留窗格
      setLayout(T.removeLeaf(state.layout, leafId, newId('p')))
      dropFiles()
      return
    }
    const remove = (): void => {
      const { [leafId]: _done, ...closing } = state.closing
      state = { ...state, closing }
      setLayout(T.removeLeaf(state.layout, leafId, newId('p')))
      dropFiles()
    }
    if (!motionEnabled()) {
      remove()
      return
    }
    // 焦点先移到相邻窗格，收拢中的窗格不再响应操作
    const order = all.findIndex(l => l.id === leafId)
    const neighbor = (all[order - 1] ?? all[order + 1]).id
    let layout = T.collapseLeaf(state.layout, leafId)
    if (layout.focused === leafId) layout = T.focusLeaf(layout, neighbor)
    if (layout.maximized === leafId) layout = { ...layout, maximized: null }
    state = { ...state, closing: { ...state.closing, [leafId]: true } }
    setLayout(layout)
    window.setTimeout(remove, cssDuration('--dur-collapse', 170) + 30)
  },

  toggleMaximize(leafId?: string): void {
    setLayout(T.toggleMaximize(state.layout, leafId ?? state.layout.focused))
  },
  restore(): void {
    if (state.layout.maximized) setLayout({ ...state.layout, maximized: null })
  },
  setSizes(splitId: string, sizes: number[]): void {
    setLayout(T.setSizes(state.layout, splitId, sizes))
  },
  equalize(splitId: string): void {
    setLayout(T.equalize(state.layout, splitId))
  },
  /** 去掉已经不存在的会话标签（真实引擎启动、会话列表读出来以后调用一次） */
  closeSessions(ids: Set<string>): void {
    const before = state.layout
    let next = T.pruneTabs(before, tab => T.isFileTab(tab) || !ids.has(tab))
    for (const leaf of T.leaves(next.root))
      if (!leaf.tabs.length && T.findLeaf(before.root, leaf.id)?.tabs.some(tab => ids.has(tab)))
        next = T.openTab({ ...next, focused: leaf.id }, newId('new:'))
    setLayout({ ...next, focused: before.focused }, !isDemo)
  },
  prune(keep: (tab: string) => boolean): void {
    setLayout(T.pruneTabs(state.layout, tab => T.isFileTab(tab) || keep(tab)))
  },
}
