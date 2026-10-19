import { useState } from 'react'
import type { ExtPackInfo } from '@pixelsky/protocol'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { packAssetUrl } from '@/features/extpacks/store'
import { packTitle } from './model'
import { PackBadge } from './PackBadge'

/**
 * 扩展图标：清单里的 icon，没有就用名字首字母。
 * 商店目录里的扩展还没装、没有 pack，传 src（pixelsky-ext://store-icon/…）和 name；图片加载失败也退回首字母
 */
export function PackIcon({
  pack,
  size = 32,
  src,
  name,
}: {
  pack?: ExtPackInfo
  size?: number
  src?: string
  name?: string
}) {
  const { locale } = useI18n()
  const [failed, setFailed] = useState<string | null>(null)
  const icon = pack?.manifest?.icon
  const style = { width: size, height: size }
  const url = src ?? (pack && icon && pack.status !== 'error' ? packAssetUrl(pack.key, icon) : undefined)
  if (url && failed !== url) {
    return (
      <img
        src={url}
        alt=""
        draggable={false}
        className="shrink-0 rounded-md"
        style={style}
        onError={() => setFailed(url)}
      />
    )
  }
  const title = name ?? (pack ? packTitle(pack, locale) : '')
  return (
    <span
      aria-hidden
      style={style}
      className="flex shrink-0 items-center justify-center rounded-md bg-avatar text-ui font-medium text-avatar-fg"
    >
      {/* 跳过开头的符号：「.env 文件支持」显示 E 而不是「.」 */}
      {(title.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()}
    </span>
  )
}

export function PackStatus({ pack }: { pack: ExtPackInfo }) {
  const { t } = useI18n()
  if (pack.status === 'error') return <PackBadge tone="danger">{t('extensions.status.error')}</PackBadge>
  if (pack.status === 'warning') {
    const n = pack.issues.filter(i => i.severity === 'warning').length
    return <PackBadge tone="warn">{tr('extensions.status.warnings', { n })}</PackBadge>
  }
  return null
}
