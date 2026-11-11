// 设置 › 模型通道 › 像素星空平台：扣费用的 Key（docs/ui/platform-key-mode.md §4）。
// 一行分段按钮「自动 | 我的 Key」，下面只写当前选中的那种怎么扣；线路行右边的标签显示这条线路当前扣的 Key。
import { Info, KeyRound, Monitor } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../../i18n/core'
import { Segmented, cn } from '@/ui'
import { setKeyMode, useKeyMode } from '@/features/account/keyMode'
import type { PlatformGroupKey, PlatformKeyMode } from '../../../../../shared/types/platform-catalog'

export function KeyModeRow() {
  useI18n()
  const { mode, saving, error } = useKeyMode()
  return (
    <div data-setting-title={tr('platformKey.title')} className="mt-3 mb-4 rounded-md border-b border-line-subtle pb-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-ui font-medium text-fg">{tr('platformKey.title')}</div>
          <p className="mt-1 text-meta text-fg-muted">{tr('platformKey.desc')}</p>
        </div>
        <Segmented<PlatformKeyMode>
          label={tr('platformKey.title')}
          value={mode}
          disabled={saving}
          onChange={next => void setKeyMode(next)}
          options={[
            { value: 'auto', label: tr('platformKey.auto') },
            { value: 'own', label: tr('platformKey.own') },
          ]}
        />
      </div>
      <p className="mt-3 flex items-start gap-2 rounded-lg bg-subtle px-3 py-2 text-meta text-fg-secondary">
        <Info size={14} strokeWidth={1.75} className="mt-px shrink-0 text-fg-muted" />
        <span>{tr(mode === 'own' ? 'platformKey.ownHint' : 'platformKey.autoHint')}</span>
      </p>
      {error && <p className="mt-2 text-meta text-danger">{translateMessage(error)}</p>}
    </div>
  )
}

/**
 * 线路行右边的 Key 标签：自己的 Key 用强调色；客户端专用的灰色，选了「我的 Key」却退回用它时虚线框。
 * 云端没给（旧云端）时不显示
 */
export function KeyChip({ value, mode }: { value: PlatformGroupKey | null | undefined; mode: PlatformKeyMode }) {
  useI18n()
  if (!value) return null
  const fallback = mode === 'own' && !value.own
  const title = value.own
    ? tr('platformKey.ownTitle', { name: value.name })
    : tr(fallback ? 'platformKey.fallbackTitle' : 'platformKey.appTitle', { name: value.name })
  const Icon = value.own ? KeyRound : Monitor
  return (
    <span
      data-key-chip={value.own ? 'own' : fallback ? 'fallback' : 'app'}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex h-[22px] max-w-[200px] shrink-0 items-center gap-1 rounded-full px-2 text-meta',
        value.own
          ? 'bg-accent-soft text-accent'
          : fallback
            ? 'border border-dashed border-line text-fg-muted'
            : 'bg-subtle text-fg-secondary',
      )}
    >
      <Icon size={12} strokeWidth={1.75} className="shrink-0" />
      <span className="truncate">{value.own ? value.name : tr('platformKey.app')}</span>
    </span>
  )
}

/** 「我的 Key」模式下线路列表下面的图例 */
export function KeyLegend({ mode }: { mode: PlatformKeyMode }) {
  useI18n()
  if (mode !== 'own') return null
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-meta text-fg-muted">
      <span className="inline-flex items-center gap-1.5">
        <i className="size-2 rounded-full bg-accent" />
        {tr('platformKey.legendOwn')}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <i className={cn('size-2 rounded-full border border-dashed border-fg-faint')} />
        {tr('platformKey.legendFallback')}
      </span>
    </div>
  )
}
