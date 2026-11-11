// 设置 › AI 辅助 › 语音输入（docs/ui/voice-input.md）：用哪个自定义接口、哪个模型识别，说的是什么语言
import { useEffect, useState } from 'react'
import { Segmented, Select } from '@/ui'
import { useUnmountFlush } from '@/ui/useUnmountFlush'
import { useI18n } from '@/i18n/I18nProvider'
import { useProviders } from '@/features/account/providers'
import { SettingRow } from '@/features/settings/SettingRow'
import { setVoiceSettings, useVoiceSettings, voiceProviders, voiceTarget, type VoiceLanguage } from './model'

export function VoiceSettings() {
  const { t } = useI18n()
  const settings = useVoiceSettings()
  const { providers } = useProviders()
  const usable = voiceProviders(providers)
  const target = voiceTarget(providers, settings)
  // 模型名边打边存的话，删空的一瞬间会被换回默认值：离开输入框再存
  const [model, setModel] = useState(settings.model)
  useEffect(() => setModel(settings.model), [settings.model])
  const saveModel = (): void => {
    unsaved.current = false
    if (model !== settings.model) setVoiceSettings({ model })
  }
  // 改完没点别处就关掉设置（Esc、切到别的分区）时不一定有失焦：卸载时补存一次
  const unsaved = useUnmountFlush(saveModel)

  return (
    <SettingRow title={t('voice.settings.title')} description={t('voice.settings.description')}>
      {target ? (
        <div data-voice-settings className="flex flex-wrap items-center gap-2">
          <Select
            label={t('voice.settings.endpoint')}
            className="min-w-44 flex-1"
            value={target.id}
            onChange={providerId => setVoiceSettings({ providerId })}
            options={usable.map(p => ({ value: p.id, label: p.name }))}
          />
          <input
            aria-label={t('voice.settings.model')}
            title={t('voice.settings.model')}
            value={model}
            spellCheck={false}
            maxLength={200}
            onChange={event => {
              unsaved.current = true
              setModel(event.target.value)
            }}
            onBlur={saveModel}
            className="h-8 min-w-40 flex-1 rounded-md border border-line bg-subtle px-2 font-mono text-meta text-fg outline-none placeholder:text-fg-faint focus:border-line-strong"
          />
          <Segmented<VoiceLanguage>
            label={t('voice.settings.language')}
            value={settings.language}
            onChange={language => setVoiceSettings({ language })}
            options={[
              { value: 'auto', label: t('voice.settings.languageAuto') },
              { value: 'zh', label: t('voice.settings.languageZh') },
              { value: 'en', label: t('voice.settings.languageEn') },
            ]}
          />
        </div>
      ) : (
        <p className="text-meta text-fg-faint">{t('voice.settings.none')}</p>
      )}
    </SettingRow>
  )
}
