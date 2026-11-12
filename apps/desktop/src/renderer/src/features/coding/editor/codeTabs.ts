import { useSyncExternalStore } from 'react'
import { isDemo } from '@/data'
import { releaseEditor } from '@/features/editor/code/CodeEditor'
import { confirmFiles } from '@/features/files/FileConfirm'
import {
  FILE_RENAMED_EVENT,
  dirtyFile,
  ensureFile,
  getFiles,
  removeFile,
  type FileRename,
} from '@/features/files/store'
import { showWorkbench } from '@/features/layout/page'
import { panelFileIds } from '@/features/panel/workspaceStore'
import { recordRecentFile } from '@/features/panel/recentFiles'
import { getPaneState } from '@/features/panes/store'
import { leaves } from '@/features/panes/tree'
import type { DiffBase, EditorViewMode } from '../types'
import { swapScroll } from './MirrorView'
import {
  EDITOR_CAP,
  EMPTY_GROUP,
  EMPTY_PANE,
  activateInPane,
  closeInGroup,
  cycleInGroup,
  focusGroup,
  focusedGroup,
  lruToRelease,
  mapGroups,
  openInGroup,
  isGitDiffId,
  paneTabIds,
  parseCodeTabs,
  persistable,
  reopenedView,
  replaceInGroup,
  splitRight,
  updateGroup,
  withView,
  type CodeTabGroup,
  type CodeTabPane,
  type CodeTabsState,
} from './codeTabsModel'

export const CODE_TABS_KEY = isDemo ? 'pixelsky.coding.tabs.v1.demo' : 'pixelsky.coding.tabs.v1'

let panes: Record<string, CodeTabPane> = {}
try {
  panes = parseCodeTabs(JSON.parse(localStorage.getItem(CODE_TABS_KEY) ?? '{}'))
} catch {
  /* 坏数据从空标签开始 */
}
/** 最近用过的标签，最久的在前；只用来决定释放哪个编辑器实例 */
let order: string[] = []
let projectKey = ''
let state: CodeTabsState = { projectKey, group: EMPTY_GROUP, pane: EMPTY_PANE }
const listeners = new Set<() => void>()

function persist(): void {
  try {
    localStorage.setItem(CODE_TABS_KEY, JSON.stringify(persistable(panes)))
  } catch {
    /* 没有持久化也能用 */
  }
}

const currentPane = (): CodeTabPane => panes[projectKey] ?? EMPTY_PANE

function publish(): void {
  const pane = currentPane()
  state = { projectKey, group: focusedGroup(pane), pane }
  listeners.forEach(fn => fn())
}

function setPane(next: CodeTabPane): void {
  if (paneTabIds(next).length) panes = { ...panes, [projectKey]: next }
  else panes = Object.fromEntries(Object.entries(panes).filter(([key]) => key !== projectKey))
  persist()
  publish()
}

/** 改当前那组 */
const setGroup = (next: CodeTabGroup): void => setPane(updateGroup(currentPane(), currentPane().focus, next))

export function useCodeTabs(): CodeTabsState {
  return useSyncExternalStore(
    fn => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    () => state,
  )
}

// 文件改名 / 移动后标签换了 id：所有项目的标签组、视图设置、最近使用顺序里的旧 id 换成新的（审查报告 2026-10-14）
window.addEventListener(FILE_RENAMED_EVENT, e => {
  const moves = (e as CustomEvent<FileRename[]>).detail
  let next = panes
  for (const { from, to } of moves) {
    next = Object.fromEntries(
      Object.entries(next).map(([key, p]) => [key, mapGroups(p, g => replaceInGroup(g, from, to))]),
    )
    order = order.map(id => (id === from ? to : id))
  }
  if (next === panes && !moves.length) return
  panes = next
  persist()
  publish()
})

/** 当前项目换了：切到它的标签组，并把恢复出来的文件读进来 */
export function setCodeProject(key: string): void {
  if (key === projectKey) return
  projectKey = key
  publish()
  for (const id of paneTabIds(currentPane())) if (!isGitDiffId(id)) void ensureFile(id).catch(() => {})
}

/** 用掉一个编辑器名额后，超出上限的按最近最少使用释放 */
function touch(id: string): void {
  if (isGitDiffId(id)) return
  order = [...order.filter(x => x !== id), id]
  const dirty = new Set(
    getFiles()
      .tabs.filter(dirtyFile)
      .map(t => t.id),
  )
  const drop = lruToRelease(order, id, dirty, EDITOR_CAP)
  for (const gone of drop) releaseEditor(gone)
  if (drop.length) order = order.filter(x => !drop.includes(x))
}

/** 注册成 code opener：openFile 的结果落到中栏 */
export function openCodeTab(id: string): void {
  // 停在「变更 / 并排」的回到文件本身（docs/ui/coding-mode.md §3.3.2）
  const group = focusedGroup(currentPane())
  setGroup(openInGroup(withView(group, id, reopenedView(group.views?.[id])), id))
  recordRecentFile(projectKey, id)
  touch(id)
  showWorkbench()
}

/** 激活第 index 组（默认当前那组）的一个标签，那组同时成为当前 */
export function activateCodeTab(id: string, index = currentPane().focus): void {
  const next = activateInPane(currentPane(), index, id)
  if (next === currentPane()) return
  setPane(next)
  if (!isGitDiffId(id)) recordRecentFile(projectKey, id)
  touch(id)
}

/** 点到某一组里（编辑器、空白处）：那组成为当前 */
export function focusCodeGroup(index: number): void {
  const pane = currentPane()
  const next = focusGroup(pane, index)
  if (next === pane) return
  // 两组是同一个文件：真编辑器和只读副本换位置，各自的滚动位置跟着换
  const active = focusedGroup(next).active
  if (active && active === focusedGroup(pane).active && !isGitDiffId(active)) swapScroll(active)
  setPane(next)
  if (active) touch(active)
}

/** 向右分屏：当前标签在右边再开一组（同一个文件 id，草稿共用） */
export function splitCodeRight(): void {
  const next = splitRight(currentPane())
  if (next === currentPane()) return
  const active = focusedGroup(next).active
  if (active && !isGitDiffId(active)) swapScroll(active)
  setPane(next)
}

export function cycleCodeTab(delta: 1 | -1): void {
  const group = focusedGroup(currentPane())
  const next = cycleInGroup(group, delta)
  if (next.active && next.active !== group.active) activateCodeTab(next.active)
}

/**
 * 关闭一个标签；有未保存改动时先问；返回是否真的关了。
 * 传了 index 只关那一组的（分屏时另一组还开着同一个文件就不问、也不释放文件），不传就每组都关
 */
export async function closeCodeTab(id: string, index?: number): Promise<boolean> {
  const elsewhere = index !== undefined && currentPane().groups.some((g, i) => i !== index && g.tabs.includes(id))
  if (!elsewhere && !(await confirmFiles([id]))) return false
  // await 之后重新读：确认框开着时标签可能已经变了
  const pane = currentPane()
  if (paneTabIds(pane).includes(id)) {
    const before = focusedGroup(pane).active
    const next =
      index === undefined
        ? mapGroups(pane, g => closeInGroup(g, id))
        : updateGroup(pane, index, closeInGroup(pane.groups[index] ?? EMPTY_GROUP, id))
    setPane(next)
    const active = focusedGroup(next).active
    if (active && active !== before) touch(active)
  }
  if (elsewhere) return true
  order = order.filter(x => x !== id)
  const stillUsed =
    panelFileIds().includes(id) ||
    leaves(getPaneState().layout.root).some(leaf => leaf.tabs.includes(id)) ||
    Object.values(panes).some(p => paneTabIds(p).includes(id))
  if (!stillUsed && !isGitDiffId(id)) removeFile(id)
  return true
}

/** 改第 index 组（默认当前那组）里一个标签的视图 */
export function setCodeView(id: string, mode: EditorViewMode, base?: DiffBase, index = currentPane().focus): void {
  const group = currentPane().groups[index]
  if (group?.tabs.includes(id))
    setPane(
      updateGroup(currentPane(), index, withView(group, id, { mode, base: base ?? group.views?.[id]?.base ?? 'head' })),
    )
}

/** 打开 / 激活一个非文件标签（Git 对比）：不进最近文件，也不占编辑器名额 */
export function openPseudoTab(id: string): void {
  setGroup(openInGroup(focusedGroup(currentPane()), id))
  showWorkbench()
}

/** 当前项目里把一个非文件标签换成另一个（Git 对比的文件换了区） */
export function replaceCodeTab(from: string, to: string): void {
  const pane = panes[projectKey]
  if (pane) setPane(mapGroups(pane, g => replaceInGroup(g, from, to)))
}

/** 所有项目里开着的标签 id（清理 Git 对比的数据用） */
export const allCodeTabIds = (): Set<string> => new Set(Object.values(panes).flatMap(paneTabIds))
