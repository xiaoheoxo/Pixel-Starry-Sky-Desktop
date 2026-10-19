import { useSyncExternalStore } from 'react'
import type { WorkspaceRef } from '../../../../../shared/types/workspace'
import type { GitCommitFile, GitFileChange } from '../../../../../shared/types/project-tools'
import { allCodeTabIds, closeCodeTab, openPseudoTab, replaceCodeTab, useCodeTabs } from './codeTabs'
import { isGitDiffId } from './codeTabsModel'
import { gitDiffId, planSync, type GitDiffArea } from './gitDiffModel'
import { refKey } from '@/features/editor/refKey'
import { splitExtra } from '@/features/files/extraFolderPaths'

/**
 * 代码模式中栏的「Git 对比」标签：只读，不是文件。
 * 标签 id 放在中栏标签组里（和文件标签同一个顺序 / 激活 / 关闭），数据放在这里；不持久化，重启后不恢复。
 */
export interface GitDiffTabData {
  id: string
  refKey: string
  ref: WorkspaceRef
  demo: boolean
  area: GitDiffArea
  path: string
  origPath: string | null
  code: string
  /** 相对工作区的路径，能在编辑器里打开；历史里的文件没有 */
  local: string | null
  from: string | null
  to: string | null
  /** 历史里写是哪个提交 / 哪两个版本 */
  caption?: string
}

export type GitDiffTabInput = Omit<GitDiffTabData, 'id'>

const tabs = new Map<string, GitDiffTabData>()
let rev = 0
const listeners = new Set<() => void>()
const emit = (): void => {
  rev++
  listeners.forEach(fn => fn())
}
const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 订阅对比标签的增删改（标签栏要按 id 读名字和标记） */
export const useGitDiffRev = (): number => useSyncExternalStore(subscribe, () => rev)

export const getGitDiffTab = (id: string): GitDiffTabData | undefined => tabs.get(id)

/** 订阅某个 Git 对比标签的数据；标签换了区（id 变了）由调用方的 key 重新挂载 */
export function useGitDiffTab(id: string): GitDiffTabData | undefined {
  return useSyncExternalStore(subscribe, () => tabs.get(id))
}

/** 打开一个对比标签；同一文件 + 区（+ 提交）已经开着就只是激活它 */
export function openGitDiffTab(input: GitDiffTabInput): string {
  const id = gitDiffId(input)
  // 顺手清掉已经关掉的标签的数据
  const open = allCodeTabIds()
  for (const key of tabs.keys()) if (key !== id && !open.has(key)) tabs.delete(key)
  tabs.set(id, { ...input, id })
  emit()
  openPseudoTab(id)
  return id
}

/** 当前激活的是哪个 Git 对比（左栏高亮这一行）；不是对比标签或不是这个工作区时 undefined */
export function useCurrentGitDiff(refKey: string): GitDiffTabData | undefined {
  const { group } = useCodeTabs()
  useSyncExternalStore(subscribe, () => rev)
  const id = group.active
  const data = id && isGitDiffId(id) ? tabs.get(id) : undefined
  return data && data.refKey === refKey ? data : undefined
}

/** 每个工作区（Git 面板的 key）读到第几次状态：对比标签据此重读内容（文件还在同一区、字母没变时也能跟上新内容） */
const revisions = new Map<string, number>()

/** 这个工作区的状态版本；没读过状态时 0 */
export const gitStatusRevision = (refKey: string): number => revisions.get(refKey) ?? 0

export function useGitStatusRevision(refKey: string): number {
  useSyncExternalStore(subscribe, () => rev)
  return gitStatusRevision(refKey)
}

/** 每个工作区最近一次看到的 HEAD（提交号；空仓库为 null） */
const heads = new Map<string, string | null>()

/** Git 面板读到状态后调用：HEAD 换了（提交、切分支、拉取、终端里提交）返回 true；第一次看到这个工作区不算 */
export function noteGitHead(refKey: string, head: string | null): boolean {
  const before = heads.get(refKey)
  heads.set(refKey, head)
  return before !== undefined && before !== head
}

/**
 * Git 面板读到新状态后调用：工作区的对比标签跟着文件走（规则见 gitDiffModel.planSync）。
 * 文件暂存 / 取消暂存后标签换到新区，还原 / 提交后关掉
 */
export function syncGitDiffTabs(
  refKey: string,
  sections: { area: GitDiffArea; files: (Pick<GitFileChange, 'path' | 'code'> & { local?: string | null })[] }[],
): void {
  // 样式 A 的文件标签要知道这个文件在哪个区（顶上的暂存 / 撤销更改按钮）：按工作区里的路径记一份
  const work = new Map<string, WorkFile>()
  for (const s of sections)
    if (s.area !== 'staged' && s.area !== 'commit')
      for (const f of s.files) if (f.local && !work.has(f.local)) work.set(f.local, { area: s.area, path: f.path })
  workFiles.set(refKey, work)
  revisions.set(refKey, (revisions.get(refKey) ?? 0) + 1)
  const lookup = (path: string) => (area: GitDiffArea) =>
    sections.find(s => s.area === area)?.files.find(f => f.path === path)?.code ?? null
  for (const data of [...tabs.values()]) {
    if (data.refKey !== refKey || data.area === 'commit') continue
    const plan = planSync(data.area, data.code, lookup(data.path))
    if (plan.kind === 'keep') continue
    if (plan.kind === 'refresh') {
      tabs.set(data.id, { ...data, code: plan.code })
    } else if (plan.kind === 'close') {
      tabs.delete(data.id)
      void closeCodeTab(data.id)
    } else {
      const next: GitDiffTabData = { ...data, area: plan.area, code: plan.code, id: '' }
      next.id = gitDiffId(next)
      tabs.delete(data.id)
      tabs.set(next.id, next)
      replaceCodeTab(data.id, next.id)
    }
  }
  emit()
}

// ---- 样式 A：工作区改动打开成中栏的文件标签（docs/ui/coding-mode.md §3.3.2）----
export interface WorkFile {
  area: Exclude<GitDiffArea, 'staged' | 'commit'>
  /** 相对仓库根目录（暂存 / 撤销用这个） */
  path: string
}
const workFiles = new Map<string, Map<string, WorkFile>>()

// 会话在项目文件夹里时，文件标签记的是项目（files.target 换过），Git 面板记的是会话：文件标签的 key → Git 面板的 key
const panelKeys = new Map<string, string>()

/** Git 面板查到自己的工作区在文件标签里记成哪个 key 后调用 */
export function setGitFileKey(panelKey: string, fileKey: string): void {
  if (fileKey === panelKey || panelKeys.get(fileKey) === panelKey) return
  panelKeys.set(fileKey, panelKey)
  emit()
}

/** 文件标签的 key 对应哪个 Git 面板的 key（没有别名就是它自己） */
export const gitPanelKey = (fileKey: string): string => panelKeys.get(fileKey) ?? fileKey

/**
 * 文件标签在不在这个 Git 面板的工作区里（会话在项目文件夹里时文件标签记的是项目，见 setGitFileKey）。
 * 附加文件夹里的文件：文件树打开的标签记成项目 + 「::N/…」，对应的 Git 面板是「#N」
 */
export const inGitWorkspace =
  (panelKey: string) =>
  (tab: { ref: WorkspaceRef; path: string }): boolean => {
    const extra = tab.ref.folder ? null : splitExtra(tab.path).index
    return gitPanelKey(refKey(extra === null ? tab.ref : { ...tab.ref, folder: extra })) === panelKey
  }

/** 这个工作区里的这个文件（相对工作区的路径）有没有未暂存的改动；Git 面板没挂着（没读过状态）时 null */
export function useWorkFile(fileKey: string, local: string): WorkFile | null {
  useSyncExternalStore(subscribe, () => rev)
  return workFiles.get(gitPanelKey(fileKey))?.get(local) ?? null
}

/** 从 Git 面板的行 / 历史里的文件拼出对比标签的数据 */
export const workDiffInput = (
  ref: WorkspaceRef,
  refKey: string,
  demo: boolean,
  area: GitDiffArea,
  file: GitFileChange,
): GitDiffTabInput => ({
  ref,
  refKey,
  demo,
  area,
  path: file.path,
  origPath: file.origPath,
  code: file.code,
  local: file.local,
  from: null,
  to: null,
})

export const commitDiffInput = (
  ref: WorkspaceRef,
  refKey: string,
  demo: boolean,
  file: GitCommitFile,
  from: string | null,
  to: string,
  caption?: string,
): GitDiffTabInput => ({
  ref,
  refKey,
  demo,
  area: 'commit',
  path: file.path,
  origPath: file.origPath,
  code: file.code,
  local: file.local ?? null,
  from,
  to,
  caption,
})

// ---- Git 面板登记的动作：暂存 / 取消暂存 / 还原 / 看历史由它执行（它管着状态、确认框和演示数据）----
export interface GitFileActions {
  stage(path: string): void
  unstage(path: string): void
  /** 会先弹确认框 */
  discard(path: string, area: 'unstaged' | 'untracked'): void
  history(path: string): void
}
const actions = new Map<string, { actions: GitFileActions; busy: boolean }>()

export function registerGitFileActions(refKey: string, value: GitFileActions | null): void {
  if (value) actions.set(refKey, { actions: value, busy: actions.get(refKey)?.busy ?? false })
  else actions.delete(refKey)
  emit()
}

export function setGitActionsBusy(refKey: string, busy: boolean): void {
  const cur = actions.get(refKey)
  if (!cur || cur.busy === busy) return
  actions.set(refKey, { ...cur, busy })
  emit()
}

export function useGitFileActions(refKey: string): { actions: GitFileActions | null; busy: boolean } {
  return useSyncExternalStore(subscribe, () => actions.get(refKey)) ?? { actions: null, busy: false }
}
