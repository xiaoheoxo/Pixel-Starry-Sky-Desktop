import { useState } from 'react'
import { isPublisherName } from '@pixelsky/protocol'
import { Button } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'

/** 本机先查名字规则；不合规时的提示（和云端 bad_publisher_name 同一句） */
export function nameProblem(name: string): string | null {
  return isPublisherName(name) ? null : tr('errors.extstore.api.badPublisherName')
}

/** 注册发布者：name_taken / reserved_name 等云端错误由 onRegister 抛出，写在输入框下 */
export function RegisterPanel({
  onRegister,
  initialError = null,
}: {
  onRegister(name: string): Promise<unknown>
  initialError?: string | null
}) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(initialError)
  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    const problem = nameProblem(trimmed)
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    try {
      await onRegister(trimmed)
    } catch (e) {
      setError(translateMessage((e as Error)?.message ?? String(e)))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section data-register className="max-w-md rounded-lg border border-line p-4">
      <h4 className="text-list font-medium text-fg">{t('extstore.publish.register.title')}</h4>
      <p className="mt-1 mb-3 text-meta text-fg-muted">{t('extstore.publish.register.hint')}</p>
      <div className="flex gap-2">
        <input
          value={name}
          disabled={busy}
          placeholder={t('extstore.publish.register.placeholder')}
          onChange={e => {
            setName(e.target.value)
            setError(null)
          }}
          onKeyDown={e => e.key === 'Enter' && void submit()}
          className="no-drag h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-ui text-fg outline-none placeholder:text-fg-faint focus:border-line-strong"
        />
        <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
          {t('extstore.publish.register.submit')}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-meta text-danger">
          {error}
        </p>
      )}
    </section>
  )
}
