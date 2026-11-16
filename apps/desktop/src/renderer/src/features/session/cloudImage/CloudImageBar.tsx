// 云端生图（docs/ui/image-gen.md §6）：输入框上方的一行选项。打开时发送走生图，不发给 AI
import { ImageIcon, X } from 'lucide-react'
import { tr } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { cn } from '@/ui'
import { needsBalance, type PlatformGroup } from '@/features/account/platform'
import { formatBalance } from '@/features/account/format'
import {
  CLOUD_IMAGE_COUNTS,
  CLOUD_IMAGE_QUALITIES,
  CLOUD_IMAGE_SIZES,
  estimateCost,
  formatUsd,
  imageTier,
  type CloudImageCount,
  type CloudImageQuality,
  type CloudImageSize,
} from '../../../../../shared/cloudImage'

export interface CloudImageOptions {
  groupId: string
  size: CloudImageSize
  n: CloudImageCount
  quality: CloudImageQuality
}

const KEY = 'pixelsky.cloudImage.options.v1'

/** 能生图的分组：云端给了 images 接口的（管理员勾了「生图」） */
export const imageGroups = (groups: readonly PlatformGroup[]): PlatformGroup[] =>
  groups.filter(g => g.supported_apis?.includes('images'))

/** 上次用的选项；分组不在了换成第一个 */
export function initialOptions(groups: readonly PlatformGroup[]): CloudImageOptions | null {
  if (!groups.length) return null
  let saved: Partial<CloudImageOptions> = {}
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<CloudImageOptions>
  } catch {
    /* 第一次用 */
  }
  return {
    groupId: groups.some(g => g.id === saved.groupId) ? saved.groupId! : groups[0].id,
    size: CLOUD_IMAGE_SIZES.includes(saved.size as CloudImageSize) ? saved.size! : '1024x1024',
    n: CLOUD_IMAGE_COUNTS.includes(saved.n as CloudImageCount) ? saved.n! : 1,
    quality: CLOUD_IMAGE_QUALITIES.includes(saved.quality as CloudImageQuality) ? saved.quality! : 'medium',
  }
}

export function saveOptions(options: CloudImageOptions): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(options))
  } catch {
    /* 存不下就算了 */
  }
}

/** 这次估计扣多少、够不够：subscription（订阅额度）的分组不看余额 */
export function costCheck(
  group: PlatformGroup | undefined,
  options: CloudImageOptions,
  references: number,
  balance: number | null,
  currency: string,
): { cost: number | null; short: boolean } {
  const n = references ? 1 : options.n
  const cost = group ? estimateCost(group.image_prices, group.rate_multiplier, options.size, n) : null
  const usd = !currency || currency.toUpperCase() === 'USD'
  const short = !!group && needsBalance(group) && usd && balance !== null && cost !== null && cost > balance
  return { cost, short }
}

const SIZE_LABEL: Record<CloudImageSize, string> = {
  '1024x1024': '1:1 · 1K',
  '1536x1024': '3:2 · 2K',
  '1024x1536': '2:3 · 2K',
  '2048x2048': '1:1 · 2K',
  '2048x1152': '16:9 · 2K',
  '3840x2160': '16:9 · 4K',
  '2160x3840': '9:16 · 4K',
}

const field =
  'h-7 rounded-md border border-line bg-surface px-2 text-meta text-fg-secondary outline-none focus-visible:border-line-strong'

export function CloudImageBar({
  groups,
  options,
  onChange,
  onClose,
  references,
  balance,
  currency,
  onTopUp,
}: {
  groups: PlatformGroup[]
  options: CloudImageOptions
  onChange: (next: CloudImageOptions) => void
  onClose: () => void
  /** 输入框里的图片附件张数：有就是按参考图改（一次一张） */
  references: number
  balance: number | null
  currency: string
  onTopUp: () => void
}) {
  useI18n()
  const group = groups.find(g => g.id === options.groupId)
  const { cost, short } = costCheck(group, options, references, balance, currency)
  const set = (patch: Partial<CloudImageOptions>): void => {
    const next = { ...options, ...patch }
    saveOptions(next)
    onChange(next)
  }
  const unit = group?.image_prices?.[imageTier(options.size)] ?? 0
  return (
    <div
      data-cloud-image-bar
      className="mb-1.5 flex flex-wrap items-center gap-1.5 rounded-md bg-subtle px-2 py-1.5 text-meta text-fg-secondary"
    >
      <span className="inline-flex items-center gap-1 font-medium text-accent-fg">
        <ImageIcon size={14} strokeWidth={1.6} />
        {references ? tr('cloudImage.edit') : tr('cloudImage.title')}
      </span>
      {groups.length > 1 && (
        <select
          aria-label={tr('cloudImage.group')}
          className={field}
          value={options.groupId}
          onChange={e => set({ groupId: e.target.value })}
        >
          {groups.map(g => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      )}
      <select
        aria-label={tr('cloudImage.size')}
        className={field}
        value={options.size}
        onChange={e => set({ size: e.target.value as CloudImageSize })}
      >
        {CLOUD_IMAGE_SIZES.map(size => (
          <option key={size} value={size}>
            {SIZE_LABEL[size]}
          </option>
        ))}
      </select>
      <span
        role="group"
        aria-label={tr('cloudImage.count')}
        className="inline-flex overflow-hidden rounded-md border border-line"
      >
        {CLOUD_IMAGE_COUNTS.map(n => {
          const disabled = references > 0 && n !== 1
          const on = (references ? 1 : options.n) === n
          return (
            <button
              key={n}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              title={disabled ? tr('cloudImage.editOne') : undefined}
              onClick={() => set({ n })}
              className={cn(
                'h-7 px-2 text-meta',
                on ? 'bg-accent-soft text-accent-fg' : 'text-fg-secondary hover:bg-hover',
                disabled && 'cursor-not-allowed text-fg-faint hover:bg-transparent',
              )}
            >
              {tr('cloudImage.n', { n })}
            </button>
          )
        })}
      </span>
      <select
        aria-label={tr('cloudImage.quality')}
        className={field}
        value={options.quality}
        onChange={e => set({ quality: e.target.value as CloudImageQuality })}
      >
        {CLOUD_IMAGE_QUALITIES.map(q => (
          <option key={q} value={q}>
            {tr(`cloudImage.quality.${q}`)}
          </option>
        ))}
      </select>
      <span className="ml-auto inline-flex items-center gap-2">
        <span
          title={
            unit > 0 ? tr('cloudImage.unit', { price: formatUsd(unit), rate: group?.rate_multiplier ?? 1 }) : undefined
          }
        >
          {cost !== null ? tr('cloudImage.estimate', { cost: formatUsd(cost) }) : tr('cloudImage.noEstimate')}
        </span>
        {group && needsBalance(group) && balance !== null && (
          <span className={short ? 'text-warn' : 'text-fg-faint'}>
            {tr(short ? 'cloudImage.short' : 'cloudImage.balance', { balance: formatBalance(balance, currency) })}
          </span>
        )}
        {short && (
          <button type="button" onClick={onTopUp} className="rounded-md px-1.5 py-0.5 text-accent-fg hover:bg-hover">
            {tr('cloudImage.topUp')}
          </button>
        )}
        <button
          type="button"
          aria-label={tr('cloudImage.close')}
          title={tr('cloudImage.close')}
          onClick={onClose}
          className="inline-flex size-6 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
        >
          <X size={13} />
        </button>
      </span>
    </div>
  )
}
