import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ExtStoreReportInput, ExtStoreReportReason } from '@pixelsky/protocol'
import { Button, cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { translateMessage } from '@/i18n/core'
import { REPORT_DETAIL_MAX, REPORT_REASONS, reportInputOf, reportProblem, type ReportDraft } from './detailActions'

// 举报对话框（docs/ui/extension-store-client.md §2.2）：原因六选一，选「其他」时说明必填，说明最多 2000 字，
// 版本默认是本机装的版本、没装就是最新版；没登录时提交按钮写「登录后举报」，点了去登录

const INPUT =
  'w-full min-w-0 rounded-md border border-line bg-surface px-3 py-2 text-ui text-fg outline-none focus:border-accent-line focus:ring-2 focus:ring-composer-ring'

const REASON_KEYS = {
  malicious: 'extstoreReport.reason.malicious',
  broken: 'extstoreReport.reason.broken',
  copyright: 'extstoreReport.reason.copyright',
  inappropriate: 'extstoreReport.reason.inappropriate',
  misleading: 'extstoreReport.reason.misleading',
  other: 'extstoreReport.reason.other',
} as const satisfies Record<ExtStoreReportReason, string>

/** 云端错误（codedError）转成界面文案；rate_limited / already_reported 在词典里有专门的句子 */
export const reportErrorText = (e: unknown): string => translateMessage((e as Error)?.message ?? String(e))

export interface ReportFormViewProps {
  draft: ReportDraft
  /** 能选的版本（新的在前）；至少包含 draft.version */
  versions: string[]
  signedIn: boolean
  busy: boolean
  done: boolean
  /** 提交失败的文案 */
  error: string | null
  onChange(next: ReportDraft): void
  onSubmit(): void
  onLogin(): void
  onClose(): void
}

/** 表单本体（无状态，测试直接渲染它） */
export function ReportFormView(props: ReportFormViewProps) {
  const { draft, versions, signedIn, busy, done, error, onChange, onSubmit, onLogin, onClose } = props
  const { t } = useI18n()
  const problem = reportProblem(draft)
  const needDetail = draft.reason === 'other'
  const options = versions.includes(draft.version) || !draft.version ? versions : [draft.version, ...versions]

  if (done)
    return (
      <div data-report-dialog="done">
        <p className="text-ui text-fg">{t('extstoreReport.done')}</p>
        <div className="mt-4 flex justify-end">
          <Button onClick={onClose}>{t('extstoreReport.close')}</Button>
        </div>
      </div>
    )

  return (
    <div data-report-dialog="form">
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-meta font-medium text-fg-muted">{t('extstoreReport.reason')}</legend>
        {REPORT_REASONS.map(reason => (
          <label key={reason} className="flex cursor-pointer items-center gap-2 text-ui text-fg">
            <input
              type="radio"
              name="extstore-report-reason"
              value={reason}
              checked={draft.reason === reason}
              disabled={busy}
              onChange={() => onChange({ ...draft, reason })}
            />
            {t(REASON_KEYS[reason])}
          </label>
        ))}
      </fieldset>

      <label className="mt-4 flex flex-col gap-1.5">
        <span className="text-meta font-medium text-fg-muted">
          {t('extstoreReport.detail')}
          {needDetail && <span className="ml-1 text-danger">*</span>}
        </span>
        <textarea
          value={draft.detail}
          maxLength={REPORT_DETAIL_MAX}
          rows={4}
          required={needDetail}
          disabled={busy}
          placeholder={t('extstoreReport.detailPlaceholder')}
          onChange={e => onChange({ ...draft, detail: e.target.value })}
          className={cn(INPUT, 'resize-none')}
        />
        <span className="flex justify-between text-meta text-fg-faint">
          <span className={problem === 'detailRequired' ? 'text-danger' : undefined}>
            {needDetail ? t('extstoreReport.detailRequired') : ''}
          </span>
          <span data-report-count>{t('extstoreReport.count', { n: draft.detail.length, max: REPORT_DETAIL_MAX })}</span>
        </span>
      </label>

      <label className="mt-3 flex flex-col gap-1.5">
        <span className="text-meta font-medium text-fg-muted">{t('extstoreReport.version')}</span>
        <select
          value={draft.version}
          disabled={busy}
          onChange={e => onChange({ ...draft, version: e.target.value })}
          className={INPUT}
        >
          {options.map(v => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>

      {error && (
        <p role="alert" data-report-error className="selectable mt-3 break-words text-meta text-danger">
          {error}
        </p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          {t('extstoreReport.cancel')}
        </Button>
        {signedIn ? (
          <Button variant="primary" disabled={busy || problem !== null} onClick={onSubmit}>
            {busy ? t('extstoreReport.submitting') : t('extstoreReport.submit')}
          </Button>
        ) : (
          <Button variant="primary" onClick={onLogin}>
            {t('extstoreReport.signIn')}
          </Button>
        )}
      </div>
    </div>
  )
}

export interface ReportDialogProps {
  name: string
  /** 默认版本（defaultReportVersion 算好的） */
  defaultVersion: string
  versions: string[]
  signedIn: boolean
  /** 提交；失败时抛错（codedError 会被翻成文案） */
  onSubmit(input: ExtStoreReportInput): Promise<void>
  onLogin(): void
  onClose(): void
}

/** 弹层 + 状态：提交中不能关；成功后显示「已提交」 */
export function ReportDialog(props: ReportDialogProps) {
  const { name, defaultVersion, versions, signedIn, onSubmit, onLogin, onClose } = props
  const { t } = useI18n()
  const [draft, setDraft] = useState<ReportDraft>({ reason: null, detail: '', version: defaultVersion })
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const closeRef = useRef({ busy, onClose })
  closeRef.current = { busy, onClose }
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      if (!closeRef.current.busy) closeRef.current.onClose()
    }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [])

  const submit = async (): Promise<void> => {
    if (busy || reportProblem(draft)) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(reportInputOf(draft))
      if (alive.current) setDone(true)
    } catch (e) {
      if (alive.current) setError(reportErrorText(e))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-scrim p-4"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('extstoreReport.title')}
        className="pop-in max-h-full w-full max-w-md overflow-y-auto rounded-xl border border-line-card bg-popover p-5 text-fg shadow-popover outline-none"
      >
        <h3 className="mb-4 break-words text-section font-semibold">
          {t('extstoreReport.title')}
          <span className="ml-2 text-meta font-normal text-fg-faint">{name}</span>
        </h3>
        <ReportFormView
          draft={draft}
          versions={versions}
          signedIn={signedIn}
          busy={busy}
          done={done}
          error={error}
          onChange={setDraft}
          onSubmit={() => void submit()}
          onLogin={onLogin}
          onClose={onClose}
        />
      </div>
    </div>,
    document.body,
  )
}
