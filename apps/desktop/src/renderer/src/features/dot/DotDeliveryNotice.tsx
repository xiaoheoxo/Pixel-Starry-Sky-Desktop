import { ExternalLink, TriangleAlert } from 'lucide-react'
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
    <div role="alert" className="dot-note mb-2 flex-wrap" data-level="warn">
      <TriangleAlert size={14} className="dot-note-icon" />
      <div className="min-w-0 flex-1 basis-64 space-y-1">
        <p>{tr('dot.uncertainDelivery')}</p>
        {text && <p className="max-h-24 overflow-auto whitespace-pre-wrap text-fg-muted">{text}</p>}
      </div>
      <a href={web} target="_blank" rel="noreferrer" className="dot-web-link">
        {tr('dot.openWeb')}
        <ExternalLink size={12} />
      </a>
      <button type="button" className="dot-small-button" disabled={busy} onClick={onResolve}>
        {tr('dot.resolveDelivery')}
      </button>
    </div>
  )
}
