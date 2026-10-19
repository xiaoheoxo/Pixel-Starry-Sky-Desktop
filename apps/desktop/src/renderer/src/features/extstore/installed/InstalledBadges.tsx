import type { ReactNode } from 'react'
import type { ExtPackSource } from '@pixelsky/protocol'
import { cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'

function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'warn'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded px-1.5 text-meta whitespace-nowrap',
        tone === 'warn' ? 'bg-subtle text-warn' : 'bg-subtle text-fg-muted',
      )}
    >
      {children}
    </span>
  )
}

/** 来源小标：商店（中性）、内置（中性）、开发中（黄色） */
export function SourceBadge({ source }: { source: ExtPackSource }) {
  const { t } = useI18n()
  if (source === 'folder') return <Badge tone="warn">{t('extstore.installed.badge.dev')}</Badge>
  return (
    <Badge>{source === 'store' ? t('extstore.installed.badge.store') : t('extstore.installed.badge.builtin')}</Badge>
  )
}

/** 「已被 <来源> 的同名扩展替代」 */
export function ShadowedMark({ by }: { by: ExtPackSource }) {
  const { t } = useI18n()
  return (
    <span data-shadowed>
      {t('extstore.installed.line.shadowed', { source: t(`extstore.installed.shadowSource.${by}`) })}
    </span>
  )
}
