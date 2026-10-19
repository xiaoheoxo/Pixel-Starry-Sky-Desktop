import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { useI18n } from '@/i18n/I18nProvider'

/** 下架前确认：确认了才调 delist */
export function DelistConfirm({
  name,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  name: string
  busy: boolean
  error?: string | null
  onConfirm(): void
  onCancel(): void
}) {
  const { t } = useI18n()
  return (
    <ConfirmDialog
      title={t('extstore.publish.delist.title', { name })}
      description={t('extstore.publish.delist.body')}
      confirmLabel={t('extstore.publish.delist.confirm')}
      cancelLabel={t('extstore.publish.delist.cancel')}
      busy={busy}
      error={error}
      danger
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
