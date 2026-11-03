// 左栏搜索的「替换」写文件（docs/ui/coding-tier1.md §3）：先全部读好、算好，确认后再逐个用读到的版本号保存。
// 编辑器里有没保存改动的文件不动；版本对不上（期间被改过）的跳过并报出来。
import type { WorkspaceRef } from '../../../../../../shared/types/workspace'
import { tr } from '@/i18n/core'
import { checkFile, dirtyFile, openFilesUnder } from '@/features/files/store'
import { replaceInText, searchRegExp, type SearchOptions } from '@/features/search/replaceModel'

export interface ReplaceTarget {
  path: string
  /** 只换这些行（结果被截断时）；null 换整个文件 */
  lines: ReadonlySet<number> | null
}

export interface ReplaceEdit {
  path: string
  text: string
  version: string
  count: number
}

export interface ReplacePlan {
  /** 编辑器标签记的工作区（会话在项目主文件夹里跑时是项目，不是会话），按它找打开着的标签 */
  tabRef: WorkspaceRef
  edits: ReplaceEdit[]
  /** 编辑器里有没保存的改动，没替换 */
  dirty: string[]
  failed: Array<{ path: string; message: string }>
}

const openDirty = (ref: WorkspaceRef, path: string): boolean =>
  openFilesUnder(ref, path).some(tab => tab.path === path && dirtyFile(tab))

/** 读每个文件的最新内容，按同样的规则重新匹配，算出替换后的全文（还不写） */
export async function planReplace(
  ref: WorkspaceRef,
  targets: readonly ReplaceTarget[],
  query: string,
  options: SearchOptions,
  replacement: string,
): Promise<ReplacePlan> {
  const re = searchRegExp(query, options)
  const { ref: tabRef } = await window.pixelsky!.files.target(ref)
  const plan: ReplacePlan = { tabRef, edits: [], dirty: [], failed: [] }
  for (const { path, lines } of targets) {
    if (openDirty(tabRef, path)) {
      plan.dirty.push(path)
      continue
    }
    try {
      const doc = await window.pixelsky!.files.read(ref, path)
      if (doc.kind !== 'text' || doc.readonly)
        throw new Error(doc.kind === 'unsupported' ? doc.reason : tr('coding.files.replace.notText'))
      const next = replaceInText(doc.content, re, replacement, options.regex, lines)
      if (next.count) plan.edits.push({ path, text: next.text, version: doc.version, count: next.count })
    } catch (e) {
      plan.failed.push({ path, message: (e as Error).message })
    }
  }
  return plan
}

/** 逐个保存；保存前再看一眼编辑器（确认期间可能改了），保存后让打开着的干净标签重读 */
export async function applyReplace(ref: WorkspaceRef, plan: ReplacePlan): Promise<ReplacePlan & { done: number }> {
  const { tabRef } = plan
  const result = { tabRef, edits: [] as ReplaceEdit[], dirty: [...plan.dirty], failed: [...plan.failed], done: 0 }
  for (const edit of plan.edits) {
    if (openDirty(tabRef, edit.path)) {
      result.dirty.push(edit.path)
      continue
    }
    try {
      await window.pixelsky!.files.save(ref, edit.path, edit.text, edit.version)
      result.edits.push(edit)
      result.done += edit.count
    } catch (e) {
      result.failed.push({ path: edit.path, message: (e as Error).message })
    }
    for (const tab of openFilesUnder(tabRef, edit.path)) if (tab.path === edit.path) void checkFile(tab.id)
  }
  return result
}
