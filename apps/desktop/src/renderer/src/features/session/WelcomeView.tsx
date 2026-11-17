import { useMemo, useState } from 'react'
import { FolderOpen, GitBranch } from 'lucide-react'
import { isChatProject } from '@pixelsky/protocol'
import { cn, Wordmark } from '@/ui'
import { isDemo, projects as demoProjects } from '@/data'
import { relativeTime, useEngineState, type ComposerController, type StatusBarController } from '@/features/engine'
import { machineOf, openWorkspacePicker, useMachines } from '@/features/machines/store'
import { paneActions } from '@/features/panes/store'
import { newChatInProject } from '@/features/coding/workspace'
import { useIsolatedCopy } from './isolatedCopy'
import { recentProjects } from './recentProjects'
import { useComposerDraft } from '@/features/engine/drafts'
import { useGitSummary } from '@/features/panel/git/summary'
import { tr } from '@/i18n/core'
import { ResumeHintLink } from '@/features/resume/ResumeHintLink'
import { Composer } from './Composer'
import { ComposerArea } from './ComposerArea'
import { starters } from './starters'
import { folderWorkspace } from './composerWorkspace'
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
  // 选了「对话」：没有文件夹，不查 Git、不给项目起点、不提示终端里的旧会话
  const chat = isChatProject(projectId)
  const key = draftKey ?? live?.sessionId ?? (live ? 'new-session' : 'demo')
  const [draft, setDraft] = useComposerDraft(key)
  // 演示模式用演示数据里的 Git 状态
  const ref = status ? folderWorkspace(live?.sessionId, status, draftKey) : isDemo ? { projectId: 'demo' } : null
  const git = useGitSummary(ref)
  // 「独立副本」开着时输入框下面的说明（docs/ui/desktop-parity.md §3.2）；和位置行的开关同一份状态
  const isolated = useIsolatedCopy(live?.sessionId ? undefined : key, projectId)
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
          {!isDemo && projectId && !chat && !hasConversations && (
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
        {/* 开关显示时就占住这一行（关着时看不见）：开关时输入框不跳 */}
        {isolated && (
          <p
            data-isolated-note
            aria-hidden={!isolated.on || undefined}
            title={tr('projectTools.copyCommitHint')}
            className={cn(
              'mt-2 flex min-h-8 min-w-0 items-start justify-center gap-1.5 px-6 text-meta text-fg-muted',
              !isolated.on && 'invisible',
            )}
          >
            <GitBranch size={13} className="mt-0.5 shrink-0" />
            <span className="min-w-0 text-center">
              {isolated.creating
                ? tr('session.isolated.creating')
                : isolated.base
                  ? tr('session.isolated.note', { base: isolated.base })
                  : tr('session.isolated.reading')}
            </span>
          </p>
        )}
        {!needProject && <RecentProjects live={live} draftKey={draftKey} current={projectId} composerKey={key} />}
        {/* 占住高度：开始打字时起点消失，输入框不跟着动 */}
        <div className="mt-3 flex min-h-8 flex-wrap justify-center gap-2 px-6">
          {chat && (
            <p className="self-center text-center text-meta text-fg-faint">
              {tr('session.WelcomeView.chatNotSandbox')}
            </p>
          )}
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

/**
 * 最近的项目（docs/ui/desktop-parity.md §3.2）：这台机器上最近有对话的 4 个项目，点了直接把这个新会话换过去；
 * 当前项目描边。只有当前项目一个时不显示。演示模式用演示项目，点了只换描边
 */
function RecentProjects({
  live,
  draftKey,
  current,
  composerKey,
}: {
  live?: ComposerController
  draftKey?: string
  current?: string
  composerKey: string
}) {
  const sessions = useEngineState(s => s.sessions)
  const projects = useEngineState(s => s.projects)
  const machine = useMachines().currentId
  const [demoCurrent, setDemoCurrent] = useState(demoProjects[0]?.id)
  const list = useMemo(
    () =>
      isDemo
        ? demoProjects.slice(0, 4).map(p => ({ id: p.id, name: p.name, at: null as number | null }))
        : recentProjects(projects, sessions, id => machineOf(id) === machine),
    [projects, sessions, machine],
  )
  const selected = isDemo ? demoCurrent : current
  if (!list.some(p => p.id !== selected)) return null
  const pick = (id: string): void => {
    if (id === selected) return
    if (isDemo) setDemoCurrent(id)
    // 标签已经有会话（工作区选择里建的空会话）：在那个项目里另开新对话
    else if (live?.sessionId || !draftKey) newChatInProject(id)
    else paneActions.rebindNewTab(draftKey, id)
    focusComposer(composerKey)
  }
  const chip =
    'press inline-flex h-7 max-w-[14rem] items-center gap-1.5 rounded-full border px-3 text-list hover:bg-hover hover:text-fg'
  return (
    <div
      data-recent-projects
      role="group"
      aria-label={tr('session.WelcomeView.recentProjects')}
      className="mt-4 flex flex-wrap items-center justify-center gap-2 px-6"
    >
      <span className="text-meta text-fg-faint">{tr('session.WelcomeView.recentProjects')}</span>
      {list.map(p => (
        <button
          key={p.id}
          type="button"
          data-recent-project={p.id}
          aria-current={p.id === selected || undefined}
          onClick={() => pick(p.id)}
          className={cn(
            chip,
            p.id === selected ? 'border-accent-line bg-surface text-fg' : 'border-line bg-surface text-fg-secondary',
          )}
        >
          <span className="truncate">{p.name}</span>
          {p.at !== null && <span className="shrink-0 text-meta text-fg-faint">{relativeTime(p.at)}</span>}
        </button>
      ))}
      <button
        type="button"
        data-recent-other
        onClick={() => openWorkspacePicker()}
        title={tr('session.WelcomeView.otherFolder')}
        aria-label={tr('session.WelcomeView.otherFolder')}
        className="press inline-flex size-7 items-center justify-center rounded-full border border-line text-fg-muted hover:bg-hover hover:text-fg"
      >
        <FolderOpen size={14} />
      </button>
    </div>
  )
}
