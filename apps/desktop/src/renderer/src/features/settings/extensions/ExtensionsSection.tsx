import { useEffect } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { usePackState } from '@/features/extpacks/store'
import { openExtTab, trackExtPage, useExtDetail, useExtTab } from '@/features/extstore/nav'
import { StoreDetailPage } from '@/features/extstore/detail/StoreDetailPage'
import { PublishPage } from '@/features/extstore/publish/PublishPage'
import { touchExtStore } from '@/features/extstore/store'
import { SectionTitle } from '../SettingRow'
import { DiscoverTab } from './DiscoverTab'
import { ExtTabs } from './ExtTabs'
import { InstalledPage } from './InstalledPage'
import type { PackGroup } from './model'

/** 设置 › 扩展：顶上「发现 | 已安装 N | 我的发布」三个页签；旧入口进来停在「已安装」 */
export function ExtensionsSection({ initialGroup }: { initialGroup?: PackGroup }) {
  const { t } = useI18n()
  const tab = useExtTab()
  const detail = useExtDetail()
  const installedCount = usePackState().packs.length

  // 打开扩展页：让主进程读一次停用名单，超过 10 分钟没查过更新就查一次；关掉设置后页签放回「已安装」
  useEffect(() => {
    touchExtStore()
    return trackExtPage()
  }, [])

  return (
    <section data-setting-title={tr('extensions.title')}>
      <SectionTitle>{tr('extensions.title')}</SectionTitle>
      <p className="mb-4 text-meta text-fg-muted">{t('extensions.description')}</p>
      <ExtTabs value={tab} onChange={openExtTab} installedCount={installedCount} />
      {tab === 'discover' ? (
        detail ? (
          <StoreDetailPage key={detail} id={detail} />
        ) : (
          <DiscoverTab />
        )
      ) : tab === 'publish' ? (
        <PublishPage />
      ) : (
        <InstalledPage initialGroup={initialGroup} />
      )}
    </section>
  )
}
