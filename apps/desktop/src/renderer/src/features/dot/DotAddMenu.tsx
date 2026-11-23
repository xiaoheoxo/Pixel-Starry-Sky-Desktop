import { ExternalLink, Link, Monitor, Paperclip } from 'lucide-react'
import { ActionMenu } from '@/ui/ActionMenu'
import { tr } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'

/** References are draft text, not a capability grant or a silent share. */
export function chatGptReference(input: string): string | null {
  try {
    const url = new URL(input.trim())
    if (url.origin !== 'https://chatgpt.com' || url.username || url.password || url.pathname === '/') return null
    return url.href
  } catch {
    return null
  }
}

export function DotAddMenu({
  x,
  y,
  web,
  onClose,
  onFiles,
  onComputer,
  onReference,
}: {
  x: number
  y: number
  web: string
  onClose(): void
  onFiles(): void
  onComputer(): void
  onReference(): void
}) {
  useI18n()
  return (
    <ActionMenu
      x={x}
      y={y}
      label={tr('dot.add')}
      onClose={onClose}
      actions={[
        { label: tr('dot.addFiles'), section: tr('dot.add'), icon: Paperclip, run: onFiles },
        { label: tr('dot.add.reference'), icon: Link, run: onReference },
        { label: tr('dot.computer'), icon: Monitor, run: onComputer },
        {
          label: tr('dot.add.native'),
          icon: ExternalLink,
          separator: true,
          run: () => window.open(web, '_blank', 'noopener,noreferrer'),
        },
      ]}
    />
  )
}
