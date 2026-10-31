// 设置 › 存储 › 项目副本：按大小列出每个工作树副本，标出有未提交改动的和目录已经不在的。删除在右侧面板里做。
import { cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import type { StorageCopy } from '../../../../shared/types/storage'
import { formatBytes } from './storageView'

export function CopiesList({ copies }: { copies: readonly StorageCopy[] }) {
  const { t } = useI18n()
  return (
    <div className="mt-3 border-t border-line-subtle pt-2">
      {copies.length === 0 ? (
        <p className="py-2 text-meta text-fg-faint">{t('storage.emptyCopies')}</p>
      ) : (
        [...copies]
          .sort((a, b) => b.bytes - a.bytes)
          .map(c => (
            <div key={c.id} className="flex items-center gap-3 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-list text-fg">
                  {c.name}
                  <span className="ml-2 font-mono text-meta text-fg-faint">{c.branch}</span>
                </div>
                <div className="truncate font-mono text-meta text-fg-faint" title={c.path}>
                  {c.projectName ? `${c.projectName} · ` : ''}
                  {c.path}
                </div>
              </div>
              {(c.missing || c.dirty) && (
                <span className={cn('shrink-0 text-meta', c.missing ? 'text-fg-faint' : 'text-warn')}>
                  {t(c.missing ? 'storage.copyMissing' : 'storage.copyDirty')}
                </span>
              )}
              <span className="w-20 shrink-0 text-right text-meta text-fg-muted tabular-nums">
                {formatBytes(c.bytes)}
              </span>
            </div>
          ))
      )}
    </div>
  )
}
