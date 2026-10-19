// 设置 › 反馈 › 新反馈（docs/ui/feedback.md §2.3、feedback-v2.md §4）
import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { Button, cn } from '@/ui'
import { DiscardBar } from '@/ui/DiscardBar'
import {
  FEEDBACK_LIMITS,
  type FeedbackDetail,
  type FeedbackErrorSnippet,
  type FeedbackType,
} from '../../../../shared/types/feedback'
import { AttachmentOptions } from './AttachmentOptions'
import { clearDraft, loadDraft, saveDraft, type LogWindow } from './draft'
import type { FeedbackPrefill } from './focus'
import { ImageField, toImageInputs, useFeedbackImages } from './ImageField'
import { checkCreate, clipErrorText, composeBody, errorText, isAuthExpired, type LimitReason } from './logic'
import { SEND_HINT, TYPE_ICON } from './parts'
import { feedbackApi } from './store'
import { useFeedbackPreview } from './usePreview'
import { fieldErrors } from './view'

export const INPUT_CLASS =
  'w-full rounded-md border border-line bg-surface px-3 text-list text-fg outline-none placeholder:text-fg-faint focus:border-accent'

const TYPES: FeedbackType[] = ['bug', 'feature', 'other']
const TYPE_NAME: Record<FeedbackType, () => string> = {
  bug: () => tr('feedback.type.bug'),
  feature: () => tr('feedback.type.feature'),
  other: () => tr('feedback.type.other'),
}
const TYPE_DESC: Record<FeedbackType, () => string> = {
  bug: () => tr('feedback.form.typeBugDesc'),
  feature: () => tr('feedback.form.typeFeatureDesc'),
  other: () => tr('feedback.form.typeOtherDesc'),
}

const BODY_PLACEHOLDER: Record<FeedbackType, () => string> = {
  bug: () => tr('feedback.form.bodyBug'),
  feature: () => tr('feedback.form.bodyFeature'),
  other: () => tr('feedback.form.bodyOther'),
}

export const reasonText = (reason: LimitReason): string => {
  switch (reason.code) {
    case 'titleEmpty':
      return tr('feedback.limit.titleEmpty')
    case 'bodyEmpty':
      return tr('feedback.limit.bodyEmpty')
    case 'previewing':
      return tr('feedback.limit.preparing')
    case 'previewFailed':
      return tr('feedback.limit.previewFailed')
    case 'titleLong':
      return tr('feedback.limit.titleLong', { p0: reason.limit })
    case 'bodyLong':
      return tr('feedback.limit.bodyLong', { p0: reason.limit })
    case 'images':
      return tr('feedback.limit.images', { p0: reason.limit })
  }
}

const FIELD_CODES = new Set<LimitReason['code']>(['titleEmpty', 'titleLong', 'bodyEmpty', 'bodyLong'])

export function FeedbackForm({
  email,
  prefill,
  onCancel,
  onDone,
  onFailed,
}: {
  email: string
  prefill: FeedbackPrefill | null
  onCancel: () => void
  onDone: (detail: FeedbackDetail) => void
  /** 提交出错（登录过期时让页面刷新状态） */
  onFailed: (e: unknown) => void
}) {
  useI18n()
  const [initial] = useState(() => {
    const draft = loadDraft(email)
    const wantsLogs = !!(prefill?.logs || prefill?.logsSince || prefill?.error)
    return {
      ...draft,
      type: prefill?.type ?? draft.type,
      logs: wantsLogs ? true : draft.logs,
      window: prefill?.logsSince ? ('around' as const) : draft.window,
    }
  })
  const [type, setType] = useState<FeedbackType>(initial.type)
  const [title, setTitle] = useState(initial.title)
  const [body, setBody] = useState(initial.body)
  const [steps, setSteps] = useState(initial.steps)
  const [stepsOpen, setStepsOpen] = useState(() => initial.steps.trim() !== '')
  const [diagnostics, setDiagnostics] = useState(initial.diagnostics)
  const [logsFlag, setLogsFlag] = useState<boolean | null>(initial.logs)
  const [range, setRange] = useState<LogWindow>(initial.window)
  const [error] = useState<FeedbackErrorSnippet | null>(prefill?.error ?? null)
  const [includeError, setIncludeError] = useState(true)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  // 文字有本地草稿兜底，粘贴 / 拖进来的图片没有：带着图片取消先问一句
  const [asking, setAsking] = useState(false)
  // 第一次点提交以后才在对应框下面显示红字，之后实时更新
  const [attempted, setAttempted] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const images = useFeedbackImages()

  const around = prefill?.logsSince ?? null
  const logsOn = logsFlag ?? type === 'bug'
  const effectiveRange: LogWindow = range === 'around' && around === null ? '2h' : range
  const preview = useFeedbackPreview(logsOn, effectiveRange, around)

  // 草稿（不存图片和日志原文）
  useEffect(() => {
    saveDraft(email, { type, title, body, steps, diagnostics, logs: logsFlag, window: range })
  }, [email, type, title, body, steps, diagnostics, logsFlag, range])

  const composed = composeBody(body, type === 'bug' ? steps : '', tr('feedback.form.steps'))
  let reason: LimitReason | null = checkCreate({ title, body, composed, images: images.images.length })
  if (!reason && logsOn && preview.loading) reason = { code: 'previewing' }
  if (!reason && logsOn && preview.error) reason = { code: 'previewFailed' }

  const errors = fieldErrors({
    title,
    body,
    composed,
    titleMax: FEEDBACK_LIMITS.titleChars,
    bodyMax: FEEDBACK_LIMITS.bodyChars,
  })
  const titleReason: LimitReason | null = errors.title
    ? errors.title === 'titleEmpty'
      ? { code: 'titleEmpty' }
      : { code: 'titleLong', limit: FEEDBACK_LIMITS.titleChars }
    : null
  const bodyReason: LimitReason | null = errors.body
    ? errors.body === 'bodyEmpty'
      ? { code: 'bodyEmpty' }
      : { code: 'bodyLong', limit: FEEDBACK_LIMITS.bodyChars }
    : null

  const submit = async (): Promise<void> => {
    if (busy) return
    if (reason) {
      // 必填项没填好：显示红字，光标放到第一个有问题的框
      setAttempted(true)
      if (titleReason) titleRef.current?.focus()
      else if (bodyReason) bodyRef.current?.focus()
      return
    }
    setBusy(true)
    setFailure(null)
    try {
      const detail = await feedbackApi().create({
        type,
        title: title.trim(),
        body: composed,
        diagnostics,
        logs: logsOn ? preview.data?.logs?.text || null : null,
        images: toImageInputs(images.images),
        error: error && includeError ? { ...error, text: clipErrorText(error.text) } : null,
      })
      clearDraft(email)
      void feedbackApi()
        .refresh()
        .catch(() => {})
      onDone(detail)
    } catch (e) {
      setFailure(translateMessage(errorText(e)))
      if (isAuthExpired(e)) onFailed(e)
      setBusy(false)
    }
  }

  const showTitleError = attempted && titleReason
  const showBodyError = attempted && bodyReason
  return (
    <form
      data-feedback-form
      onPaste={images.onPaste}
      onDragEnter={images.onDragEnter}
      onDragOver={images.onDragOver}
      onDragLeave={images.onDragLeave}
      onDrop={images.onDrop}
      onKeyDown={e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          void submit()
        }
      }}
      onSubmit={e => {
        e.preventDefault()
        void submit()
      }}
      className="flex flex-col gap-5"
    >
      <fieldset>
        <legend className="mb-2 text-ui font-medium text-fg">{tr('feedback.form.typeQuestion')}</legend>
        <div role="radiogroup" aria-label={tr('feedback.type.label')} className="grid grid-cols-3 gap-2.5">
          {TYPES.map(t => {
            const Icon = TYPE_ICON[t]
            const selected = type === t
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={selected}
                data-feedback-type={t}
                onClick={() => setType(t)}
                className={cn(
                  'press flex flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left',
                  selected ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-hover',
                )}
              >
                <span
                  className={cn(
                    'flex items-center gap-1.5 text-ui font-medium',
                    selected ? 'text-accent-fg' : 'text-fg',
                  )}
                >
                  <Icon size={15} strokeWidth={1.6} />
                  {TYPE_NAME[t]()}
                </span>
                <span className="text-meta text-fg-muted">{TYPE_DESC[t]()}</span>
              </button>
            )
          })}
        </div>
      </fieldset>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <label htmlFor="feedback-title" className="text-ui font-medium text-fg">
            {tr('feedback.form.title')}
          </label>
          <span className="text-meta text-fg-faint tabular-nums">
            {[...title].length} / {FEEDBACK_LIMITS.titleChars}
          </span>
        </div>
        <input
          id="feedback-title"
          ref={titleRef}
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder={tr('feedback.form.titlePlaceholder')}
          aria-invalid={!!showTitleError}
          spellCheck={false}
          className={cn(INPUT_CLASS, 'h-8', showTitleError && 'border-danger focus:border-danger')}
        />
        {showTitleError && <FieldError>{reasonText(titleReason)}</FieldError>}
      </div>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <label htmlFor="feedback-body" className="text-ui font-medium text-fg">
            {tr('feedback.form.body')}
          </label>
          <span className="text-meta text-fg-faint tabular-nums">
            {[...composed].length} / {FEEDBACK_LIMITS.bodyChars}
          </span>
        </div>
        <textarea
          id="feedback-body"
          ref={bodyRef}
          value={body}
          onChange={e => setBody(e.target.value)}
          placeholder={BODY_PLACEHOLDER[type]()}
          aria-invalid={!!showBodyError}
          rows={6}
          className={cn(INPUT_CLASS, 'resize-y py-2', showBodyError && 'border-danger focus:border-danger')}
        />
        {showBodyError && <FieldError>{reasonText(bodyReason)}</FieldError>}
      </div>

      {type === 'bug' &&
        (stepsOpen ? (
          <div>
            <label htmlFor="feedback-steps" className="mb-1.5 block text-ui font-medium text-fg">
              {tr('feedback.form.stepsOptional')}
            </label>
            <textarea
              id="feedback-steps"
              value={steps}
              onChange={e => setSteps(e.target.value)}
              placeholder={tr('feedback.form.stepsPlaceholder')}
              rows={3}
              className={cn(INPUT_CLASS, 'resize-y py-2')}
            />
          </div>
        ) : (
          <button
            type="button"
            data-feedback-add-steps
            onClick={() => setStepsOpen(true)}
            className="press -mt-2 inline-flex h-7 w-fit items-center gap-1 rounded-md px-1 text-meta text-accent hover:underline"
          >
            <Plus size={13} />
            {tr('feedback.form.addSteps')}
          </button>
        ))}

      <AttachmentOptions
        value={{ diagnostics, logs: logsOn, range: effectiveRange, includeError }}
        onChange={patch => {
          if (patch.diagnostics !== undefined) setDiagnostics(patch.diagnostics)
          if (patch.logs !== undefined) setLogsFlag(patch.logs)
          if (patch.range !== undefined) setRange(patch.range)
          if (patch.includeError !== undefined) setIncludeError(patch.includeError)
        }}
        preview={preview}
        hasAround={around !== null}
        error={error}
        box
        footer={
          <>
            <div className="py-2.5">
              <ImageField state={images} />
            </div>
            <p className="pt-2.5 text-meta text-fg-faint">{tr('feedback.attach.privacy')}</p>
          </>
        }
      />

      <div className="border-t border-line pt-4">
        <p className="mb-3 text-meta text-fg-muted">{tr('feedback.form.footer', { p0: email })}</p>
        {failure && (
          <p role="alert" className="selectable mb-3 rounded-md bg-subtle px-3 py-2 text-meta break-all text-danger">
            {failure}
          </p>
        )}
        <div className="flex items-center justify-end gap-3">
          {reason && !FIELD_CODES.has(reason.code) && !busy && (
            <span data-feedback-reason className="min-w-0 truncate text-meta text-fg-faint">
              {reasonText(reason)}
            </span>
          )}
          <Button onClick={() => (images.images.length ? setAsking(true) : onCancel())} disabled={busy}>
            {tr('feedback.form.cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={busy || reason?.code === 'previewing'}>
            {busy ? tr('feedback.form.submitting') : tr('feedback.form.submit')}
            {!busy && <span className="ml-1.5 font-mono text-label opacity-70">{SEND_HINT}</span>}
          </Button>
        </div>
        {asking && <DiscardBar onKeep={() => setAsking(false)} onDiscard={onCancel} />}
      </div>
    </form>
  )
}

function FieldError({ children }: { children: string }) {
  return (
    <p role="alert" data-feedback-field-error className="mt-1 text-meta text-danger">
      {children}
    </p>
  )
}
