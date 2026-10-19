import { Wordmark } from '@/ui'
import { isDemo } from '@/data'
import { useEngineState, type ComposerController, type StatusBarController } from '@/features/engine'
import { useComposerDraft } from '@/features/engine/drafts'
import { useGitSummary } from '@/features/panel/git/summary'
import { tr } from '@/i18n/core'
import { ResumeHintLink } from '@/features/resume/ResumeHintLink'
import { Composer } from './Composer'
import { ComposerArea } from './ComposerArea'
import { starters } from './starters'
import { composerWorkspace } from './composerWorkspace'
import { focusComposer } from './composerTarget'
import { useI18n } from '@/i18n/I18nProvider'

/**
 * 欢迎页：新会话、没有对话时显示，字标 + 标题 + 副标题 + 输入框，整体居中略偏上（design-refresh.md §5.3）。
 * 输入框为空、选好了项目时，下面给几个起点（docs/ui/workbench-ux-3.md §2.2）。
 * live / status 不传时是演示模式。
 */
export function WelcomeView({
  live,
  status,
  draftKey,
}: {
  live?: ComposerController
  status?: StatusBarController
  draftKey?: string
}) {
  const { text } = useI18n()
  // 项目里还没有任何像素星空对话时，才提示终端里的旧会话
  const projectId = status?.project?.id
  const hasConversations = useEngineState(s => !!projectId && s.sessions.some(x => x.record.projectId === projectId))
  const needProject = !!status && !status.project
  const key = draftKey ?? live?.sessionId ?? (live ? 'new-session' : 'demo')
  const [draft, setDraft] = useComposerDraft(key)
  // 演示模式用演示数据里的 Git 状态
  const ref = status ? composerWorkspace(live?.sessionId, status, draftKey) : isDemo ? { projectId: 'demo' } : null
  const git = useGitSummary(ref)
  const choose = (prompt: string): void => {
    setDraft(prompt)
    // 输入框是 CodeMirror，不是 textarea：按草稿键找到它，光标放到末尾
    focusComposer(key)
  }
  return (
    <div
      data-follow-scroll
      className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto bg-app pb-[12vh]"
    >
      <div data-follow-sidebar className="flex w-full min-w-0 flex-col">
        <div className="flex flex-col items-center px-6 text-center">
          <Wordmark height={40} />
          <h2 className="mt-5 text-title text-fg">{text('有什么可以帮你？')}</h2>
          <p className="mt-2 text-ui text-fg-muted">
            {needProject ? text('先选择一个项目文件夹，然后描述你要做的事') : text('在这台电脑上开始一个新任务')}
          </p>
          {/* 这个项目在终端里有原来的 AI 会话：给个入口接着聊；没找到 / 查失败时给「重新查找」（远程项目 / 演示不显示） */}
          {!isDemo && projectId && !hasConversations && (
            <ResumeHintLink
              projectId={projectId}
              separator="comma"
              probe
              engine={live?.engine?.id}
              className="mt-2 text-ui"
            />
          )}
        </div>
        <div className="mt-7">
          <ComposerArea>
            <Composer live={live} status={status} draftKey={draftKey} autoFocus={!!live} newTask />
          </ComposerArea>
        </div>
        {/* 占住高度：开始打字时起点消失，输入框不跟着动 */}
        <div className="mt-3 flex min-h-8 flex-wrap justify-center gap-2 px-6">
          {ref && !draft.trim() && (
            <div role="group" aria-label={tr('session.WelcomeView.starters')} className="contents">
              {starters(git?.changed ?? 0).map(s => (
                <button
                  key={s.id}
                  type="button"
                  data-starter={s.id}
                  title={s.prompt}
                  onClick={() => choose(s.prompt)}
                  className="press inline-flex h-8 max-w-full items-center rounded-full border border-line bg-surface px-3 text-list text-fg-secondary hover:bg-hover hover:text-fg"
                >
                  <span className="truncate">{s.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
