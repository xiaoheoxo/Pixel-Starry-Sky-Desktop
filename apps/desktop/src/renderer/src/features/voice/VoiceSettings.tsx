// 设置 › AI 辅助 › 语音输入（docs/ui/voice-input.md §10）：识别用的地址、Key、调用方式（单独填，不跟模型通道关联），模型和语言
import { useEffect, useState } from 'react'
import { Segmented } from '@/ui'
import { useUnmountFlush } from '@/ui/useUnmountFlush'
import { useI18n } from '@/i18n/I18nProvider'
import { SettingRow } from '@/features/settings/SettingRow'
import type { VoiceMode } from '../../../../shared/types/voice'
import { setVoiceSettings, useVoiceSettings, type VoiceLanguage } from './model'
import { saveVoiceConfig, useVoiceConfig } from './voiceConfig'

const INPUT =
  'h-8 min-w-40 flex-1 rounded-md border border-line bg-subtle px-2 font-mono text-meta text-fg outline-none placeholder:text-fg-faint focus:border-line-strong'

export function VoiceSettings() {
  const { t } = useI18n()
  const settings = useVoiceSettings()
  const config = useVoiceConfig()
  // 边打边存的话，删空的一瞬间会被换回默认值（地址删空会清掉 Key）：离开输入框再存
  const [model, setModel] = useState(settings.model)
  useEffect(() => setModel(settings.model), [settings.model])
  const [baseUrl, setBaseUrl] = useState(config.baseUrl)
  useEffect(() => setBaseUrl(config.baseUrl), [config.baseUrl])
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState('')
  const [mode, setMode] = useState(config.mode)
  useEffect(() => setMode(config.mode), [config.mode])
  const saveEndpoint = (next: VoiceMode = mode): void => {
    // 地址还没填：先不存（空地址等于删掉设置，会把刚填的 Key、刚选的方式一起清掉），等填了地址一起存
    if (!baseUrl.trim() && !config.baseUrl) return
    if (baseUrl.trim() === config.baseUrl && !apiKey.trim() && next === config.mode) return
    saveVoiceConfig({ baseUrl, mode: next, apiKey })
      .then(() => {
        setApiKey('')
        setError('')
      })
      .catch((e: Error) => setError(e.message))
  }
  const save = (): void => {
    unsaved.current = false
    if (model !== settings.model) setVoiceSettings({ model })
    saveEndpoint()
  }
  // 改完没点别处就关掉设置（Esc、切到别的分区）时不一定有失焦：卸载时补存一次
  const unsaved = useUnmountFlush(save)
  const typing = <T,>(set: (value: T) => void) => {
    return (value: T): void => {
      unsaved.current = true
      set(value)
    }
  }

  return (
    <SettingRow
      title={t('voice.settings.title')}
      description={t('voice.settings.description')}
      hint={error || (config.persistent ? undefined : t('voice.settings.unsaved'))}
      hintTone={error ? 'danger' : 'muted'}
    >
      <div data-voice-settings className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label={t('voice.settings.baseUrl')}
            placeholder={t('voice.settings.baseUrl')}
            value={baseUrl}
            spellCheck={false}
            maxLength={500}
            onChange={event => typing(setBaseUrl)(event.target.value)}
            onBlur={save}
            className={INPUT}
          />
          <input
            type="password"
            autoComplete="off"
            aria-label={t('voice.settings.apiKey')}
            placeholder={
              config.keyHint ? t('voice.settings.apiKeySaved', { hint: config.keyHint }) : t('voice.settings.apiKey')
            }
            value={apiKey}
            maxLength={500}
            onChange={event => typing(setApiKey)(event.target.value)}
            onBlur={save}
            className={INPUT}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<VoiceMode>
            label={t('voice.settings.mode')}
            value={mode}
            onChange={next => {
              setMode(next)
              saveEndpoint(next)
            }}
            options={[
              { value: 'file', label: t('voice.settings.modeFile') },
              { value: 'chat', label: t('voice.settings.modeChat') },
            ]}
          />
          <input
            aria-label={t('voice.settings.model')}
            title={t('voice.settings.model')}
            placeholder={t('voice.settings.model')}
            value={model}
            spellCheck={false}
            maxLength={200}
            onChange={event => typing(setModel)(event.target.value)}
            onBlur={save}
            className={INPUT}
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
      </div>
    </SettingRow>
  )
}
