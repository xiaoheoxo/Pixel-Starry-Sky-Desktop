import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { demo as demoData } from '@/data/demo'
import { openFile } from '@/features/files/store'
import { GitDiffView } from '@/features/panel/git/GitDiffView'
import type { GitDiff, GitFileChange } from '../../../../../shared/types/project-tools'
import { codingLayout } from '../layoutStore'
import { diffActions, type GitDiffArea } from './gitDiffModel'
import { useGitDiffTab, useGitFileActions, useGitStatusRevision } from './gitDiffTabs'

/** 文件名下面的说明：比的是哪两边；整个标签只读（中栏的 Git 对比不能编辑） */
export function diffCaption(area: GitDiffArea, caption?: string): string {
  const what =
    area === 'commit'
      ? (caption ?? '')
      : area === 'staged'
        ? tr('coding.gitDiff.caption.staged')
        : area === 'unstaged'
          ? tr('coding.gitDiff.caption.unstaged')
          : area === 'untracked'
            ? tr('coding.gitDiff.caption.untracked')
            : tr('coding.gitDiff.caption.conflicted')
  return what ? `${what} · ${tr('coding.gitDiff.readonly')}` : tr('coding.gitDiff.readonly')
}

/** 中栏的「Git 对比」标签：复用 Git 面板的 GitDiffView，没有「返回」；动作交给 Git 面板执行 */
export function GitDiffTab({ id }: { id: string }) {
  useI18n()
  const data = useGitDiffTab(id)
  const { actions, busy } = useGitFileActions(data?.refKey ?? '')
  const revision = useGitStatusRevision(data?.refKey ?? '')
  if (!data) return null
  const can = diffActions(data.area)
  const api = window.pixelsky?.projectTools
  const load = (): Promise<GitDiff> => {
    if (data.area === 'commit') {
      const input = {
        area: 'commit' as const,
        path: data.path,
        origPath: data.origPath,
        from: data.from,
        to: data.to ?? '',
      }
      return data.demo ? Promise.resolve(demoData().git.history.diff(input)) : api!.gitDiff(data.ref, input)
    }
    return data.demo
      ? Promise.resolve(demoData().git.diff(data.path))
      : api!.gitDiff(data.ref, { path: data.path, area: data.area, origPath: data.origPath })
  }
  const file = {
    path: data.path,
    origPath: data.origPath,
    code: data.code as GitFileChange['code'],
    local: data.local,
    submodule: false,
  }
  return (
    <div data-git-diff-tab={data.area} className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
      <GitDiffView
        key={id}
        file={file}
        area={data.area}
        busy={busy || !actions}
        labelled
        // 历史里的提交不会变，不跟状态重读
        revision={data.area === 'commit' ? undefined : revision}
        caption={diffCaption(data.area, data.caption)}
        load={load}
        onOpen={
          data.local && data.code !== 'D'
            ? () => void openFile(data.ref, data.local!, undefined, 1, undefined, { target: 'code' })
            : undefined
        }
        onHistory={
          actions && data.area !== 'commit' && data.area !== 'untracked' && data.code !== 'A'
            ? () => {
                codingLayout.showLeft('git')
                actions.history(data.path)
              }
            : undefined
        }
        onStage={can.stage && actions ? () => actions.stage(data.path) : undefined}
        onUnstage={can.unstage && actions ? () => actions.unstage(data.path) : undefined}
        onDiscard={
          can.discard && actions ? () => actions.discard(data.path, data.area as 'unstaged' | 'untracked') : undefined
        }
      />
    </div>
  )
}
