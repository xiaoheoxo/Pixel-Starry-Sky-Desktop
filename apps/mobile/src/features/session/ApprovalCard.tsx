// 审批 / 提问卡片：从底部升起的面板，大按钮（docs/mobile-remote.md §8.3）。
// 「总是允许」在手机上多问一次（§10 第 6 问按推荐）。提问：推荐项、「都按推荐」、自己填答案、密码类的题
// 用密码框（§17 第 3 项，规则同桌面）；要填表单的请求手机上只能拒绝或回电脑处理。
import { useMemo, useState } from 'react'
import { CircleHelp, ClipboardList, FilePen, ShieldAlert, Sparkles, SquareTerminal, Wrench } from 'lucide-react'
import type { ApprovalDecision, ApprovalRequest, Question } from '@pixelsky/protocol'
import {
  EMPTY_DRAFT,
  canWriteIn,
  collectAnswers,
  displayLabel,
  isRecommended,
  pickOption,
  recommendedAnswers,
  toggleOther,
  type QuestionDraft,
} from '@/data/questions'
import { Button, DiffView, cn } from '@/ui'
import { MarkdownText } from '@/ui/Markdown'

const ICONS = {
  command: SquareTerminal,
  file_change: FilePen,
  tool: Wrench,
  question: CircleHelp,
  plan: ClipboardList,
} as const

const SCOPE_TEXT = { session: '这个任务里', project: '这个项目里', user: '所有项目里' } as const

export function ApprovalCard({
  request,
  canAct,
  onAnswer,
  more = 0,
}: {
  request: ApprovalRequest
  canAct: boolean
  onAnswer(decision: ApprovalDecision): Promise<void>
  /** 同时还有几项在等（AI 一次并行调用几个要审批的工具）：一项一项处理，这里写还剩几项 */
  more?: number
}) {
  const [busy, setBusy] = useState(false)
  const [confirmAlways, setConfirmAlways] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({})
  const answer = async (d: ApprovalDecision) => {
    setBusy(true)
    try {
      await onAnswer(d)
    } finally {
      setBusy(false)
    }
  }
  const questions = useMemo(() => request.questions ?? [], [request.questions])
  const recommended = useMemo(() => recommendedAnswers(questions), [questions])
  const answers = collectAnswers(questions, drafts)
  const form = request.formSchema !== undefined
  const scope = request.alwaysScopes[0]
  const Icon = ICONS[request.kind] ?? ShieldAlert

  return (
    <div className="sheet-in flex max-h-[calc(var(--app-height,100dvh)*0.7)] flex-col rounded-t-3xl border-t border-line bg-surface shadow-popover">
      <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line-strong" />
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 pt-3 pb-4">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-subtle text-notify">
            <Icon size={19} />
          </span>
          <div className="min-w-0">
            <div className="text-section font-semibold">{request.title}</div>
            <div className="text-meta text-fg-muted">
              {request.kind === 'question' ? '需要你回答' : '需要你允许才能继续'}
              {more > 0 && <span data-approval-more> · 后面还有 {more} 项</span>}
            </div>
          </div>
        </div>
        {request.description && <p className="text-meta text-fg-secondary">{request.description}</p>}
        {request.wrapper && request.wrapper.extra.length > 0 && (
          <p className="flex flex-wrap items-center gap-1.5 rounded-xl bg-warn/12 px-3 py-2 text-meta text-warn">
            <span>
              外层 {request.wrapper.shell === 'powershell' ? 'PowerShell' : request.wrapper.shell} 还带了参数：
            </span>
            {request.wrapper.extra.map((a, i) => (
              <code key={i} className="rounded-sm bg-warn/15 px-1.5 font-mono text-label break-all">
                {a}
              </code>
            ))}
          </p>
        )}
        {request.command && (
          <pre className="max-h-40 overflow-auto rounded-xl bg-subtle px-3 py-2.5 font-mono text-label break-all whitespace-pre-wrap">
            {request.command}
          </pre>
        )}
        {request.changes?.map(c => (
          <div key={c.path} className="overflow-hidden rounded-xl border border-line-subtle">
            <p className="truncate bg-subtle px-3 py-1.5 font-mono text-label text-fg-muted">{c.path}</p>
            <div className="max-h-48 overflow-auto">
              <DiffView diff={c.diff} />
            </div>
          </div>
        ))}
        {request.plan && (
          <div className="max-h-64 overflow-auto rounded-xl bg-subtle px-3.5 py-2.5">
            <MarkdownText text={request.plan} />
          </div>
        )}

        {request.kind === 'question' ? (
          <>
            {questions.map(q => (
              <QuestionField
                key={q.question}
                question={q}
                draft={drafts[q.question] ?? EMPTY_DRAFT}
                disabled={!canAct || busy}
                onChange={d => setDrafts(all => ({ ...all, [q.question]: d }))}
              />
            ))}
            <div className="flex flex-col gap-2 pt-1">
              {recommended && (
                <Button
                  variant="secondary"
                  disabled={!canAct || busy}
                  onClick={() => void answer({ type: 'answer', answers: recommended })}
                >
                  <Sparkles size={16} /> 都按推荐
                </Button>
              )}
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  className="flex-1"
                  disabled={!canAct || busy}
                  onClick={() => void answer({ type: 'deny' })}
                >
                  不回答
                </Button>
                <Button
                  variant="primary"
                  className="flex-[2]"
                  disabled={!canAct || busy || !answers}
                  onClick={() => answers && void answer({ type: 'answer', answers })}
                >
                  提交回答
                </Button>
              </div>
            </div>
          </>
        ) : form ? (
          <div className="flex flex-col gap-2">
            <p className="rounded-xl bg-subtle px-3.5 py-3 text-meta text-fg-secondary">
              这个请求要填一张表单，手机上还填不了，请到电脑上处理；也可以在这里拒绝。
            </p>
            {request.canDeny !== false && (
              <Button variant="danger" disabled={!canAct || busy} onClick={() => void answer({ type: 'deny' })}>
                拒绝
              </Button>
            )}
          </div>
        ) : confirmAlways && scope ? (
          <div className="flex flex-col gap-2 rounded-xl bg-subtle p-3">
            <p className="text-ui">{SCOPE_TEXT[scope] ?? ''}以后同类操作都不再问？</p>
            <div className="flex gap-2">
              <Button className="flex-1" onClick={() => setConfirmAlways(false)}>
                取消
              </Button>
              <Button
                variant="primary"
                className="flex-1"
                disabled={busy}
                onClick={() => void answer({ type: 'allow_always', scope })}
              >
                总是允许
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1 pt-1">
            <div className="flex gap-2">
              {request.canDeny !== false && (
                <Button
                  variant="danger"
                  className="flex-1"
                  disabled={!canAct || busy}
                  onClick={() => void answer({ type: 'deny' })}
                >
                  拒绝
                </Button>
              )}
              {request.canAllow !== false && (
                <Button
                  variant="primary"
                  className="flex-[2]"
                  disabled={!canAct || busy}
                  onClick={() => void answer({ type: 'allow' })}
                >
                  允许
                </Button>
              )}
            </div>
            {scope && (
              <Button variant="ghost" size="sm" disabled={!canAct || busy} onClick={() => setConfirmAlways(true)}>
                总是允许…
              </Button>
            )}
          </div>
        )}
        {!canAct && <p className="text-center text-meta text-fg-muted">这部手机是「只看」，要在电脑上处理。</p>}
      </div>
    </div>
  )
}

/** 一道题：选项（推荐的带标签）、「其他」自己填；没有选项的题直接填 */
function QuestionField({
  question: q,
  draft,
  disabled,
  onChange,
}: {
  question: Question
  draft: QuestionDraft
  disabled: boolean
  onChange(d: QuestionDraft): void
}) {
  const writeIn = canWriteIn(q)
  const writing = q.options.length === 0 || draft.other
  const choice = (
    key: string,
    on: boolean,
    onClick: () => void,
    title: string,
    description?: string,
    badge?: boolean,
  ) => (
    <button
      key={key}
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex min-h-12 items-start gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors',
        on ? 'border-accent bg-accent-soft' : 'border-line bg-surface',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-4.5 shrink-0 items-center justify-center border-2',
          q.multiSelect ? 'rounded-md' : 'rounded-full',
          on ? 'border-accent bg-accent' : 'border-line-strong',
        )}
      >
        {on && <span className={cn('size-1.5 bg-accent-on', q.multiSelect ? 'rounded-sm' : 'rounded-full')} />}
      </span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5 text-ui">
          {title}
          {badge && (
            <span className="rounded-full bg-accent-soft px-1.5 text-label font-medium text-accent-fg">推荐</span>
          )}
        </span>
        {description && <span className="block text-meta text-fg-muted">{description}</span>}
      </span>
    </button>
  )
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="pb-1 text-ui font-medium">{q.question}</legend>
      {q.multiSelect && <span className="-mt-1 text-label text-fg-muted">可以多选</span>}
      {q.options.map(o =>
        choice(
          o.label,
          draft.picks.includes(o.label),
          () => onChange(pickOption(q, draft, o.label)),
          displayLabel(o.label),
          o.description,
          isRecommended(o.label),
        ),
      )}
      {writeIn &&
        q.options.length > 0 &&
        choice('__other', draft.other, () => onChange(toggleOther(q, draft)), '其他（自己填）')}
      {writing &&
        (q.secret ? (
          <input
            type="password"
            value={draft.text}
            disabled={disabled}
            autoComplete="off"
            placeholder="输入内容（不会显示出来）"
            onChange={e => onChange({ ...draft, text: e.target.value })}
            className="min-h-12 rounded-xl border border-line bg-surface px-3.5 text-ui text-fg outline-none placeholder:text-fg-faint focus:border-accent"
          />
        ) : (
          <textarea
            value={draft.text}
            disabled={disabled}
            rows={2}
            placeholder="写下你的回答"
            onChange={e => onChange({ ...draft, text: e.target.value })}
            className="field-sizing-content max-h-40 min-h-12 resize-none rounded-xl border border-line bg-surface px-3.5 py-2.5 text-ui text-fg outline-none placeholder:text-fg-faint focus:border-accent"
          />
        ))}
    </fieldset>
  )
}
