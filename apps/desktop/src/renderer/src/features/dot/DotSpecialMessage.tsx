import { Check, ClipboardList, ExternalLink, LockKeyhole, Monitor } from 'lucide-react'
import type { DotSpecialCard } from '@pixelsky/engine'
import { tr } from '@/i18n/core'

export function DotSpecialMessage({ card, web }: { card: DotSpecialCard; web: string }) {
  const title =
    card.kind === 'signIn'
      ? card.status === 'submitted'
        ? 'dot.card.signInSubmitted'
        : card.status === 'resolved'
          ? 'dot.card.signInResolved'
          : card.status === 'pending'
            ? 'dot.card.signInPending'
            : 'dot.card.signInUnknown'
      : card.kind === 'input'
        ? card.status === 'resolved'
          ? 'dot.card.inputResolved'
          : card.status === 'pending'
            ? 'dot.card.inputPending'
            : 'dot.card.inputUnknown'
        : card.kind === 'browserHandoff'
          ? 'dot.card.browserHandoff'
          : 'dot.card.browserActivity'
  const Icon = card.kind === 'signIn' ? LockKeyhole : card.kind === 'input' ? ClipboardList : Monitor
  return (
    <div className="my-1 inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line bg-subtle px-3 py-2 text-ui">
      <Icon size={15} className="shrink-0 text-accent" aria-hidden />
      <span className="min-w-0 font-medium">{tr(title)}</span>
      {card.kind === 'signIn' && card.status === 'submitted' && <Check size={14} aria-hidden />}
      <a className="dot-web-link" href={web} target="_blank" rel="noreferrer">
        {tr('dot.card.official')} <ExternalLink size={12} aria-hidden />
      </a>
    </div>
  )
}
