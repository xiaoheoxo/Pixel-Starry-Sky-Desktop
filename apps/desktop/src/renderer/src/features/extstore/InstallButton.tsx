import { X } from 'lucide-react'
import { Button } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import type { CardAction } from './storeModel'

/** 安装按钮：安装 / 已安装 / 更新 / 下载中 N% + 取消 / 校验中 / 安装中 / 无法更新（方案 §2.3）；卡片和详情页共用 */
export function InstallButton({
  id,
  version,
  action,
  onInstall,
  onCancel,
}: {
  id: string
  /** 「安装」时装哪个版本（商店里的最新版） */
  version: string
  action: CardAction
  onInstall(version: string): void
  onCancel(id: string): void
}) {
  const { t } = useI18n()
  const small = 'h-7 px-2.5 text-meta'
  switch (action.kind) {
    case 'install':
      return (
        <Button className={small} onClick={() => onInstall(version)}>
          {t('extstore.action.install')}
        </Button>
      )
    case 'installed':
      return (
        <span className="inline-flex h-6 shrink-0 items-center rounded-full border border-success/40 px-2.5 text-meta whitespace-nowrap text-success">
          {t('extstore.action.installed')}
        </span>
      )
    case 'update':
      return (
        <Button variant="primary" className={small} onClick={() => onInstall(action.version)}>
          {t('extstore.action.update')}
        </Button>
      )
    case 'updateBlocked':
      return (
        <span
          className="inline-flex h-6 shrink-0 items-center text-meta whitespace-nowrap text-fg-faint"
          title={action.need ? tr('extstore.action.updateBlocked', { version: action.need }) : undefined}
        >
          {t('extstore.action.updateBlockedShort')}
        </span>
      )
    case 'installing': {
      const downloading = action.phase === 'downloading'
      return (
        <span
          aria-busy="true"
          className="inline-flex shrink-0 items-center gap-1 text-meta whitespace-nowrap text-fg-muted"
        >
          {downloading
            ? action.percent === null
              ? t('extstore.action.downloadingNoPercent')
              : t('extstore.action.downloading', { percent: action.percent })
            : action.phase === 'verifying'
              ? t('extstore.action.verifying')
              : t('extstore.action.installing')}
          {/* 只有下载能取消；校验和安装已经在落盘 */}
          {downloading && (
            <button
              type="button"
              aria-label={t('extstore.action.cancel')}
              title={t('extstore.action.cancel')}
              onClick={() => onCancel(id)}
              className="press no-drag inline-flex size-5 items-center justify-center rounded hover:bg-hover hover:text-fg"
            >
              <X size={12} strokeWidth={1.75} />
            </button>
          )}
        </span>
      )
    }
  }
}
