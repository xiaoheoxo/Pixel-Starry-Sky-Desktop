import { CircleX, Sparkles, TriangleAlert } from 'lucide-react'
import { Button, cn, useToast } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { openFile } from '@/features/files/store'
import { appendComposerDraft } from '@/features/engine/drafts'
import { composerTarget, focusComposer } from '@/features/session/composerTarget'
import { quotePath } from '@/features/session/quote'
import { codingLayout } from '../layoutStore'
import type { CodingWorkspace } from '../workspace'
import { groupByFile, isAbsolute, problemLine, type Problem, type ProblemSummary } from '../problemsModel'

/** 问题页（docs/ui/coding-tier1.md §4）：tsc / eslint 任务输出里的报错按文件分组，点一行跳过去，每行可以交给 AI 修 */
export function ProblemsTab({ workspace, problems }: { workspace: CodingWorkspace; problems: ProblemSummary }) {
  useI18n()
  const toast = useToast()
  const askAi = (p: Problem): void => {
    const target = composerTarget()
    if (!target) {
      toast(tr('editor.quote.noSession'))
      return
    }
    // 会话目录不是项目根时写完整路径；项目外的文件本来就是绝对路径
    const path = isAbsolute(p.path) ? p.path : quotePath({ root: workspace.path, path: p.path }, target.cwd)
    appendComposerDraft(target.key, tr('coding.bottom.problems.fixPrompt', { problem: problemLine(p, path) }))
    codingLayout.showRight('chat')
    focusComposer(target.key)
  }
  return (
    <div
      role="tabpanel"
      id="coding-bottom-page-problems"
      aria-labelledby="coding-bottom-tab-problems"
      className="min-w-0 flex-1 overflow-auto"
    >
      {problems.items.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-meta text-fg-faint">
          {tr(problems.ran ? 'coding.bottom.problems.none' : 'coding.bottom.problems.empty')}
          {!problems.ran && (
            <Button variant="outline" onClick={() => codingLayout.showLeft('tasks')}>
              {tr('coding.bottom.problems.goTasks')}
            </Button>
          )}
        </div>
      ) : (
        <ul className="flex flex-col py-1">
          {groupByFile(problems.items).map(group => {
            const cut = group.path.lastIndexOf('/')
            return (
              <li key={group.path} data-coding-problem-file={group.path}>
                <div className="flex h-7 items-center gap-2 px-4 text-ui" title={group.path}>
                  <span className="shrink-0 font-medium">{group.path.slice(cut + 1)}</span>
                  <span className="min-w-0 truncate text-meta text-fg-faint">
                    {cut > 0 ? `${group.path.slice(0, cut)} · ` : ''}
                    {group.items.length}
                  </span>
                </div>
                <ul>
                  {group.items.map(p => (
                    <ProblemRow
                      key={`${p.line}:${p.column}:${p.message}`}
                      problem={p}
                      onOpen={() =>
                        workspace.ref &&
                        void openFile(workspace.ref, p.path, p.line, p.column, undefined, { target: 'code' })
                      }
                      onAskAi={() => askAi(p)}
                    />
                  ))}
                </ul>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function ProblemRow({ problem: p, onOpen, onAskAi }: { problem: Problem; onOpen: () => void; onAskAi: () => void }) {
  const Icon = p.severity === 'error' ? CircleX : TriangleAlert
  return (
    <li className="group flex h-7 items-center gap-2 pl-8 pr-4 text-ui hover:bg-hover">
      <button
        type="button"
        onClick={onOpen}
        title={p.message}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <Icon
          size={14}
          strokeWidth={1.5}
          className={cn('shrink-0', p.severity === 'error' ? 'text-danger' : 'text-warn')}
          aria-label={tr(p.severity === 'error' ? 'coding.bottom.problems.error' : 'coding.bottom.problems.warning')}
        />
        <span className="min-w-0 flex-1 truncate">{p.message}</span>
        <span className="shrink-0 text-meta text-fg-faint">{p.code ? `${p.source} ${p.code}` : p.source}</span>
        <span className="shrink-0 font-mono text-meta text-fg-muted tabular-nums">
          {p.line}:{p.column}
        </span>
      </button>
      <Button
        variant="ghost"
        icon={Sparkles}
        onClick={onAskAi}
        className="h-6 px-2 text-meta opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        {tr('coding.bottom.problems.askAi')}
      </Button>
    </li>
  )
}
