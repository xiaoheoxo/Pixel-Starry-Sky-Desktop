import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from 'react'
import { MessageCircleQuestion } from 'lucide-react'
import type { Question } from '@pixelsky/protocol'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../../i18n/core'
import { Button, cn } from '@/ui'
import { isTypingTarget } from '@/ui/menuDigit'
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
import { digitQuestion, questionShortcut } from './approvals/cardKeys'
import { formatAsyncAnswer, type ActiveAsyncQuestion } from './asyncQuestionModel'

const STORAGE_PREFIX = 'pixelsky.asyncQuestion.dismissed:'
const EMPTY_SET: ReadonlySet<string> = new Set()
const dismissedCache = new Map<string, ReadonlySet<string>>()
const dismissedListeners = new Set<() => void>()

export function clearDismissedAsyncQuestionCache(): void {
  dismissedCache.clear()
}

export function readDismissedAsyncQuestions(sessionId: string | null): Set<string> {
  if (!sessionId) return new Set<string>()
  const cached = dismissedCache.get(sessionId)
  if (cached) return new Set<string>(cached)
  if (typeof sessionStorage === 'undefined') return new Set<string>()
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + sessionId)
    if (!raw) return new Set<string>()
    const parsed = JSON.parse(raw)
    const set = Array.isArray(parsed)
      ? new Set<string>(parsed.filter((x): x is string => typeof x === 'string'))
      : new Set<string>()
    dismissedCache.set(sessionId, set)
    return new Set<string>(set)
  } catch {
    return new Set<string>()
  }
}

export function saveDismissedAsyncQuestion(sessionId: string | null, itemId: string): Set<string> {
  const next = readDismissedAsyncQuestions(sessionId)
  next.add(itemId)
  const trimmed = new Set([...next].slice(-64))
  if (sessionId) {
    dismissedCache.set(sessionId, trimmed)
    if (typeof sessionStorage !== 'undefined') {
      try {
        sessionStorage.setItem(STORAGE_PREFIX + sessionId, JSON.stringify([...trimmed]))
      } catch {
        /* sessionStorage 满时仅保留内存状态 */
      }
    }
    dismissedListeners.forEach(fn => fn())
  }
  return trimmed
}

/** 订阅某会话已跳过的异步提问 id（多窗格双开同一会话时点「跳过」实时同步） */
export function useDismissedAsyncQuestions(sessionId: string | null): ReadonlySet<string> {
  return useSyncExternalStore(
    fn => {
      dismissedListeners.add(fn)
      return () => dismissedListeners.delete(fn)
    },
    () => {
      if (!sessionId) return EMPTY_SET
      let cached = dismissedCache.get(sessionId)
      if (!cached) {
        cached = readDismissedAsyncQuestions(sessionId)
        dismissedCache.set(sessionId, cached)
      }
      return cached
    },
  )
}

/**
 * Codex 异步提问卡片（request_user_input_async）：
 * 常驻在输入框上方，不随 turn_completed 消失；复用同步提问卡的推荐项、自由输入和 1–9 / Alt+↑ / Ctrl+Enter 快捷键。
 */
export function AsyncQuestionCard({
  active,
  bounds,
  onSubmit,
  onDismiss,
  onEscape,
}: {
  active: ActiveAsyncQuestion
  bounds?: RefObject<HTMLElement | null>
  onSubmit: (text: string) => Promise<void>
  onDismiss: (itemId: string) => void
  onEscape?: () => void
}) {
  useI18n()
  const { itemId, questions } = active
  const cardRef = useRef<HTMLElement>(null)
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({})
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  // 与同步审批一致：输入框里按 Alt+↑ 聚焦到提问卡第一个可交互控件
  useEffect(() => {
    const root = bounds?.current
    if (!root) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (!e.altKey || e.key !== 'ArrowUp' || !(e.target as HTMLElement | null)?.closest?.('.composer-card')) return
      const target = cardRef.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')
      if (!target) return
      e.preventDefault()
      target.focus()
    }
    root.addEventListener('keydown', onKey, true)
    return () => root.removeEventListener('keydown', onKey, true)
  }, [bounds, itemId])

  const draft = (q: Question): QuestionDraft => drafts[q.question] ?? EMPTY_DRAFT
  const update = (q: Question, next: (d: QuestionDraft) => QuestionDraft): void =>
    setDrafts(prev => ({ ...prev, [q.question]: next(prev[q.question] ?? EMPTY_DRAFT) }))

  const answers = collectAnswers(questions, drafts)
  const recommended = recommendedAnswers(questions)
  const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
  const ctrlName = mod === '⌘' ? 'Meta' : 'Control'

  const sendAnswers = (picked: Record<string, string>): void => {
    const text = formatAsyncAnswer(questions, picked)
    if (!text || sending) return
    setSending(true)
    setFailure(null)
    void onSubmit(text)
      .then(() => {
        onDismiss(itemId)
      })
      .catch((err: unknown) => {
        setSending(false)
        setFailure(err instanceof Error ? err.message : String(err))
      })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (sending || e.defaultPrevented) return
    const target = e.target as HTMLElement
    const typing = isTypingTarget(target)
    const native = e.nativeEvent
    if (native.repeat && e.key === 'Enter' && !typing) {
      e.preventDefault()
      return
    }
    if (!typing && e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      onEscape?.()
      return
    }
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
      sendAnswers(answers)
    } else if (result.type === 'pick') {
      const q = pickAt === null ? undefined : questions[pickAt]
      const option = q?.options[result.index]
      if (!q || !option) return
      e.preventDefault()
      update(q, d => pickOption(q, d, option.label))
    } else {
      e.preventDefault()
      const at = blockAt === null ? 0 : blockAt + 1
      const root = e.currentTarget
      const next =
        root.querySelector<HTMLElement>(`[data-question-index="${at}"] button:not(:disabled)`) ??
        root.querySelector<HTMLElement>('[data-question-submit]:not(:disabled)')
      next?.focus()
    }
  }

  return (
    <div className="mb-3" data-async-questions>
      <section
        ref={cardRef}
        key={itemId}
        tabIndex={-1}
        aria-live="polite"
        aria-keyshortcuts={`${ctrlName}+Enter Escape`}
        onKeyDown={onKeyDown}
        data-async-question-card={itemId}
        className="pop-in shrink-0 rounded-xl border border-line-strong bg-surface shadow-menu outline-none"
      >
        <header className="flex items-center gap-2 px-4 pt-3.5 pb-2 text-ui font-medium text-fg">
          <MessageCircleQuestion size={16} strokeWidth={1.5} className="shrink-0 text-fg-secondary" />
          <span className="min-w-0 flex-1 truncate">{tr('codex.asyncQuestion.title')}</span>
          <span className="shrink-0 rounded-sm bg-subtle px-1.5 py-0.5 text-label font-normal text-fg-muted">
            {tr('codex.asyncQuestion.badge')}
          </span>
        </header>

        <div className="px-4 pb-3">
          <div className="flex max-h-[34vh] flex-col gap-3 overflow-auto">
            {questions.map((q, qi) => (
              <div key={q.id ?? `${qi}:${q.question}`} data-question-index={qi}>
                <div className="mb-1.5 text-list text-fg">{q.question}</div>
                <div className="flex flex-col gap-1">
                  {q.options.map((o, oi) => {
                    const on = draft(q).picks.includes(o.label)
                    return (
                      <button
                        key={o.label}
                        type="button"
                        aria-pressed={on}
                        data-question-option
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
                      data-question-option
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
                      type="text"
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
                        if (event.key === 'Enter' && !event.nativeEvent.isComposing && answers && !sending) {
                          event.preventDefault()
                          sendAnswers(answers)
                        }
                      }}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {failure && (
          <p role="alert" className="px-4 pb-2 text-meta text-danger">
            {tr('session.live.ApprovalCard.sendFailed', { p0: translateMessage(failure) })}
          </p>
        )}

        <footer className="flex flex-wrap items-center gap-2 rounded-b-xl border-t border-line-subtle bg-wall-tint px-4 py-2.5">
          <Button
            variant="primary"
            disabled={!answers || sending}
            className="disabled:opacity-50"
            data-question-submit
            title={`${tr('approvals.keys.submit')} (${mod}+Enter)`}
            onClick={() => answers && sendAnswers(answers)}
          >
            {tr('session.live.ApprovalCard.submitAnswers')}
          </Button>
          {recommended && (
            <Button variant="outline" disabled={sending} data-all-recommended onClick={() => sendAnswers(recommended)}>
              {tr('question.allRecommended')}
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={sending}
            onClick={() => {
              onDismiss(itemId)
              onEscape?.()
            }}
          >
            {tr('session.live.ApprovalCard.skip')}
          </Button>
          <span className="ml-auto text-meta text-fg-faint">
            {tr('approvals.answeredCount', { n: answeredCount(questions, drafts), m: questions.length })}
          </span>
        </footer>
      </section>
    </div>
  )
}
