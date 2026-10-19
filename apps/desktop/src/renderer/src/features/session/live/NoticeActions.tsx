import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
// 错误卡片下面的一键按钮（docs/ui/source-switch.md §3.5）：只给最近一轮的错误，按错误类型和会话的额度来源给下一步。
// 按钮只发请求（features/engine/sourceActions.ts），切换额度来源的确认由同一会话的输入框负责。不会自动切换。
import type { NoticeError, SessionRecord } from '@pixelsky/protocol'
import { demoRetry, requestSourceAction, type SourceAction } from '@/features/engine'
import { isDemo } from '@/data'
import { useSettings } from '@/features/settings/SettingsProvider'
import { requestLogFocus } from '@/features/logs/focus'
import { requestFeedback } from '@/features/feedback/focus'
import { actionsFor, classifyError, noticeActions } from './errorKind'

// 纯函数在 errorKind.ts（测试不用加载引擎）；侧栏悬停卡从这里取 actionsFor
export { actionsFor, noticeActions }

export const SOURCE_ACTION_LABEL: Record<SourceAction, string> = {
  get 'open-menu'() {
    return tr('session.live.NoticeActions.changeRoute')
  },
  get 'use-self'() {
    return tr('session.live.NoticeActions.continueWithOwnAccount')
  },
  get 'use-platform'() {
    return tr('session.live.NoticeActions.continueWithPlatform')
  },
  get 'open-account'() {
    return tr('session.live.NoticeActions.viewAccount')
  },
  get 'sign-in'() {
    return tr('session.live.NoticeActions.signInAgain')
  },
  get 'edit-provider'() {
    return tr('customApi.editEndpoint')
  },
  get retry() {
    return tr('session.live.NoticeActions.retry')
  },
  get 'compact-retry'() {
    return tr('session.live.NoticeActions.compactRetry')
  },
}

/** 卡片下面最后一个按钮「查看日志」：打开设置 › 日志，筛到这个会话这一轮（docs/ui/logging.md §3.2） */
export function NoticeActions({
  record,
  text,
  error,
  turnStart,
  retry = false,
  compact = false,
}: {
  record: SessionRecord
  text: string
  /** 引擎给的结构化报错信息（notice.error）；没有时按文字归类 */
  error?: NoticeError
  /** 引擎支持原生压缩（snapshot.flags.compactAvailable）：上下文超限时给「压缩后重试」 */
  compact?: boolean
  /** 给「重试」：会话空闲、队列也空着时（没发出去的消息在队列里有自己的重试） */
  retry?: boolean
  /** 这一轮用户消息的时间；没有时按十分钟前 */
  turnStart: number | null
}) {
  useI18n()
  const settings = useSettings()
  const actions = noticeActions(classifyError(text, error), record, record.engine, { retry, compact })
  const viewLogs = () => {
    requestLogFocus(record.id, turnStart ?? Date.now() - 10 * 60_000)
    settings.openSettings('logs')
  }
  // 反馈：预填报错文字、会话编号，日志取这一轮开始前 1 分钟起（docs/ui/feedback.md §2.5）
  const sendFeedback = () => {
    requestFeedback({
      type: 'bug',
      error: { text, sessionId: record.id, at: Date.now() },
      logsSince: (turnStart ?? Date.now() - 10 * 60_000) - 60_000,
    })
    settings.openSettings('feedback')
  }
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5 pl-[27px]">
      {actions.map(a => (
        <button
          key={a}
          type="button"
          onClick={() => (a === 'retry' && isDemo ? demoRetry(record.id) : requestSourceAction(record.id, a))}
          className="press h-7 rounded-md border border-line bg-surface px-2.5 text-meta text-fg-secondary hover:bg-hover hover:text-fg"
        >
          {SOURCE_ACTION_LABEL[a]}
        </button>
      ))}
      <button
        type="button"
        onClick={viewLogs}
        className="press h-7 rounded-md px-2.5 text-meta text-fg-muted hover:bg-hover hover:text-fg"
      >
        {tr('logs.viewLogs')}
      </button>
      <button
        type="button"
        onClick={sendFeedback}
        className="press h-7 rounded-md px-2.5 text-meta text-fg-muted hover:bg-hover hover:text-fg"
      >
        {tr('feedback.noticeAction')}
      </button>
    </div>
  )
}
