import { tr } from '@/i18n/core'

/** Uncertain delivery must be checked by the user, never automatically resent. */
export function DotDeliveryNotice({
  text,
  web,
  busy,
  onResolve,
}: {
  text: string
  web: string
  busy: boolean
  onResolve: () => void
}) {
  return (
    <div role="alert" className="mb-2 space-y-2 text-meta text-warn">
      <p>{tr('dot.uncertainDelivery')}</p>
      {text && <p className="max-h-24 overflow-auto whitespace-pre-wrap">{text}</p>}
      <div className="flex gap-3">
        <a href={web} target="_blank" rel="noreferrer" className="underline">
          {tr('dot.openWeb')}
        </a>
        <button type="button" className="underline" disabled={busy} onClick={onResolve}>
          {tr('dot.resolveDelivery')}
        </button>
      </div>
    </div>
  )
}
