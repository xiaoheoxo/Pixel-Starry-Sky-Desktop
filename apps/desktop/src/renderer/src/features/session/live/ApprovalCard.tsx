import { useI18n } from '@/i18n/I18nProvider'
import {
  EMPTY_DRAFT,
  answeredCount,
  canWriteIn,
  collectAnswers,
  displayLabel,
  isRecommended,
  pickOption,
  recommendedAnswers,
  toggleOther,
  type QuestionDraft,
} from './questionModel'
import { tr, translateMessage } from '../../../i18n/core'
// 审批卡片：引擎等你决定时固定显示在输入框上方（docs/engines.md §5.5）
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  ChevronDown,
  FilePen,
  ListChecks,
  MessageCircleQuestion,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { AlwaysScope, ApprovalDecision, ApprovalRequest, CommandWrapper, Question } from '@pixelsky/protocol'
import { Button, DiffStat, Popover, cn } from '@/ui'
import { isTypingTarget } from '@/ui/menuDigit'
import { DiffView } from '@/ui/code/DiffView'
import { CommandText } from '@/ui/code/CommandText'
import { Markdown } from '@/ui/markdown/Markdown'
import { FullAccessConfirm } from '../FullAccessConfirm'
import { hasWrapperExtra, shellDisplayName } from './commandWrapper'
import { alwaysKeyScope, approvalShortcut, digitQuestion, questionShortcut } from './approvals/cardKeys'

const ICON: Record<ApprovalRequest['kind'], LucideIcon> = {
  command: SquareTerminal,
  file_change: FilePen,
  tool: Wrench,
  question: MessageCircleQuestion,
  plan: ListChecks,
}

const BODY = 'max-h-[34vh] overflow-auto'

/** 「始终允许」的范围（docs/engines.md §15.6） */
export const SCOPE_INFO: Record<AlwaysScope, { label: string; desc: string }> = {
  session: {
    get label() {
      return tr('session.live.ApprovalCard.thisSession')
    },
    get desc() {
      return tr('session.live.ApprovalCard.expiresWhenThisSession')
    },
  },
  project: {
    get label() {
      return tr('session.live.ApprovalCard.thisProject')
    },
    get desc() {
      return tr('session.live.ApprovalCard.saveToProjectsClaude')
    },
  },
  user: {
    get label() {
      return tr('session.live.ApprovalCard.allProjects')
    },
    get desc() {
      return tr('session.live.ApprovalCard.saveToClaudeSettings')
    },
  },
}

/** 「始终允许…」：只有一个范围时直接是按钮，多个时弹出范围菜单 */
function AlwaysAllowButton({
  scopes,
  disabled,
  onPick,
}: {
  scopes: AlwaysScope[]
  disabled: boolean
  onPick: (s: AlwaysScope) => void
}) {
  useI18n()
  const [open, setOpen] = useState(false)
  if (scopes.length === 1) {
    return (
      <Button variant="outline" disabled={disabled} onClick={() => onPick(scopes[0])}>
        {SCOPE_INFO[scopes[0]].label}
        {tr('session.live.ApprovalCard.alwaysAllow')}{' '}
      </Button>
    )
  }
  return (
    <span className="relative">
      <Button
        variant="outline"
        disabled={disabled}
        onClick={() => setOpen(v => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {tr('session.live.ApprovalCard.alwaysAllow2')}{' '}
        <ChevronDown size={14} strokeWidth={1.5} className="text-fg-muted" />
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} side="top" offset={8} className="w-72">
        <div className="px-2 pt-1.5 pb-1 text-label font-medium text-fg-faint">
          {tr('session.live.ApprovalCard.alwaysAllowScope')}
        </div>
        {scopes.map(scope => (
          <button
            key={scope}
            type="button"
            onClick={() => {
              setOpen(false)
              onPick(scope)
            }}
            className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-hover"
          >
            <span className="text-ui text-fg">{SCOPE_INFO[scope].label}</span>
            <span className="text-meta text-fg-muted">{SCOPE_INFO[scope].desc}</span>
          </button>
        ))}
      </Popover>
    </span>
  )
}

/** 外层 shell 还带了别的参数：一定显示，不用点开 */
function WrapperWarn({ wrapper }: { wrapper: CommandWrapper }) {
  return (
    <div
      role="note"
      className="mb-1.5 flex flex-wrap items-center gap-1.5 rounded-lg bg-warn/12 px-2.5 py-1.5 text-list text-warn"
    >
      <span>{tr('approvals.wrapperExtra', { shell: shellDisplayName(wrapper.shell) })}</span>
      {wrapper.extra.map((a, i) => (
        <code key={i} className="rounded-sm bg-warn/15 px-1.5 font-mono text-meta break-all">
          {a}
        </code>
      ))}
    </div>
  )
}

/** 命令下面一行：外壳名 + 「完整命令」开关，点开是原始整行 */
function WrapperMeta({ wrapper }: { wrapper: CommandWrapper }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-meta text-fg-muted">
        <span className="rounded-sm border border-line px-1.5 py-px text-label">{shellDisplayName(wrapper.shell)}</span>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(v => !v)}
          className="rounded-sm px-1 hover:text-fg"
        >
          {tr('approvals.fullCommand')} {open ? '▾' : '▸'}
        </button>
      </div>
      {open && (
        <div className="mt-1.5 rounded-lg border border-dashed border-line px-2.5 py-1.5 font-mono text-meta leading-[1.55] break-all whitespace-pre-wrap text-fg-secondary select-text">
          {wrapper.line}
        </div>
      )}
    </div>
  )
}

/** 命令、改文件、工具的内容区（单张卡和合并列表里展开的一行共用） */
export function ApprovalBody({
  request,
  className = BODY,
  compact = false,
}: {
  request: ApprovalRequest
  className?: string
  /** 合并列表里展开的一行：工具的说明（服务 · 工具）行上已经写了，不再重复 */
  compact?: boolean
}) {
  if (request.kind === 'command')
    return (
      <>
        {request.description && <p className="mb-1.5 text-list text-fg-muted">{request.description}</p>}
        {hasWrapperExtra(request.wrapper) && <WrapperWarn wrapper={request.wrapper} />}
        <pre
          className={cn(
            className,
            'rounded-lg border border-line bg-subtle px-3 py-2 font-mono text-[length:calc(12.5px*var(--font-scale,1))] leading-[1.6] whitespace-pre-wrap text-fg',
          )}
        >
          <CommandText command={request.command ?? ''} />
        </pre>
        {request.wrapper && <WrapperMeta wrapper={request.wrapper} />}
      </>
    )
  if (request.kind === 'file_change')
    return (
      <div className={cn(className, 'rounded-lg border border-line')}>
        {(request.changes ?? []).map(c => (
          <div key={c.path} className="border-b border-line-subtle last:border-b-0">
            <div className="flex items-center gap-2 px-3 py-1.5 text-list">
              <span className="min-w-0 flex-1 truncate font-mono text-[length:calc(12.5px*var(--font-scale,1))] text-code-path">
                {c.path}
              </span>
              <DiffStat added={c.added} removed={c.removed} className="text-meta" />
            </div>
            <DiffView diff={c.diff} path={c.path} className="pb-1.5" commentable={false} />
          </div>
        ))}
      </div>
    )
  if (request.kind === 'tool')
    return (
      <>
        {request.description && !compact && (
          <p className="mb-1.5 truncate text-list text-fg-muted">{request.description}</p>
        )}
        <pre
          className={cn(
            className,
            'rounded-lg border border-line bg-subtle px-3 py-2 font-mono text-meta leading-[1.6] whitespace-pre-wrap text-fg-secondary',
          )}
        >
          {JSON.stringify(request.input, null, 2)}
        </pre>
      </>
    )
  return null
}

/** 卡片底部的按键提示，样式和列表卡的一致 */
function KeyHints({ items }: { items: { keys: string[]; label: string }[] }) {
  return (
    <div
      data-approval-keys
      className="flex flex-wrap gap-x-3 border-t border-line-subtle bg-wall-tint px-4 py-1 text-label text-fg-faint"
    >
      {items.map(({ keys, label }) => (
        <span key={label} className="inline-flex items-center gap-1">
          {keys.map(k => (
            <kbd
              key={k}
              className="rounded-sm border border-line border-b-2 bg-surface px-1 font-mono text-[10.5px] leading-[15px] text-fg-muted"
            >
              {k}
            </kbd>
          ))}
          {label}
        </span>
      ))}
    </div>
  )
}

export function ApprovalCard({
  request,
  onAnswer,
  onEscape,
}: {
  request: ApprovalRequest
  /** Esc：把焦点还给输入框（不拒绝） */
  onEscape?: () => void
  /** 返回 Promise 时等它结果：失败了卡片恢复可点并显示原因，不会卡住 */
  onAnswer: (d: ApprovalDecision) => void | Promise<unknown>
}) {
  useI18n()
  const Icon = ICON[request.kind]
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({})
  const [sent, setSent] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [formText, setFormText] = useState('{}')
  // 「本会话后续不再询问」会切成完全放行：先在卡片底部就地确认，AI 继续等
  const [confirmingAll, setConfirmingAll] = useState(false)
  const [focusWithin, setFocusWithin] = useState(false)
  // 焦点在底部按钮上：Enter 是点按钮、数字不选题，提示里不再写
  const [onFooter, setOnFooter] = useState(false)
  let formContent: Record<string, unknown> | null = null
  try {
    const value: unknown = JSON.parse(formText)
    if (value && typeof value === 'object' && !Array.isArray(value)) formContent = value as Record<string, unknown>
  } catch {
    /* 等待用户填好 */
  }

  const answer = (d: ApprovalDecision): void => {
    if (sent) return
    setSent(true)
    setFailure(null)
    void Promise.resolve()
      .then(() => onAnswer(d))
      .catch((e: unknown) => {
        setSent(false)
        setFailure(e instanceof Error ? e.message : String(e))
      })
  }

  const questions = request.questions ?? []
  const draft = (q: Question): QuestionDraft => drafts[q.question] ?? EMPTY_DRAFT
  const update = (q: Question, next: (d: QuestionDraft) => QuestionDraft): void =>
    setDrafts(prev => ({ ...prev, [q.question]: next(prev[q.question] ?? EMPTY_DRAFT) }))
  const answers = collectAnswers(questions, drafts)
  const recommended = request.kind === 'question' ? recommendedAnswers(questions) : null
  const canAllow = request.canAllow !== false && (request.formSchema === undefined || !!formContent)
  const alwaysScope = alwaysKeyScope(request.alwaysScopes)
  const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

  const ctrlName = mod === '⌘' ? 'Meta' : 'Control'
  const shortcutsAttr =
    request.kind === 'question'
      ? `${ctrlName}+Enter`
      : [
          `${ctrlName}+Enter`,
          `${ctrlName}+Backspace`,
          ...(alwaysScope && request.kind !== 'plan' ? [`${ctrlName}+Shift+Enter`] : []),
          'Escape',
        ].join(' ')

  // 键盘：提问卡 1–9 选项 / Enter 下一题 / Ctrl+Enter 提交；其余卡 Ctrl/⌘+Enter 允许一次、Ctrl/⌘+⌫ 拒绝、Esc 回输入框（和列表卡一致）
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (sent || confirmingAll || e.defaultPrevented) return
    const target = e.target as HTMLElement
    const typing = isTypingTarget(target)
    const native = e.nativeEvent
    // 按住 Enter 不放：浏览器每次连发都会点一下焦点所在的按钮（提交回答、切换选项、允许），这里拦下
    if (native.repeat && e.key === 'Enter' && !typing) {
      e.preventDefault()
      return
    }
    if (request.kind === 'question') {
      const block = target.closest<HTMLElement>('[data-question-index]')
      const blockAt = block ? Number(block.dataset.questionIndex) : null
      const onCard = target === e.currentTarget
      const answered = questions.map(q => collectAnswers([q], drafts) !== null)
      const pickAt = digitQuestion({ block: blockAt, onCard }, answered)
      const result = questionShortcut(native, {
        typing,
        canAdvance: !!block || onCard,
        canPick: pickAt !== null,
      })
      if (!result) return
      if (result.type === 'submit') {
        if (!answers) return
        e.preventDefault()
        answer({ type: 'answer', answers })
      } else if (result.type === 'pick') {
        const q = pickAt === null ? undefined : questions[pickAt]
        const option = q?.options[result.index]
        if (!q || !option) return
        e.preventDefault()
        update(q, d => pickOption(q, d, option.label))
      } else {
        // 到下一题的第一个选项；最后一题就落到「提交回答」上
        e.preventDefault()
        const at = blockAt === null ? 0 : blockAt + 1
        const root = e.currentTarget
        const next =
          root.querySelector<HTMLElement>(`[data-question-index="${at}"] button:not(:disabled)`) ??
          root.querySelector<HTMLElement>('[data-question-submit]:not(:disabled)')
        next?.focus()
      }
      return
    }
    // 「始终允许」的范围菜单开着时，Esc 留给菜单
    if (e.currentTarget.querySelector('[aria-haspopup="menu"][aria-expanded="true"]')) return
    const result = approvalShortcut(native, {
      typing,
      canAllow,
      // 计划卡没有「始终允许」
      scopes: request.kind === 'plan' ? [] : request.alwaysScopes,
    })
    if (!result) return
    e.preventDefault()
    if (result.type === 'focusComposer') onEscape?.()
    else if (result.type === 'allow')
      answer(request.formSchema !== undefined ? { type: 'form', content: formContent! } : { type: 'allow' })
    else if (result.type === 'always') answer({ type: 'allow_always', scope: result.scope })
    else answer({ type: 'deny' })
  }

  let hints: ReactNode = null
  if (focusWithin && !confirmingAll) {
    if (request.kind === 'question')
      hints = (
        <KeyHints
          items={[
            ...(onFooter ? [] : [{ keys: ['1–9'], label: tr('approvals.keys.pick') }]),
            ...(onFooter ? [] : [{ keys: ['Enter'], label: tr('approvals.keys.nextQuestion') }]),
            { keys: [mod, 'Enter'], label: tr('approvals.keys.submit') },
          ]}
        />
      )
    else {
      const plan = request.kind === 'plan'
      hints = (
        <KeyHints
          items={[
            ...(canAllow
              ? [
                  {
                    keys: [mod, 'Enter'],
                    label: tr(plan ? 'approvals.keys.startPlan' : 'approvals.keys.allowOnce'),
                  },
                ]
              : []),
            ...(alwaysScope && canAllow && !plan
              ? [
                  {
                    keys: [mod, 'Shift', 'Enter'],
                    label: `${SCOPE_INFO[alwaysScope].label}${tr('session.live.ApprovalCard.alwaysAllow')}`,
                  },
                ]
              : []),
            { keys: [mod, '⌫'], label: tr(plan ? 'approvals.keys.refinePlan' : 'approvals.keys.deny') },
            { keys: ['Esc'], label: tr('approvals.keys.back') },
          ]}
        />
      )
    }
  }

  return (
    <section
      className="pop-in shrink-0 rounded-xl border border-line-strong bg-surface shadow-menu outline-none"
      aria-live="polite"
      aria-keyshortcuts={shortcutsAttr}
      onKeyDown={onKeyDown}
      onFocus={e => {
        setFocusWithin(true)
        setOnFooter(!!(e.target as HTMLElement).closest('footer'))
      }}
      onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false)
      }}
      data-approval-card
      data-approval-request={request.requestId}
    >
      <header className="flex items-center gap-2 px-4 pt-3.5 pb-2 text-ui font-medium text-fg">
        <Icon size={16} strokeWidth={1.5} className="shrink-0 text-fg-secondary" />
        <span className="min-w-0 flex-1 truncate">{translateMessage(request.title)}</span>
        <span className="shrink-0 text-meta font-normal text-fg-faint">
          {tr('session.live.ApprovalCard.waitingForYourDecision')}
        </span>
      </header>

      <div className="px-4 pb-3">
        {request.formSchema !== undefined && (
          <label className="mb-3 flex flex-col gap-2 text-meta text-fg-muted">
            {tr('codex.mcpInput')}
            <textarea
              className="min-h-24 rounded-md border border-line bg-subtle p-2 font-mono text-meta text-fg"
              value={formText}
              onChange={event => setFormText(event.target.value)}
            />
          </label>
        )}
        <ApprovalBody request={request} />

        {request.kind === 'plan' && (
          <div className={cn(BODY, 'rounded-lg border border-line bg-wall-tint px-4 py-3')}>
            <Markdown text={request.plan || tr('session.live.ApprovalCard.noPlanContent')} />
          </div>
        )}

        {request.kind === 'question' && (
          <div className={cn(BODY, 'flex flex-col gap-3')}>
            {questions.map((q, qi) => (
              <div key={q.question} data-question-index={qi}>
                <div className="mb-1.5 text-list text-fg">
                  {q.header && (
                    <span className="mr-1.5 rounded-sm bg-subtle px-1.5 py-0.5 text-label text-fg-muted">
                      {q.header}
                    </span>
                  )}
                  {q.question}
                  {q.multiSelect && (
                    <span className="ml-1 text-meta text-fg-faint">
                      {tr('session.live.ApprovalCard.selectMultiple')}
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  {q.options.map((o, oi) => {
                    const on = draft(q).picks.includes(o.label)
                    return (
                      <button
                        key={o.label}
                        type="button"
                        aria-pressed={on}
                        onClick={() => update(q, d => pickOption(q, d, o.label))}
                        className={cn(
                          'rounded-lg border px-3 py-2 text-left hover:bg-hover',
                          on ? 'border-accent bg-accent-soft hover:bg-accent-soft' : 'border-line',
                        )}
                      >
                        <span className={cn('flex items-center gap-1.5 text-list', on ? 'text-accent-fg' : 'text-fg')}>
                          {oi < 9 && <kbd className="shrink-0 font-mono text-label text-fg-faint">{oi + 1}</kbd>}
                          {displayLabel(o.label)}
                          {isRecommended(o.label) && (
                            <span
                              data-recommended
                              className="rounded-sm bg-accent-soft px-1.5 py-px text-label text-accent-fg"
                            >
                              {tr('question.recommended')}
                            </span>
                          )}
                        </span>
                        {o.description && <span className="block text-meta text-fg-muted">{o.description}</span>}
                      </button>
                    )
                  })}
                  {canWriteIn(q) && q.options.length > 0 && (
                    <button
                      type="button"
                      aria-pressed={draft(q).other}
                      data-question-other
                      onClick={() => update(q, d => toggleOther(q, d))}
                      className={cn(
                        'rounded-lg border px-3 py-2 text-left text-list hover:bg-hover',
                        draft(q).other
                          ? 'border-accent bg-accent-soft text-accent-fg hover:bg-accent-soft'
                          : 'border-line text-fg',
                      )}
                    >
                      {tr('question.other')}
                    </button>
                  )}
                  {canWriteIn(q) && (q.options.length === 0 || draft(q).other) && (
                    <input
                      type={q.secret ? 'password' : 'text'}
                      aria-label={q.question}
                      placeholder={tr('question.otherPlaceholder')}
                      autoFocus={q.options.length > 0}
                      className="rounded-md border border-line bg-subtle px-3 py-2 text-list text-fg placeholder:text-fg-faint"
                      value={draft(q).text}
                      onChange={event => {
                        const text = event.target.value
                        update(q, d => ({ ...d, text }))
                      }}
                      onKeyDown={event => {
                        if (event.key === 'Enter' && !event.nativeEvent.isComposing && answers && !sent) {
                          event.preventDefault()
                          answer({ type: 'answer', answers })
                        }
                      }}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {failure && (
        <p role="alert" className="px-4 pb-2 text-meta text-danger">
          {tr('session.live.ApprovalCard.sendFailed', { p0: translateMessage(failure) })}
        </p>
      )}
      {confirmingAll ? (
        <FullAccessConfirm
          title={tr('fullAccess.confirm.title')}
          items={[tr('fullAccess.confirm.allowThis'), tr('fullAccess.confirm.scopeCard')]}
          cancelLabel={tr('fullAccess.confirm.back')}
          confirmLabel={tr('fullAccess.confirm.allowThisOk')}
          disabled={sent}
          onCancel={() => setConfirmingAll(false)}
          onConfirm={() => answer({ type: 'allow_all' })}
          className="rounded-b-xl border-t border-line-subtle bg-hover px-4 pt-2.5 pb-2.5"
        />
      ) : (
        <footer className="flex flex-wrap items-center gap-2 rounded-b-xl border-t border-line-subtle bg-wall-tint px-4 py-2.5">
          {request.kind === 'question' ? (
            <>
              <Button
                variant="primary"
                disabled={!answers || sent}
                className="disabled:opacity-50"
                data-question-submit
                onClick={() => answers && answer({ type: 'answer', answers })}
              >
                {tr('session.live.ApprovalCard.submitAnswers')}{' '}
              </Button>
              {recommended && (
                <Button
                  variant="outline"
                  disabled={sent}
                  data-all-recommended
                  onClick={() => answer({ type: 'answer', answers: recommended })}
                >
                  {tr('question.allRecommended')}
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={sent}
                onClick={() =>
                  answer({
                    type: 'deny',
                    get message() {
                      return tr('session.live.ApprovalCard.userSkippedThisQuestion')
                    },
                  })
                }
              >
                {tr('session.live.ApprovalCard.skip')}{' '}
              </Button>
              <span className="ml-auto text-meta text-fg-faint">
                {tr('approvals.answeredCount', { n: answeredCount(questions, drafts), m: questions.length })}
              </span>
            </>
          ) : request.kind === 'plan' ? (
            <>
              <Button variant="primary" disabled={sent} onClick={() => answer({ type: 'allow' })}>
                {tr('session.live.ApprovalCard.startExecution')}{' '}
              </Button>
              <Button variant="ghost" disabled={sent} onClick={() => answer({ type: 'deny' })}>
                {tr('session.live.ApprovalCard.refinePlan')}{' '}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="primary"
                disabled={sent || request.canAllow === false || (request.formSchema !== undefined && !formContent)}
                onClick={() =>
                  answer(request.formSchema !== undefined ? { type: 'form', content: formContent! } : { type: 'allow' })
                }
              >
                {tr('session.live.ApprovalCard.allowOnce')}{' '}
              </Button>
              {request.alwaysScopes.length > 0 && (
                <AlwaysAllowButton
                  scopes={request.alwaysScopes}
                  disabled={sent}
                  onPick={scope => answer({ type: 'allow_always', scope })}
                />
              )}
              <Button variant="ghost" disabled={sent} onClick={() => answer({ type: 'deny' })}>
                {tr('session.live.ApprovalCard.deny')}{' '}
              </Button>
              {request.canAllowAll && (
                <Button
                  variant="outline"
                  className="ml-auto"
                  disabled={sent}
                  title={tr('session.live.ApprovalCard.allowAllHint')}
                  onClick={() => setConfirmingAll(true)}
                >
                  {tr('session.live.ApprovalCard.allowAll')}
                </Button>
              )}
            </>
          )}
        </footer>
      )}
      {hints}
    </section>
  )
}
