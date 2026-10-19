import { useMemo, useState } from 'react'
import type { ExtPackInfo, ExtStoreUpdates } from '@pixelsky/protocol'
import { Button, cn } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { useI18n } from '@/i18n/I18nProvider'
import { packTitle } from '@/features/settings/extensions/model'
import { InstalledRow } from './InstalledRow'
import {
  INSTALLED_KINDS,
  blocklistLine,
  filterInstalled,
  installedCounts,
  sortInstalled,
  updateCandidates,
  type InstalledCategory,
  type InstalledFilter,
} from './installedModel'

export interface InstalledTabProps {
  /** 全部扩展（含内置、商店、文件夹）；这里自己排序和筛选 */
  packs: ExtPackInfo[]
  /** extstore.state().updates（checkUpdates 的结果也并进来） */
  updates: ExtStoreUpdates
  /** 当前连的站点（extstore.state().site）；null = 还不知道，不判断「别的站点」 */
  site: string | null
  /** extstore.state().blocklistAt */
  blocklistAt: string | null
  /** 当前时间（毫秒）；测试传假的 */
  now: number
  checking: boolean
  /** 正在装（更新 / 换回）的扩展 id：extstore.state().installing 的键 */
  installingIds: ReadonlySet<string>
  /** 有操作在跑（全部更新、开关、卸载）：禁用按钮 */
  busy: boolean
  /** 全部更新结束后的汇总「更新了 N 个，M 个失败」；没有就不显示 */
  summary: string | null
  /** 切换 / 卸载失败等错误文字 */
  error: string | null
  onOpen(key: string): void
  onToggle(key: string, enabled: boolean): void
  onCheckUpdates(): void
  /** 参数就是 updateCandidates 的结果；接线处用 runUpdateAll 逐个装 */
  onUpdateAll(candidates: ExtPackInfo[]): void
  onUpdate(pack: ExtPackInfo): void
  onRollback(pack: ExtPackInfo, version: string): void
  /** 确认框点了「卸载」之后（商店和文件夹的都走 extpacks:remove） */
  onUninstall(pack: ExtPackInfo): void
}

export function InstalledTab(p: InstalledTabProps) {
  const { locale, t } = useI18n()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<InstalledFilter>('all')
  const [category, setCategory] = useState<InstalledCategory>('all')
  const [confirm, setConfirm] = useState<ExtPackInfo | null>(null)

  const sorted = useMemo(() => sortInstalled(p.packs), [p.packs])
  const q = { query, filter, category, updates: p.updates, site: p.site, locale }
  const shown = filterInstalled(sorted, q)
  const counts = installedCounts(sorted, q)
  const candidates = updateCandidates(sorted, p.updates, p.site)
  const blocklist = blocklistLine(p.blocklistAt, p.now)

  const filters: Array<[InstalledFilter, string]> = [
    ['all', t('extstore.installed.filter.all')],
    ['updates', t('extstore.installed.filter.updates', { n: counts.updates })],
    ['disabled', t('extstore.installed.filter.disabled', { n: counts.disabled })],
  ]
  const categories: Array<[InstalledCategory, string, number]> = [
    ['all', t('extstore.installed.category.all'), counts.all],
    ...INSTALLED_KINDS.map(
      k => [k, t(`extstore.installed.category.${k}`), counts.kinds[k]] as [InstalledCategory, string, number],
    ),
  ]

  return (
    <div data-installed-tab className="flex gap-4">
      <div className="min-w-0 flex-1">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('extstore.installed.search')}
            aria-label={t('extstore.installed.search')}
            className="no-drag h-8 min-w-40 flex-1 rounded-md border border-line bg-surface px-2.5 text-ui text-fg"
          />
          <div
            role="radiogroup"
            aria-label={t('extstore.installed.filter')}
            className="inline-flex rounded-lg bg-subtle p-0.5"
          >
            {filters.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={filter === value}
                onClick={() => setFilter(value)}
                className={cn(
                  'press no-drag h-7 rounded-md px-2.5 text-ui',
                  filter === value ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <Button disabled={p.checking || p.busy} onClick={p.onCheckUpdates}>
            {p.checking ? t('extstore.installed.checking') : t('extstore.installed.checkUpdates')}
          </Button>
          {candidates.length > 0 && (
            <Button disabled={p.busy} onClick={() => p.onUpdateAll(candidates)}>
              {t('extstore.installed.updateAll')}
            </Button>
          )}
        </div>
        {blocklist && (
          <p
            data-blocklist-line
            className={cn('mb-2 text-meta', blocklist.kind === 'stale' ? 'text-warn' : 'text-fg-faint')}
          >
            {blocklist.kind === 'stale'
              ? t('extstore.installed.blocklist.stale')
              : t('extstore.installed.blocklist.at', { at: blocklist.at })}
          </p>
        )}
        {p.summary && <p className="mb-2 text-ui text-fg-muted">{p.summary}</p>}
        {p.error && <p className="mb-2 text-ui text-danger">{p.error}</p>}
        {shown.length ? (
          <ul className="divide-y divide-line-subtle rounded-lg border border-line">
            {shown.map(pack => (
              <InstalledRow
                key={pack.key}
                pack={pack}
                update={pack.id ? p.updates[pack.id] : undefined}
                site={p.site}
                installing={!!pack.id && p.installingIds.has(pack.id)}
                busy={p.busy}
                onOpen={p.onOpen}
                onToggle={p.onToggle}
                onUpdate={p.onUpdate}
                onRollback={p.onRollback}
                onUninstall={setConfirm}
              />
            ))}
          </ul>
        ) : (
          <p className="py-6 text-center text-ui text-fg-faint">{t('extstore.installed.empty')}</p>
        )}
      </div>
      <nav aria-label={t('extstore.installed.categories')} className="w-40 shrink-0">
        <ul className="space-y-0.5">
          {categories.map(([value, label, n]) => (
            <li key={value}>
              <button
                type="button"
                aria-current={category === value || undefined}
                onClick={() => setCategory(value)}
                className={cn(
                  'press no-drag flex h-8 w-full items-center justify-between rounded-md px-2.5 text-ui',
                  category === value ? 'bg-selected text-fg' : 'text-fg-muted hover:bg-hover',
                )}
              >
                <span>{label}</span>
                <span className="text-meta text-fg-faint">{n}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      {confirm && (
        <ConfirmDialog
          title={t('extstore.installed.uninstallTitle', { name: packTitle(confirm, locale) })}
          description={t('extstore.installed.uninstallConfirm')}
          confirmLabel={t('extstore.installed.uninstallYes')}
          cancelLabel={t('extstore.installed.uninstallNo')}
          busy={p.busy}
          danger
          onConfirm={() => {
            const target = confirm
            setConfirm(null)
            p.onUninstall(target)
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}
