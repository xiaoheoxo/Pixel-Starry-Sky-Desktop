// 设置 › 通用（docs/ui/settings-reorg.md §4）：语言、关窗口、睡眠、更新的两个开关。打开设置默认停在这一页
import { Segmented, Switch } from '@/ui'
import { tr } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { LOCALE_OPTIONS, type Locale } from '../../../../shared/i18n/messages'
import { updateActions, useUpdateState } from '@/features/update/store'
import { useWhatsNew, whatsNewActions } from '@/features/update/whatsNew'
import { CloseActionSettings } from './CloseActionSettings'
import { KeepAwakeSettings } from './KeepAwakeSettings'
import { GroupTitle, SectionTitle, SettingRow, Toggle } from './SettingRow'

export function GeneralSection() {
  const { locale, setLocale, t } = useI18n()
  const update = useUpdateState()
  const { muted } = useWhatsNew()
  return (
    <section>
      <SectionTitle>{tr('settingsNav.general')}</SectionTitle>
      <SettingRow
        title={tr('settings.SettingsDialog.interfaceLanguage')}
        description={tr('settings.SettingsDialog.chooseLanguageUsedBy')}
      >
        <Segmented
          label={t('settings.SettingsDialog.interfaceLanguage')}
          options={LOCALE_OPTIONS}
          value={locale}
          onChange={value => setLocale(value as Locale)}
        />
      </SettingRow>
      <CloseActionSettings />
      <KeepAwakeSettings />

      <GroupTitle>{tr('update.group')}</GroupTitle>
      <SettingRow
        title={tr('whatsNew.setting')}
        description={tr('whatsNew.settingHint')}
        control={
          <Toggle label={tr('whatsNew.setting')} checked={!muted} onChange={on => whatsNewActions.setMuted(!on)} />
        }
      />
      {update && (
        <SettingRow
          title={tr('update.beta')}
          description={tr('update.betaHint')}
          control={
            <Switch
              checked={update.beta}
              disabled={update.status === 'unsupported'}
              label={tr('update.beta')}
              onChange={on => void updateActions.setBeta(on)}
            />
          }
        />
      )}
    </section>
  )
}
