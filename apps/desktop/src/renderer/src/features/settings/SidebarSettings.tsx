import { Switch } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { setSidebarPrefs, useSidebarPrefs } from '@/features/appearance/sidebar'
import { GroupTitle, SettingRow } from './SettingRow'
import { SidebarLayoutEditor } from './SidebarLayoutEditor'

/** 设置 → 外观 → 侧边栏；预览和真实侧栏共用当前偏好及图标映射。换图标在图标位置里右键。 */
export function SidebarSettings() {
  useI18n()
  const prefs = useSidebarPrefs()
  return (
    <>
      <GroupTitle>{tr('sidebar.settings.title')}</GroupTitle>
      <SettingRow
        title={tr('sidebar.settings.showRecent')}
        description={tr('sidebar.settings.showRecentDescription')}
        control={
          <Switch
            checked={prefs.showRecent}
            label={tr('sidebar.settings.showRecent')}
            onChange={showRecent => setSidebarPrefs({ showRecent })}
          />
        }
      />
      <SettingRow title={tr('sidebar.layout.title')} description={tr('sidebar.layout.description')}>
        <SidebarLayoutEditor />
      </SettingRow>
    </>
  )
}
