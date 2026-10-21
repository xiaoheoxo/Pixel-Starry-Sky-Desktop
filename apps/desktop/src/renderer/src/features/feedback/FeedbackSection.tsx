// 设置 › 反馈（docs/ui/feedback.md §2）：三个视图（列表 / 新反馈 / 一条反馈）用本地状态切换
import { useEffect, useState } from 'react'
import { useAccount } from '@/features/account'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { Button, Spinner } from '@/ui'
import { SectionTitle } from '../settings/SettingRow'
import { FeedbackForm } from './FeedbackForm'
import { FeedbackList } from './FeedbackList'
import { FeedbackThread } from './FeedbackThread'
import { onFeedbackFocus, takeFeedbackFocus, type FeedbackPrefill, type FeedbackTarget } from './focus'
import { Crumbs } from './parts'
import { feedbackApi, isDemoFeedback, useFeedback } from './store'

type View = { kind: 'list' } | { kind: 'new'; prefill: FeedbackPrefill | null } | { kind: 'thread'; id: string }

const viewOf = (target: FeedbackTarget | null): View | null =>
  !target ? null : 'threadId' in target ? { kind: 'thread', id: target.threadId } : { kind: 'new', prefill: target }

export function FeedbackSection() {
  useI18n()
  const state = useFeedback()
  const [view, setView] = useState<View>(() => viewOf(takeFeedbackFocus()) ?? { kind: 'list' })

  // 页面已经打开时，又从别处（通知、报错、日志页）跳过来
  useEffect(
    () =>
      onFeedbackFocus(() => {
        const next = viewOf(takeFeedbackFocus())
        if (next) setView(next)
      }),
    [],
  )

  // 出错时让主进程重新检查一次：登录过期会反映到 state.status，切到未登录视图
  const onFailed = (): void => {
    void feedbackApi()
      .refresh()
      .catch(() => {})
  }

  if (state.loading)
    return (
      <section>
        <SectionTitle>{tr('feedback.title')}</SectionTitle>
        <div className="flex items-center gap-2 py-8 text-meta text-fg-muted">
          <Spinner size={13} />
          {tr('feedback.loading')}
        </div>
      </section>
    )
  if (state.status === 'signed-out') return <SignedOut />
  if (state.status === 'not-deployed') return <NotDeployed />

  const toList = (): void => setView({ kind: 'list' })
  return (
    <div data-feedback-view={view.kind}>
      {view.kind === 'list' && (
        <FeedbackList
          onNew={() => setView({ kind: 'new', prefill: null })}
          onOpen={id => setView({ kind: 'thread', id })}
          onFailed={onFailed}
        />
      )}
      {view.kind === 'new' && (
        <section>
          <Crumbs current={tr('feedback.new')} onBack={toList} />
          <FeedbackForm
            email={state.email ?? ''}
            prefill={view.prefill}
            onCancel={toList}
            onDone={detail => setView({ kind: 'thread', id: detail.thread.id })}
            onFailed={onFailed}
          />
        </section>
      )}
      {view.kind === 'thread' && <FeedbackThread key={view.id} id={view.id} onBack={toList} onFailed={onFailed} />}
    </div>
  )
}

function openIssues(): void {
  window.pixelsky?.app.open('issues').catch(() => {})
}

/** 未登录：一张卡片 + 次要链接（登录过期也到这里） */
function SignedOut() {
  useI18n()
  const account = useAccount()
  const signingIn = account.status === 'signing-in'
  return (
    <section data-feedback-view="signed-out">
      <SectionTitle>{tr('feedback.title')}</SectionTitle>
      <div className="rounded-lg border border-line bg-subtle px-5 py-6">
        <p className="mb-4 text-ui text-fg">{tr('feedback.signedOut')}</p>
        <Button variant="primary" disabled={signingIn} onClick={() => void account.login()}>
          {signingIn ? tr('feedback.signingIn') : tr('feedback.signIn')}
        </Button>
        {account.error && <p className="selectable mt-3 text-meta text-danger">{translateMessage(account.error)}</p>}
      </div>
      {!isDemoFeedback() && (
        <button type="button" onClick={openIssues} className="mt-4 text-meta text-accent hover:underline">
          {tr('feedback.githubIssue')}
        </button>
      )}
    </section>
  )
}

/** 云端还没有反馈接口 */
function NotDeployed() {
  useI18n()
  return (
    <section data-feedback-view="not-deployed">
      <SectionTitle>{tr('feedback.title')}</SectionTitle>
      <div className="rounded-lg border border-line bg-subtle px-5 py-6">
        <p className="mb-4 text-ui text-fg">{tr('feedback.notDeployed')}</p>
        <Button onClick={openIssues}>{tr('feedback.githubOpen')}</Button>
      </div>
    </section>
  )
}
