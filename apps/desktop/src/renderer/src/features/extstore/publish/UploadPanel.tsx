import { useState, type DragEvent } from 'react'
import { Check, X } from 'lucide-react'
import type { ExtPackContributes, ExtStoreCheckReport, ExtStorePickUploadResult } from '@pixelsky/protocol'
import { Button, cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { CheckReport } from './CheckReport'
import { canSubmit, contentRows, failedChecks, readDroppedZip, type ContentRow } from './publishModel'

const KIND_KEY = {
  grammars: 'extstore.publish.kind.grammars',
  themes: 'extstore.publish.kind.themes',
  snippets: 'extstore.publish.kind.snippets',
  iconThemes: 'extstore.publish.kind.iconThemes',
  taskTemplates: 'extstore.publish.kind.taskTemplates',
  skills: 'extstore.publish.kind.skills',
  prompts: 'extstore.publish.kind.prompts',
} as const

function CheckLine({ ok, children }: { ok: boolean; children: string }) {
  const Icon = ok ? Check : X
  return (
    <li data-check-ok={ok} className={cn('flex items-start gap-2 text-ui', ok ? 'text-fg' : 'text-danger')}>
      <Icon size={14} className={cn('mt-0.5 shrink-0', ok ? 'text-accent' : 'text-danger')} />
      <span>{children}</span>
    </li>
  )
}

function ContentsList({ rows }: { rows: ContentRow[] }) {
  const { t } = useI18n()
  if (!rows.length) return <p className="text-ui text-fg-faint">{t('extstore.publish.upload.contentsEmpty')}</p>
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-ui text-fg-muted">
      {rows.map(r => (
        <li key={r.kind}>
          {t(KIND_KEY[r.kind])} {r.count}
          {r.isNew && <span className="ml-1 text-warn">{t('extstore.publish.upload.new')}</span>}
        </li>
      ))}
    </ul>
  )
}

/**
 * 上传面板。picked 是 pickUpload 的结果（还没选包时是 null）；previous 是上一个上架版本的清单贡献
 * （没上架过传 null，全算新增）；cloudReport 是云端回 check_failed 时带回来的检查结果。
 */
export function UploadPanel({
  publisherName,
  picked,
  previous,
  uploading,
  error,
  cloudReport,
  onPick,
  onSubmit,
  onCancel,
}: {
  publisherName: string
  picked: ExtStorePickUploadResult | null
  previous: ExtPackContributes | null
  uploading: boolean
  error?: string | null
  cloudReport?: ExtStoreCheckReport | null
  /** null 弹选择框；拖进来的 zip 传字节 */
  onPick(input: null | { bytes: ArrayBuffer; name: string }): void
  onSubmit(token: string): void
  onCancel(): void
}) {
  const { t } = useI18n()
  const [dropError, setDropError] = useState<'tooLarge' | 'notZip' | null>(null)
  const [over, setOver] = useState(false)

  const onDrop = async (e: DragEvent): Promise<void> => {
    e.preventDefault()
    setOver(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    const result = await readDroppedZip(file)
    if (!result.ok) return setDropError(result.reason)
    setDropError(null)
    onPick({ bytes: result.bytes, name: result.name })
  }

  const failed = picked ? failedChecks(picked.checks) : []
  const submittable = picked ? picked.token !== '' && canSubmit(picked.report, picked.checks) && !uploading : false
  const shownError =
    dropError === 'tooLarge'
      ? t('errors.extstore.api.tooLarge')
      : dropError === 'notZip'
        ? t('extstore.publish.upload.dropHint')
        : (error ?? null)
  return (
    <section data-upload-panel className="rounded-xl border border-line bg-surface p-4">
      <h4 className="mb-3 text-section font-semibold text-fg">
        {picked
          ? t('extstore.publish.upload.title', { id: picked.id, version: picked.version })
          : t('extstore.publish.upload.titleIdle')}
      </h4>
      <button
        type="button"
        data-drop-zone
        disabled={uploading}
        onClick={() => onPick(null)}
        onDragOver={e => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={e => void onDrop(e)}
        className={cn(
          'no-drag mb-3 w-full rounded-lg border border-dashed px-3 py-4 text-center text-ui text-fg-muted',
          over ? 'border-accent bg-hover' : 'border-line-strong',
        )}
      >
        {t('extstore.publish.upload.drop')}
        <span className="mt-1 block text-meta text-fg-faint">{t('extstore.publish.upload.dropHint')}</span>
      </button>

      {picked && (
        <>
          <ul className="mb-3 space-y-1">
            <CheckLine ok={picked.checks.permissions.length === 0}>
              {picked.checks.permissions.length === 0
                ? t('extstore.publish.upload.check.permissionsNone')
                : t('extstore.publish.upload.check.permissions', { list: picked.checks.permissions.join(', ') })}
            </CheckLine>
            <CheckLine ok={picked.checks.prefixOk}>
              {picked.checks.prefixOk
                ? t('extstore.publish.upload.check.prefixOk', { name: publisherName })
                : t('extstore.publish.upload.check.prefixBad', { name: publisherName })}
            </CheckLine>
            <CheckLine ok={picked.checks.versionNewer}>
              {picked.checks.versionNewer
                ? t('extstore.publish.upload.check.versionOk', { version: picked.version })
                : t('extstore.publish.upload.check.versionBad', { version: picked.version })}
            </CheckLine>
          </ul>
          <h5 className="mb-1 text-label font-medium text-fg-muted">{t('extstore.publish.upload.contents')}</h5>
          <div className="mb-3">
            <ContentsList rows={contentRows(picked.contributes, previous)} />
          </div>
          <div className="mb-3">
            <CheckReport report={picked.report} />
          </div>
        </>
      )}

      {cloudReport && (
        <div data-cloud-report className="mb-3 rounded-md border border-line p-2">
          <div className="mb-1 text-ui text-danger">{t('extstore.publish.upload.cloudFailed')}</div>
          <CheckReport report={cloudReport} />
        </div>
      )}

      <p data-version-rule className="mb-3 text-meta text-fg-faint">
        {t('extstore.publish.upload.versionRule')}
      </p>
      {picked?.report.incomplete && failed.length === 0 && (
        <p data-incomplete className="mb-3 text-meta text-warn">
          {t('extstore.publish.upload.incomplete')}
        </p>
      )}
      {uploading && (
        <p data-uploading className="mb-3 text-meta text-fg-muted">
          {t('extstore.publish.upload.checking')}
        </p>
      )}
      {shownError && (
        <p role="alert" className="mb-3 text-meta break-words text-danger">
          {shownError}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button disabled={uploading} onClick={onCancel}>
          {t('extstore.publish.upload.cancel')}
        </Button>
        <Button variant="primary" data-submit disabled={!submittable} onClick={() => picked && onSubmit(picked.token)}>
          {t('extstore.publish.upload.submit')}
        </Button>
      </div>
    </section>
  )
}
